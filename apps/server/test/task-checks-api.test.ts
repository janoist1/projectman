import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes, SetTaskCheckRequest, TaskDetail } from '@projectman/shared';
import { cookieOf, createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';

describe('human task checks API', () => {
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
      draft.pipeline.stages.find((stage) => stage.id === 'merge')!.gate = {
        conditions: [{ type: 'check_passed', check: 'qa' }],
      };
      return 'Add human QA holder and QA gate';
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
  const check = (body: object, cookie = qa) =>
    h.app.inject({
      method: 'POST',
      url: routes.taskChecks('AR', 'AR-1'),
      headers: { cookie },
      payload: body,
    });

  it('adds a contract and lets a human QA holder pass the gate with an attributed note', async () => {
    expect(SetTaskCheckRequest.parse({ check: 'qa', state: 'passed' })).toEqual({
      check: 'qa',
      state: 'passed',
    });
    const move = () =>
      h.app.inject({
        method: 'PATCH',
        url: routes.task('AR', 'AR-1'),
        headers: { cookie: qa },
        payload: { stageId: 'merge' },
      });
    expect((await move()).json().error.code).toBe('gate_blocked');
    const response = await check({ check: 'qa', state: 'passed', note: 'Acme checkout verified.' });
    expect(response.statusCode).toBe(200);
    const detail = TaskDetail.parse(response.json());
    expect(detail.task.checks.qa).toBe('passed');
    expect(detail.timeline).toContainEqual(
      expect.objectContaining({
        type: 'task_check_changed',
        actor: { kind: 'human', handle: 'tester' },
        data: { check: 'qa', from: null, to: 'passed' },
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
    'refuses self-review by the %s without recording the note',
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
      const response = await check({ check: 'qa', state: 'passed', note: 'Self review' });
      expect([response.statusCode, response.json().error.code]).toEqual([403, 'self_review_forbidden']);
      expect(domain.tasks.get('AR', 'AR-1').checks.qa).toBeUndefined();
      expect(
        domain.timeline.list('AR', { taskKey: 'AR-1' }).some((event) => event.type === 'task_note'),
      ).toBe(false);
      expect((await check({ check: 'client_test', state: 'passed' })).statusCode).toBe(200);
    },
  );

  it.each(['done', 'cancelled'] as const)('refuses a %s task', async (status) => {
    const { repos, domain } = h.app.projectman;
    repos.tasks.update({ ...domain.tasks.get('AR', 'AR-1'), status, closedAt: new Date().toISOString() });
    const response = await check({ check: 'qa', state: 'passed' });
    expect([response.statusCode, response.json().error.code]).toEqual([409, 'task_closed']);
  });

  it.each([
    {},
    { check: 'unknown', state: 'passed' },
    { check: 'qa', state: 'unknown' },
    { check: 'qa' },
    { check: 'qa', state: 'passed', note: 1 },
    [],
  ])('validates the request %j', async (body) => {
    const response = await check(body);
    expect([response.statusCode, response.json().error.code]).toEqual([400, 'invalid_request']);
  });

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
    const response = await check({ check: 'qa', state: 'passed' });
    expect([response.statusCode, response.json().error.code]).toEqual([403, 'insufficient_access']);
    expect((await check({ check: 'qa', state: 'passed' }, owner)).statusCode).toBe(200);
  });
});
