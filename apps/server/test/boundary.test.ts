import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoundaryTarget, ProjectConfig } from '@projectman/shared';
import type { BoundaryRequester, ToolContext } from '../src/contracts';
import { createDomainHarness, restartDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { FakeBoundaryAdapter, fakeBoundaryTarget } from './helpers/fake-boundary';
import { flush } from './helpers/fakes';

const allow = { decision: 'allow', reason: 'scope_verified' } as const;
const deny = { decision: 'deny', reason: 'unsafe_target' } as const;
function configure(config: ProjectConfig) {
  config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
  config.team.roles.push({
    id: 'custom_lead',
    name: 'Custom lead',
    summary: 'Authorize external operations',
    duties: ['boundary_authorization', 'code_review'],
    holders: 'both',
    instructions: '',
    notTheirJob: '',
  });
  const cr = config.team.members.find((m) => m.handle === 'cr')!;
  if (cr.kind === 'ai') cr.role = 'custom_lead';
}

describe('boundary requests', () => {
  let h: DomainHarness;
  let adapter: FakeBoundaryAdapter;
  let requester: BoundaryRequester;
  let now: Date;
  beforeEach(async () => {
    now = new Date('2026-10-01T11:00:00.000Z');
    adapter = new FakeBoundaryAdapter();
    h = await createDomainHarness({
      persistent: true,
      now: () => now,
      adjust: configure,
      boundaryAdapter: adapter,
    });
    await h.domain.tasks.create('AR', { title: 'Boundary operation' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    requester = { projectKey: 'AR', member: 'dev-1', sessionId: started.session!.id, taskKey: 'AR-1' };
  });
  afterEach(() => h.cleanup());
  const toolContext = (r: BoundaryRequester): ToolContext => ({
    projectKey: r.projectKey,
    member: r.member,
    sessionId: r.sessionId,
    taskKey: r.taskKey,
  });

  async function submit(patch: Partial<BoundaryTarget> = {}, key = 'retry-1', asker = requester) {
    adapter.register(key, asker, fakeBoundaryTarget(patch));
    return h.domain.boundary.submit(asker, { operationId: key, deduplicationKey: key });
  }

  it('routes a custom-duty request, wakes the lead through messaging and records the AI decision for the owner', async () => {
    const request = await submit();
    expect(request).toMatchObject({ state: 'pending_lead', assignees: ['cr'], category: 'delegable' });
    await flush();
    expect(h.domain.sessions.list('AR', { member: 'cr', taskKey: 'AR-1' })).toHaveLength(1);
    const decided = await h.domain.teamTools.decideBoundaryRequest(
      { ...toolContext(requester), member: 'cr' },
      { requestId: request.id, ...allow },
    );
    expect(decided).toMatchObject({
      state: 'allowed',
      decidedBy: { kind: 'ai', handle: 'cr' },
      reason: 'scope_verified',
    });
    const item = h.repos.inbox.get(request.id)!;
    expect(item.assignees).toContain('owner');
    expect(item.resolution).toMatchObject({ by: 'cr', optionId: 'allow' });
    expect(
      h.domain.timeline
        .list('AR')
        .filter((e) => e.type === 'boundary_changed')
        .at(-1),
    ).toMatchObject({ actor: { kind: 'ai', handle: 'cr' }, data: { state: 'allowed' } });
    expect((await h.domain.boundary.read('AR', request.id, 'owner')).grant).toMatchObject({
      member: 'dev-1',
      sessionId: requester.sessionId,
    });
  });

  it.each([
    ['spend', 'cost'],
    ['production_change', 'production'],
    ['release', 'production'],
    ['publish_main', 'production'],
    ['create_account', 'credentials'],
    ['create_secret', 'credentials'],
    ['expand_host', 'host_expansion'],
  ] as const)('keeps %s exclusively with owners', async (operation, category) => {
    const request = await submit({ operation });
    expect(request).toMatchObject({ category, state: 'pending_owner', assignees: ['owner'] });
    await expect(h.domain.boundary.decide('AR', request.id, 'cr', allow)).rejects.toMatchObject({
      code: 'not_an_assignee',
    });
    await expect(
      h.domain.teamTools.decideBoundaryRequest(
        { ...toolContext(requester), member: 'cr' },
        { requestId: request.id, ...allow },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await h.domain.boundary.decide('AR', request.id, 'owner', allow)).state).toBe('allowed');
    await flush();
    expect(h.domain.sessions.list('AR', { member: 'cr' })).toHaveLength(0);
  });

  it.each([
    { environment: 'production' },
    { operation: 'publish_branch', branch: 'refs/heads/main' },
    { operation: 'publish_branch', branch: 'trunk', protectedBranch: true },
  ] satisfies Partial<BoundaryTarget>[])(
    'derives protected targets from adapter metadata: %j',
    async (patch) => {
      expect((await submit(patch)).category).toBe('production');
    },
  );

  it('rejects unknown operations, forged identity and caller-supplied categories', async () => {
    await expect(
      h.domain.boundary.submit(requester, { operationId: 'unknown', deduplicationKey: 'unknown' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    adapter.register('cost', requester, fakeBoundaryTarget({ operation: 'spend' }));
    await expect(
      h.domain.boundary.submit(requester, {
        operationId: 'cost',
        deduplicationKey: 'cost',
        category: 'delegable',
      } as never),
    ).rejects.toThrow();
    await expect(
      h.domain.boundary.submit(
        { ...requester, member: 'cr' },
        { operationId: 'cost', deduplicationKey: 'cost' },
      ),
    ).rejects.toMatchObject({ code: 'not_a_member' });
    await expect(
      h.domain.boundary.submit(requester, { operationId: 'cost', deduplicationKey: 'cost' }),
    ).resolves.toMatchObject({ category: 'cost' });
  });

  it('deduplicates simultaneous retries and refuses key reuse for another operation', async () => {
    adapter.register('docs', requester, fakeBoundaryTarget());
    const args = { operationId: 'docs', deduplicationKey: 'stable' };
    const [first, second] = await Promise.all([
      h.domain.boundary.submit(requester, args),
      h.domain.boundary.submit(requester, args),
    ]);
    expect(second.id).toBe(first.id);
    expect(h.repos.boundary.list()).toHaveLength(1);
    await expect(
      h.domain.boundary.submit(requester, { ...args, operationId: 'other' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await h.domain.boundary.decide('AR', first.id, 'cr', deny);
    expect((await h.domain.boundary.submit(requester, args)).state).toBe('denied');
  });

  it('refuses unauthorized, self, double and late decisions without issuing a grant', async () => {
    const request = await submit();
    await expect(h.domain.boundary.decide('AR', request.id, 'dev-1', allow)).rejects.toMatchObject({
      code: 'not_an_assignee',
    });
    await expect(h.domain.boundary.read('AR', request.id, 'dev-2')).rejects.toMatchObject({
      code: 'not_an_assignee',
    });
    now = new Date('2026-10-01T11:02:00.000Z');
    await expect(h.domain.boundary.decide('AR', request.id, 'cr', allow)).rejects.toMatchObject({
      code: 'not_an_assignee',
    });
    expect(h.repos.boundary.get(request.id)?.state).toBe('pending_owner');
    await h.domain.boundary.decide('AR', request.id, 'owner', deny);
    await expect(h.domain.boundary.decide('AR', request.id, 'owner', allow)).rejects.toMatchObject({
      code: 'inbox_item_closed',
    });
    expect(h.repos.boundary.grant(request.id)).toBeNull();
  });

  it('serializes competing decisions into exactly one grant and audit decision', async () => {
    const request = await submit();
    const results = await Promise.allSettled([
      h.domain.boundary.decide('AR', request.id, 'cr', allow),
      h.domain.boundary.decide('AR', request.id, 'owner', allow),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      h.domain.timeline.list('AR').filter((e) => e.type === 'boundary_changed' && e.data.state === 'allowed'),
    ).toHaveLength(1);
  });

  it('uses an independent lead for a lead requester, or the owner when no other lead exists', async () => {
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      const dev = config.team.members.find((m) => m.handle === 'dev-1')!;
      if (dev.kind === 'ai') dev.role = 'lead_developer';
      return 'Grant lead duty';
    });
    const first = await submit();
    expect(first.assignees).toEqual(['cr']);
    await expect(h.domain.boundary.decide('AR', first.id, 'dev-1', allow)).rejects.toMatchObject({
      code: 'not_an_assignee',
    });
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      const cr = config.team.members.find((m) => m.handle === 'cr')!;
      if (cr.kind === 'ai') cr.onLeave = true;
      return 'Send lead on leave';
    });
    expect((await submit({}, 'second')).state).toBe('pending_owner');
  });

  it('escalates persisted absolute deadlines on restart and refuses the late lead', async () => {
    const request = await submit();
    now = new Date('2026-10-01T11:02:00.000Z');
    h = await restartDomainHarness(h, { now: () => now, boundaryAdapter: adapter });
    expect(h.repos.boundary.get(request.id)).toMatchObject({
      state: 'pending_owner',
      assignees: ['owner'],
      leadDeadline: request.leadDeadline,
    });
    await expect(h.domain.boundary.decide('AR', request.id, 'cr', allow)).rejects.toMatchObject({
      code: 'not_an_assignee',
    });
    expect((await h.domain.boundary.decide('AR', request.id, 'owner', allow)).state).toBe('allowed');
  });

  it('escalates when admission cannot wake a busy lead without keeping the submission open', async () => {
    // All capacity is occupied by other running general chats; notification stays deferred.
    const lead = h.domain.sessions;
    await lead.ensureSession('AR', 'cr', { type: 'general' });
    const request = await submit();
    await flush();
    expect(h.repos.boundary.get(request.id)?.state).toBe('pending_lead');
    expect(h.repos.deferredStarts.list()).not.toHaveLength(0);
    now = new Date('2026-10-01T11:02:00.000Z');
    await h.domain.boundary.sweep();
    expect(h.repos.boundary.get(request.id)?.state).toBe('pending_owner');
    expect(h.repos.boundary.grant(request.id)).toBeNull();
  });

  it('expires unanswered owner requests, including after restart', async () => {
    const request = await submit({ operation: 'spend' });
    now = new Date('2026-10-01T12:00:00.000Z');
    h = await restartDomainHarness(h, { now: () => now, boundaryAdapter: adapter });
    expect(h.repos.boundary.get(request.id)?.state).toBe('expired');
    await expect(h.domain.boundary.decide('AR', request.id, 'owner', allow)).rejects.toMatchObject({
      code: 'inbox_item_closed',
    });
  });

  it('escalates after a failed lead wake-up and stores no raw retry credential', async () => {
    h.runner.failNextStart = new Error('Fictional provider unavailable');
    adapter.register('docs', requester, fakeBoundaryTarget());
    const request = await h.domain.boundary.submit(requester, {
      operationId: 'docs',
      deduplicationKey: 'fictional-secret-retry-key',
    });
    await flush();
    expect(JSON.stringify(h.repos.boundary.list())).not.toContain('fictional-secret-retry-key');
    expect(h.repos.boundary.grant(request.id)).toBeNull();
    now = new Date('2026-10-01T11:02:00.000Z');
    await h.domain.boundary.sweep();
    expect(h.repos.boundary.get(request.id)?.state).toBe('pending_owner');
  });

  it('keeps an unexpired pending request and delegation settings across restart without restarting its deadline', async () => {
    const request = await submit();
    now = new Date('2026-10-01T11:01:00.000Z');
    h = await restartDomainHarness(h, { now: () => now, boundaryAdapter: adapter });
    expect((await h.domain.projects.config('AR')).team.boundary).toEqual({
      enabled: true,
      leadTimeoutSeconds: 120,
    });
    expect((await h.domain.boundary.read('AR', request.id, 'owner')).request).toMatchObject({
      state: 'pending_lead',
      leadDeadline: request.leadDeadline,
    });
  });

  it('rechecks targets and policy on decision and grant consumption', async () => {
    const request = await submit();
    adapter.operations.get('retry-1')!.target.operation = 'spend';
    await expect(h.domain.boundary.decide('AR', request.id, 'cr', allow)).rejects.toMatchObject({
      code: 'inbox_item_closed',
    });
    expect(h.repos.boundary.get(request.id)?.state).toBe('revoked');
    const allowed = await submit({}, 'allowed');
    await h.domain.boundary.decide('AR', allowed.id, 'cr', allow);
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      config.team.boundary!.enabled = false;
      return 'Disable delegation';
    });
    await expect(h.domain.boundary.consume(requester, allowed.id, 'allowed')).rejects.toMatchObject({
      code: 'insufficient_access',
    });
    expect(h.repos.boundary.grant(allowed.id)?.revokedAt).not.toBeNull();
  });

  it('rechecks live duties and escalates a pending request on configuration change', async () => {
    const request = await submit();
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      config.team.roles[0]!.duties = ['code_review'];
      return 'Remove delegation duty';
    });
    await expect(h.domain.boundary.decide('AR', request.id, 'cr', allow)).rejects.toMatchObject({
      code: 'not_an_assignee',
    });
    expect((await h.domain.boundary.decide('AR', request.id, 'owner', allow)).state).toBe('allowed');
  });

  it('revokes granted operations durably and the fake executor cannot reuse or cross-bind a grant', async () => {
    const first = await submit();
    await h.domain.boundary.decide('AR', first.id, 'cr', allow);
    await expect(
      h.domain.boundary.consume({ ...requester, member: 'dev-2' }, first.id, 'retry-1'),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
    await expect(h.domain.boundary.consume(requester, first.id, 'other')).rejects.toMatchObject({
      code: 'insufficient_access',
    });
    await expect(h.domain.boundary.consume(requester, first.id, 'retry-1')).resolves.toMatchObject({
      consumedAt: now.toISOString(),
      decidedBy: { kind: 'ai', handle: 'cr' },
    });
    await expect(h.domain.boundary.consume(requester, first.id, 'retry-1')).rejects.toMatchObject({
      code: 'insufficient_access',
    });
    const second = await submit({}, 'second');
    await h.domain.boundary.decide('AR', second.id, 'cr', allow);
    await expect(h.domain.boundary.revoke('AR', second.id, 'cr')).rejects.toMatchObject({
      code: 'owner_only',
    });
    await h.domain.boundary.revoke('AR', second.id, 'owner');
    h = await restartDomainHarness(h, { now: () => now, boundaryAdapter: adapter });
    expect(h.repos.boundary.grant(second.id)?.revokedAt).not.toBeNull();
    await expect(h.domain.boundary.consume(requester, second.id, 'second')).rejects.toMatchObject({
      code: 'insufficient_access',
    });
  });

  it('never relaxes ordinary inbox or release approvals for a delegation holder', async () => {
    const request = await submit();
    await expect(
      h.domain.inbox.resolve('AR', request.id, { optionId: 'allow' }, { handle: 'cr', access: 'owner' }),
    ).rejects.toMatchObject({ code: 'ai_approval_forbidden' });
    await expect(
      h.domain.inbox.resolve('AR', request.id, { optionId: 'allow' }, { handle: 'owner', access: 'owner' }),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
    const item = h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'decision',
      assignees: ['owner'],
      source: 'dev-1',
      taskKey: 'AR-1',
      title: 'Release',
      payload: {},
      options: [{ id: 'approve', label: 'approve', style: 'primary' }],
    });
    await expect(
      h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, { handle: 'cr', access: 'owner' }),
    ).rejects.toMatchObject({ code: 'ai_approval_forbidden' });
  });
});
