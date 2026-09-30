import { afterEach, describe, expect, it } from 'vitest';
import { roleBundle } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR, type DomainHarness } from './helpers/domain-harness';
import { allowedToolsFor, sessionPolicyFor } from '../src/domain/session-policy';

let h: DomainHarness;
afterEach(() => h?.cleanup());
const by = { actor: OWNER_ACTOR, author: OWNER };
async function setup(fourEyes = false) {
  h = await createDomainHarness({
    adjust: (c) => {
      const owner = c.team.members[0]!;
      if (owner.kind === 'human') owner.roles = ['operator'];
      c.team.members.push({
        kind: 'human',
        handle: 'approver',
        displayName: 'Approver',
        access: 'admin',
        roles: ['operator'],
      });
      c.team.releaseFourEyes = fourEyes;
      c.pipeline.stages.find((s) => s.id === 'merge')!.gate = undefined;
      c.pipeline.labels.push(
        {
          id: 'release-approved',
          name: 'Release approved',
          setBy: { duties: ['release_approval'], humansOnly: true },
          clearedWhen: ['moved_back'],
        },
        ...(['code_review', 'security_review', 'qa'] as const).map((check) => ({
          id: `${check}-ok`,
          name: `${check} ok`,
          setBy: 'anyone' as const,
          notByAuthor: true,
        })),
      );
      c.pipeline.stages.find((s) => s.id === 'release')!.gate = {
        conditions: [{ type: 'has_label', label: 'release-approved' }],
      };
    },
  });
  return h.domain.tasks.create('AR', { title: 'Fictional release' }, OWNER_ACTOR);
}

