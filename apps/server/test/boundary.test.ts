import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // The project manager is at work and holds the duty too, and still never decides (PM-433).
  config.team.roleOverrides = { project_manager: { duties: ['boundary_authorization'], instructions: '' } };
  const pm = config.team.members.find((m) => m.handle === 'pm')!;
  if (pm.kind === 'ai') pm.onLeave = false;
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

  it('never names the project manager as a lead, and refuses its decision, even with the duty (PM-433)', async () => {
    const request = await submit();
    expect(request.assignees).toEqual(['cr']);
    await expect(h.domain.boundary.decide('AR', request.id, 'pm', allow)).rejects.toMatchObject({
      code: 'not_an_assignee',
    });
    await expect(
      h.domain.teamTools.decideBoundaryRequest(
        { ...toolContext(requester), member: 'pm' },
        { requestId: request.id, ...allow },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.repos.inbox.get(request.id)!.resolution).toBeFalsy();
    await flush();
    expect(h.domain.sessions.list('AR', { member: 'pm' })).toHaveLength(0);
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
    const approvalResolution = structuredClone(h.repos.inbox.get(second.id)!.resolution);
    await expect(h.domain.boundary.revoke('AR', second.id, 'cr')).rejects.toMatchObject({
      code: 'owner_only',
    });
    await h.domain.boundary.revoke('AR', second.id, 'owner');
    expect(h.repos.boundary.get(second.id)).toMatchObject({
      state: 'revoked',
      decidedBy: { kind: 'ai', handle: 'cr' },
      reason: 'scope_verified',
      invalidation: { actor: { kind: 'human', handle: 'owner' }, reason: 'owner_revoked' },
    });
    expect(h.repos.inbox.get(second.id)).toMatchObject({ state: 'resolved', resolution: approvalResolution });
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

  it.each(['expiry', 'policy'] as const)(
    'preserves the original unused approval after %s invalidation',
    async (cause) => {
      const request = await submit();
      const approved = await h.domain.boundary.decide('AR', request.id, 'cr', allow);
      const resolution = structuredClone(h.repos.inbox.get(request.id)!.resolution);
      if (cause === 'expiry') now = new Date(request.expiresAt);
      else
        await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
          config.team.boundary!.enabled = false;
          return 'Disable delegation';
        });
      await h.domain.boundary.sweep();
      const state = cause === 'expiry' ? 'expired' : 'revoked';
      const reason = cause === 'expiry' ? 'deadline_expired' : 'policy_changed';
      expect(h.repos.boundary.get(request.id)).toMatchObject({
        state,
        decidedBy: approved.decidedBy,
        reason: approved.reason,
        invalidation: { actor: { kind: 'system', handle: null }, reason },
      });
      expect(h.repos.boundary.grant(request.id)).toMatchObject({
        state,
        decidedBy: approved.decidedBy,
        reason: approved.reason,
      });
      expect(h.repos.inbox.get(request.id)).toMatchObject({ state: 'resolved', resolution });
      expect(
        h.domain.timeline
          .list('AR')
          .filter((e) => e.type === 'boundary_changed')
          .at(-1),
      ).toMatchObject({
        actor: { kind: 'system', handle: null },
        data: { state, reason },
      });
      await expect(
        h.domain.boundary.consume(requester, request.id, request.operationId),
      ).rejects.toMatchObject({ code: 'insufficient_access' });
      h = await restartDomainHarness(h, { now: () => now, boundaryAdapter: adapter });
      expect(h.repos.inbox.get(request.id)!.resolution).toEqual(resolution);
      expect(h.repos.boundary.get(request.id)!.decidedBy).toEqual(approved.decidedBy);
    },
  );

  it.each(['expiry', 'policy'] as const)(
    'keeps consumed grants final across %s, target removal, revocation and restart',
    async (cause) => {
      const request = await submit();
      await h.domain.boundary.decide('AR', request.id, 'cr', allow);
      const consumed = await h.domain.boundary.consume(requester, request.id, request.operationId);
      expect(h.repos.boundary.get(request.id)?.consumedAt).toBe(consumed.consumedAt);
      // A previously persisted consumed grant may predate the additive request marker.
      if (cause === 'policy') {
        const legacy = h.repos.boundary.get(request.id)!;
        delete legacy.consumedAt;
        h.repos.boundary.update(legacy);
      }
      const historical = structuredClone(h.repos.boundary.get(request.id));
      const inbox = structuredClone(h.repos.inbox.get(request.id));
      adapter.operations.delete(request.operationId);
      if (cause === 'expiry') now = new Date(request.expiresAt);
      else
        await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
          config.team.boundary!.enabled = false;
          return 'Disable delegation';
        });
      await h.domain.boundary.sweep();
      expect(h.repos.boundary.listActive().some((r) => r.id === request.id)).toBe(false);
      await expect(h.domain.boundary.revoke('AR', request.id, 'owner')).rejects.toMatchObject({
        code: 'inbox_item_closed',
      });
      expect((await h.domain.boundary.read('AR', request.id, 'owner')).request).toEqual(historical);
      expect(h.repos.boundary.grant(request.id)).toEqual(consumed);
      expect(h.repos.inbox.get(request.id)).toEqual(inbox);
      h = await restartDomainHarness(h, { now: () => now, boundaryAdapter: adapter });
      expect(h.repos.boundary.get(request.id)).toEqual(historical);
      expect(h.repos.boundary.grant(request.id)).toEqual(consumed);
      expect(h.repos.inbox.get(request.id)).toEqual(inbox);
      await expect(
        h.domain.boundary.consume(requester, request.id, request.operationId),
      ).rejects.toMatchObject({ code: 'insufficient_access' });
    },
  );

  it('isolates a failed request read and retries it without blocking other requests in the same project', async () => {
    const broken = await submit({}, 'broken');
    const healthy = await submit({}, 'healthy');
    now = new Date(broken.leadDeadline);
    const get = h.repos.boundary.get;
    const fault = vi.spyOn(h.repos.boundary, 'get').mockImplementation((id) => {
      if (id === broken.id) throw new Error('Fictional record failure');
      return get(id);
    });
    try {
      await expect(h.domain.boundary.sweep()).resolves.toBeUndefined();
      expect(get(broken.id)?.state).toBe('pending_lead');
      expect(get(healthy.id)?.state).toBe('pending_owner');
      expect(h.log.warnings).toContainEqual([
        { projectKey: 'AR', requestId: broken.id },
        'boundary request refresh failed',
      ]);
    } finally {
      fault.mockRestore();
    }
    await h.domain.boundary.sweep();
    expect(get(broken.id)?.state).toBe('pending_owner');
    expect(h.repos.boundary.grant(broken.id)).toBeNull();
  });

  it('starts and processes healthy project deadlines while another project configuration is unreadable, then recovers', async () => {
    const broken = await submit({}, 'broken');
    await h.domain.projects.create(
      { key: 'BR', name: 'Healthy', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    await h.domain.projects.update('BR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      configure(config);
      return 'Enable delegation';
    });
    await h.domain.tasks.create('BR', { title: 'Healthy operation' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('BR', 'BR-1', { actor: OWNER_ACTOR, author: OWNER });
    const healthyRequester = {
      projectKey: 'BR',
      member: 'dev-1',
      sessionId: started.session!.id,
      taskKey: 'BR-1',
    };
    const healthy = await submit({}, 'healthy', healthyRequester);
    now = new Date(broken.leadDeadline);
    let unreadable = true;
    h = await restartDomainHarness(h, {
      now: () => now,
      boundaryAdapter: adapter,
      configStore: (inner) => ({
        ...inner,
        async load(key) {
          if (key === 'AR' && unreadable) throw new Error('Fictional unreadable configuration');
          return inner.load(key);
        },
      }),
    });
    expect(h.log.errors).toHaveLength(1); // Existing project startup logs the configuration failure.
    h.log.errors.splice(0);
    expect(h.log.warnings).toContainEqual([
      { projectKey: 'AR', requestId: broken.id },
      'boundary request refresh failed',
    ]);
    expect(h.repos.boundary.get(broken.id)?.state).toBe('pending_lead');
    expect(h.repos.boundary.get(healthy.id)?.state).toBe('pending_owner');
    const periodic = await submit({}, 'periodic', healthyRequester);
    now = new Date(periodic.leadDeadline);
    await vi.waitFor(() => expect(h.repos.boundary.get(periodic.id)?.state).toBe('pending_owner'), {
      timeout: 3000,
    });
    expect(h.repos.boundary.get(broken.id)?.state).toBe('pending_lead');
    expect(h.repos.boundary.grant(broken.id)).toBeNull();
    unreadable = false;
    await h.domain.boundary.sweep();
    expect(h.repos.boundary.get(broken.id)?.state).toBe('pending_owner');
  });
});
