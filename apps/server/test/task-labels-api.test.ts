import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeTaskLabelsRequest, routes, TaskDetail } from '@projectman/shared';
import { cookieOf, createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';

describe('task labels API', () => {
  let h: AppHarness;
  let owner: string;
  let qa: string;
  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    const { domain, repos } = h.app.projectman;
    repos.users.insert({
      id: 'qa-user',
      name: 'Tester',
      email: 'tester@acme.test',
      passwordHash: repos.users.findByEmail(OWNER_LOGIN.email)!.passwordHash,
      createdAt: new Date().toISOString(),
    });
    await domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER_LOGIN }, (draft) => {
      draft.team.members.push({
        kind: 'human',
        handle: 'tester',
        displayName: 'Tester',
        access: 'developer',
        roles: ['qa'],
        email: 'tester@acme.test',
      });
      const qaRule = { group: 'qa', setBy: { duties: ['testing_acceptance' as const] }, notByAuthor: true };
      draft.pipeline.labels.push(
        { id: 'qa-ok', name: 'QA ok', ...qaRule },
        { id: 'qa-failed', name: 'QA failed', ...qaRule, requiresComment: true },
        { id: 'client-ok', name: 'Client ok', setBy: { duties: ['testing_acceptance'] } },
      );
      draft.pipeline.stages.find((stage) => stage.id === 'merge')!.gate = {
        conditions: [{ type: 'has_label', label: 'qa-ok' }],
      };
      return 'Add a human QA holder and a QA gate';
    });
    qa = cookieOf(
      await h.app.inject({
        method: 'POST',
        url: routes.login(),
        payload: { email: 'tester@acme.test', password: OWNER_LOGIN.password },
      }),
    );
    await domain.tasks.create('AR', { title: 'Acme checkout', stageId: 'code_review' }, OWNER_ACTOR);
  });
  afterEach(async () => h.close());
  const change = (body: unknown, cookie = qa) =>
    h.app.inject({
      method: 'POST',
      url: routes.taskLabels('AR', 'AR-1'),
      headers: { cookie },
      payload: body as object,
    });

  it('lets a QA holder pass the gate with an attributed comment, and swaps labels of a group', async () => {
    expect(ChangeTaskLabelsRequest.parse({ add: ['qa-ok'] })).toEqual({ add: ['qa-ok'] });
    const move = () =>
      h.app.inject({
        method: 'PATCH',
        url: routes.task('AR', 'AR-1'),
        headers: { cookie: qa },
        payload: { stageId: 'merge' },
      });
    expect((await move()).json().error.code).toBe('gate_blocked');

    const failed = await change({ add: ['qa-failed'] });
    expect([failed.statusCode, failed.json().error.code]).toEqual([400, 'comment_required']);
    expect((await change({ add: ['qa-failed'], comment: 'Totals are wrong.' })).statusCode).toBe(200);

    const response = await change({ add: ['qa-ok'], comment: 'Acme checkout verified.' });
    expect(response.statusCode).toBe(200);
    const detail = TaskDetail.parse(response.json());
    expect(detail.task.labels).toEqual(['qa-ok']);
    expect(detail.timeline).toContainEqual(
      expect.objectContaining({
        type: 'task_labels_changed',
        actor: { kind: 'human', handle: 'tester' },
        data: { added: ['qa-ok'], removed: ['qa-failed'] },
      }),
    );
    expect(detail.timeline).toContainEqual(
      expect.objectContaining({
        type: 'task_note',
        actor: { kind: 'human', handle: 'tester' },
        data: { text: 'Acme checkout verified.', mentions: [] },
      }),
    );
    expect((await move()).statusCode).toBe(200);
  });

  it.each(['assignee', 'pr_author'] as const)(
    'refuses self-review by the %s without recording anything',
    async (kind) => {
      const { domain } = h.app.projectman;
      if (kind === 'assignee') domain.tasks.assign('AR', 'AR-1', 'tester', OWNER_ACTOR);
      else
        domain.tasks.addLink(
          'AR',
          'AR-1',
          { kind: 'pull_request', ref: '42', repo: 'acme/web', author: 'tester' },
          OWNER_ACTOR,
        );
      const response = await change({ add: ['qa-ok'], comment: 'Self review' });
      expect([response.statusCode, response.json().error.code]).toEqual([403, 'self_review_forbidden']);
      expect(domain.tasks.get('AR', 'AR-1').labels).toEqual([]);
      expect(
        domain.timeline.list('AR', { taskKey: 'AR-1' }).some((event) => event.type === 'task_note'),
      ).toBe(false);
      // A label without the self-review rule is fine.
      expect((await change({ add: ['client-ok'] })).statusCode).toBe(200);
    },
  );

  it('keeps approvals and system labels out of reach and plain tags open', async () => {
    for (const label of ['merge-ok', 'pr-merged']) {
      const response = await change({ add: [label] });
      expect([response.statusCode, response.json().error.code]).toEqual([403, 'label_not_allowed']);
    }
    const tag = await change({ add: ['checkout'] });
    expect(TaskDetail.parse(tag.json()).task.labels).toEqual(['checkout']);
    expect(TaskDetail.parse((await change({ remove: ['checkout'] })).json()).task.labels).toEqual([]);
  });

  it.each([{}, { add: 'qa-ok' }, { add: [] }, { add: ['qa-ok'], comment: 1 }, []])(
    'validates the request %j',
    async (body) => {
      const response = await change(body);
      expect([response.statusCode, response.json().error.code]).toEqual([400, 'invalid_request']);
    },
  );

  it.each(['viewer', 'client'] as const)('requires developer access for %s', async (access) => {
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: OWNER_ACTOR, author: OWNER_LOGIN },
      (draft) => {
        const tester = draft.team.members.find((member) => member.handle === 'tester');
        if (tester?.kind === 'human') tester.access = access;
        return 'Change tester access';
      },
    );
    const response = await change({ add: ['checkout'] });
    expect([response.statusCode, response.json().error.code]).toEqual([403, 'insufficient_access']);
    expect((await change({ add: ['checkout'] }, owner)).statusCode).toBe(200);
  });
});