describe('duty runtime rules', () => {
  it.each(['code_review', 'security_review', 'qa'] as const)(
    'forbids %s by assignee or persistent PR author and permits an independent result',
    async (check) => {
      const task = await setup();
      h.domain.tasks.assign('AR', task.key, 'dev-1', OWNER_ACTOR);
      h.domain.tasks.addLink(
        'AR',
        task.key,
        { kind: 'pull_request', ref: '1', repo: 'example/app' },
        OWNER_ACTOR,
      );
      h.domain.tasks.assign('AR', task.key, 'dev-2', OWNER_ACTOR);
      for (const handle of ['dev-1', 'dev-2'])
        await expect(
          h.domain.tasks.changeLabels('AR', task.key, { add: [`${check}-ok`] }, { kind: 'ai', handle }),
        ).rejects.toMatchObject({ code: 'self_review_forbidden' });
      expect(
        (
          await h.domain.tasks.changeLabels(
            'AR',
            task.key,
            { add: [`${check}-ok`] },
            { kind: 'ai', handle: 'cr' },
          )
        ).labels,
      ).toContain(`${check}-ok`);
      expect(h.domain.tasks.get('AR', task.key).links[0]!.author).toBe('dev-1');
    },
  );
  it('resolves duty approvals and filters author and assignee when four eyes is enabled', async () => {
    const task = await setup(true);
    h.domain.tasks.assign('AR', task.key, 'owner', OWNER_ACTOR);
    const result = await h.domain.tasks.moveToStage('AR', task.key, 'release', OWNER_ACTOR);
    expect(result.pendingApproval[0]!.assignees).toEqual(['approver']);
    await expect(
      h.domain.inbox.resolve(
        'AR',
        result.pendingApproval[0]!.id,
        { optionId: 'approve' },
        { handle: 'owner', access: 'owner' },
      ),
    ).rejects.toMatchObject({ code: 'release_four_eyes' });
    await h.domain.inbox.resolve(
      'AR',
      result.pendingApproval[0]!.id,
      { optionId: 'approve' },
      { handle: 'approver', access: 'admin' },
    );
    expect(h.domain.tasks.get('AR', task.key).stageId).toBe('release');
  });
  it('allows an assigned human approver when four eyes is off, but never an AI', async () => {
    const task = await setup();
    h.domain.tasks.assign('AR', task.key, 'owner', OWNER_ACTOR);
    const result = await h.domain.tasks.moveToStage('AR', task.key, 'release', OWNER_ACTOR);
    const item = result.pendingApproval[0]!;
    await expect(
      h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, { handle: 'dev-1', access: 'owner' }),
    ).rejects.toMatchObject({ code: 'ai_approval_forbidden' });
    await h.domain.inbox.resolve(
      'AR',
      item.id,
      { optionId: 'approve' },
      { handle: 'owner', access: 'owner' },
    );
    expect(h.domain.tasks.get('AR', task.key).stageId).toBe('release');
  });
  it('rechecks four eyes and gate membership after an approval request', async () => {
    const task = await setup();
    const result = await h.domain.tasks.moveToStage('AR', task.key, 'release', OWNER_ACTOR);
    h.domain.tasks.addLink('AR', task.key, { kind: 'pull_request', ref: '2', author: 'owner' }, OWNER_ACTOR);
    await h.domain.projects.update('AR', by, (c) => {
      c.team.releaseFourEyes = true;
      return 'Require independent release';
    });
    await expect(
      h.domain.inbox.resolve(
        'AR',
        result.pendingApproval[0]!.id,
        { optionId: 'approve' },
        { handle: 'owner', access: 'owner' },
      ),
    ).rejects.toMatchObject({ code: 'release_four_eyes' });
    expect(h.domain.inbox.get('AR', result.pendingApproval[0]!.id).state).toBe('open');
  });
  it('protects role creation, bundle edits and membership changes at the central save boundary', async () => {
    await setup();
    const admin = {
      actor: { kind: 'human' as const, handle: 'approver' },
      author: { name: 'Approver', email: 'approver@example.com' },
    };
    await expect(
      h.domain.roles.create(
        'AR',
        {
          id: 'release_lead',
          name: 'Release lead',
          summary: 'Decides.',
          notTheirJob: '',
          holders: 'both',
          duties: ['release_approval'],
          instructions: '',
        },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'owner_only' });
    await expect(
      h.domain.projects.update('AR', admin, (c) => {
        c.team.roleOverrides = { docs: { duties: ['release_approval'], instructions: '' } };
        return 'Grant release';
      }),
    ).rejects.toMatchObject({ code: 'owner_only' });
    await expect(h.domain.members.update('AR', 'approver', { roles: [] }, admin)).rejects.toMatchObject({
      code: 'owner_only',
    });
    // An AI member never changes the configuration, whatever the change.
    await expect(
      h.domain.projects.update(
        'AR',
        { actor: { kind: 'ai', handle: 'dev-1' }, author: admin.author },
        (c) => {
          c.project.name = 'Renamed by an AI';
          return 'Rename';
        },
      ),
    ).rejects.toMatchObject({ code: 'insufficient_access', status: 403 });
  });
  it('rejects retiring the last pipeline duty holder before changing runtime work', async () => {
    const task = await setup();
    await h.domain.projects.update('AR', by, (c) => {
      const review = c.pipeline.stages.find((s) => s.id === 'code_review')!;
      review.duty = 'code_review';
      delete review.owners;
      return 'Resolve review duty';
    });
    h.domain.tasks.assign('AR', task.key, 'cr', OWNER_ACTOR);
    await expect(h.domain.members.retire('AR', 'cr', {}, by)).rejects.toMatchObject({
      code: 'invalid_config',
    });
    expect(h.domain.tasks.get('AR', task.key).assignee).toBe('cr');
    expect((await h.domain.projects.config('AR')).team.members.some((m) => m.handle === 'cr')).toBe(true);
  });

  it('assigns custom delivery duty holders and unions read and worktree policies', async () => {
    const task = await setup();
    await h.domain.projects.update('AR', by, (c) => {
      c.team.roles.push({
        id: 'writer_reviewer',
        name: 'Writer reviewer',
        summary: 'Writes and reviews.',
        notTheirJob: '',
        holders: 'both',
        duties: ['docs', 'code_review'],
        instructions: 'Explain examples.',
      });
      const member = c.team.members.find((m) => m.handle === 'dev-1')!;
      if (member.kind === 'ai') member.role = 'writer_reviewer';
      const stage = c.pipeline.stages.find((s) => s.kind === 'work')!;
      stage.duty = 'docs';
      delete stage.owners;
      return 'Assign documentation';
    });
    const config = await h.domain.projects.config('AR');
    expect(roleBundle(config, 'writer_reviewer').duties).toEqual(['docs', 'code_review']);
    expect(sessionPolicyFor('writer_reviewer', config)).toEqual({ readOnlyTools: true, worktree: true });
    expect(allowedToolsFor('writer_reviewer', config)).toContain('Read');
    expect((await h.domain.taskStarts.start('AR', task.key, { ...by, sponsor: 'owner' })).task.assignee).toBe(
      'dev-1',
    );
  });
});
