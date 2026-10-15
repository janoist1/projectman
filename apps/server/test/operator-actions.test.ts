import { afterEach, describe, expect, it, vi } from 'vitest';
import { memberOf, operatorApprovalOf, operatorWatchOf } from '@projectman/shared';
import { humanActor } from '../src/kernel';
import type { AiMemberConfig, OperatorOperation, OperatorPlan, ProjectConfig } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let ctx: ToolContext;
const by = { actor: OWNER_ACTOR, author: OWNER };
const owner = { handle: 'owner', access: 'owner' as const };
afterEach(async () => {
  await h?.cleanup();
});

async function setup(persistent = false, adjust?: (config: ProjectConfig) => void, now?: () => Date) {
  h = await createDomainHarness({
    persistent,
    now,
    adjust: (config) => {
      (memberOf(config, 'dev-1') as AiMemberConfig).outboundNetwork = false;
      config.team.members.push({
        kind: 'human',
        handle: 'dana',
        displayName: 'Dana',
        access: 'admin',
        roles: [],
        email: 'dana@example.test',
      });
      config.pipeline.stages.splice(1, 0, {
        id: 'ready',
        name: 'Ready',
        kind: 'queue',
        owners: ['owner'],
        columnId: 'todo',
      });
      adjust?.(config);
    },
  });
  await h.domain.messaging.sendReporting(
    'AR',
    'owner',
    {
      to: ['operator'],
      text: 'Change the writer to Sonnet.\nAllow network access.',
    },
    { awaitWake: true },
  );
  await flush();
  const session = h.domain.sessions.list('AR', { member: 'operator' })[0]!;
  ctx = { projectKey: 'AR', member: 'operator', sessionId: session.id, taskKey: null };
}
const plan: OperatorPlan = {
  why: 'Report the completed work',
  impact: 'One person receives the update',
  reversible: false,
};
async function operate(operation: OperatorOperation) {
  return h.domain.teamTools.operate(ctx, {
    title: 'Requested result',
    operation,
    ...(['session_stop', 'message_send'].includes(operation.op) ? { plan } : {}),
  });
}
const network = (): OperatorOperation => ({
  op: 'member_update',
  handle: 'dev-1',
  changes: { outboundNetwork: true },
});
const member = async (handle = 'dev-1') =>
  memberOf(await h.domain.projects.config('AR'), handle) as AiMemberConfig;
const resolve = (id: string, optionId = 'approve') => h.domain.inbox.resolve('AR', id, { optionId }, owner);

describe('Operator actions and owner approvals (PM-464)', () => {
  const message = (): OperatorOperation => ({ op: 'message_send', to: ['dana'], text: 'Work is ready.' });
  const sent = () => h.repos.messages.list('AR', { member: 'dana' }).filter((m) => m.from === 'operator');

  it.each(['message_send', 'session_stop'] as const)(
    'requires a plan for %s and records the refusal',
    async (op) => {
      await setup();
      await expect(
        h.domain.teamTools.operate(ctx, {
          title: 'Critical step',
          operation: op === 'message_send' ? message() : { op, sessionId: ctx.sessionId },
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('operator_plan_required') });
      const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
      expect(h.repos.operatorRequests.steps(request.id).at(-1)).toMatchObject({
        status: 'refused',
        refusal: { code: 'operator_plan_required' },
      });
      expect(sent()).toHaveLength(0);
    },
  );

  it.each(['owner', 'dev-1', 'operator', 'unknown'])('refuses message proposals to %s', async (to) => {
    await setup();
    await expect(operate({ op: 'message_send', to: [to], text: 'Hi' })).rejects.toMatchObject({
      message: expect.stringContaining('operator_message_recipient'),
    });
    expect(sent()).toHaveLength(0);
  });

  it('keeps delegated critical proposals with owners and sends the exact text once', async () => {
    await setup(false, (config) => {
      config.team.boundary = { enabled: true, leadTimeoutSeconds: 60 };
    });
    const result = await operate({
      op: 'message_send',
      to: ['dana', 'dana'],
      text: 'First paragraph.\n\nSecond paragraph.',
    });
    const item = h.domain.inbox.get('AR', result.inbox_item_id!);
    expect(item.assignees).toEqual(['owner']);
    expect(operatorApprovalOf(item)).toMatchObject({
      plan,
      operation: { to: ['dana'] },
      expiresAt: expect.any(String),
    });
    expect(sent()).toHaveLength(0);
    for (const resolver of [
      { handle: 'dana', access: 'admin' as const },
      { ...owner, via: 'integrator' as const },
      { handle: 'operator', access: 'owner' as const },
    ])
      await expect(h.domain.operatorApprovals.apply(item, resolver, 'approve')).rejects.toMatchObject({
        code: 'owner_approval_required',
      });
    await resolve(item.id);
    expect(sent()).toMatchObject([{ body: 'First paragraph.\n\nSecond paragraph.', to: ['dana'] }]);
    await expect(h.domain.operatorApprovals.apply(item, owner, 'approve')).rejects.toMatchObject({
      code: 'operator_approval_used',
    });
    expect(sent()).toHaveLength(1);
  });

  it('consumes an approval atomically across concurrent applications', async () => {
    await setup();
    const result = await operate(message());
    const item = h.domain.inbox.get('AR', result.inbox_item_id!);
    const results = await Promise.allSettled([
      h.domain.operatorApprovals.apply(item, owner, 'approve'),
      h.domain.operatorApprovals.apply(item, owner, 'approve'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'operator_approval_used' },
    });
    expect(sent()).toHaveLength(1);
  });

  it('rejects without sending and never replays a rejected proposal', async () => {
    await setup();
    const result = await operate(message());
    const item = h.domain.inbox.get('AR', result.inbox_item_id!);
    await resolve(item.id, 'reject');
    await expect(h.domain.operatorApprovals.apply(item, owner, 'approve')).rejects.toMatchObject({
      code: 'operator_approval_used',
    });
    expect(sent()).toHaveLength(0);
  });

  it('deduplicates concurrent submissions and persists deduplication across restart', async () => {
    await setup(true);
    const results = await Promise.all([operate(message()), operate(message())]);
    expect(results[0]!.inbox_item_id).toBe(results[1]!.inbox_item_id);
    expect(results.filter((r) => r.deduplicated)).toHaveLength(1);
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(h.repos.operatorRequests.steps(request.id)).toHaveLength(1);
    h = await restartDomainHarness(h);
    const again = await h.domain.operatorActions.run('AR', request.id, 'Same proposal', message(), plan);
    expect(again).toMatchObject({ inbox_item_id: results[0]!.inbox_item_id, deduplicated: true });
    expect(h.repos.operatorRequests.steps(request.id)).toHaveLength(1);
  });

  it.each(['message_send', 'session_stop'] as const)(
    'expires %s after 24 hours without executing',
    async (op) => {
      let now = new Date('2026-10-15T12:00:00Z');
      await setup(false, undefined, () => now);
      await h.domain.messaging.sendReporting('AR', 'owner', { to: ['dev-1'], text: 'Start' });
      await flush();
      const target = h.domain.sessions.list('AR', { member: 'dev-1' })[0]!;
      const result = await operate(op === 'message_send' ? message() : { op, sessionId: target.id });
      now = new Date(now.getTime() + 24 * 60 * 60_000);
      await expect(resolve(result.inbox_item_id!)).rejects.toMatchObject({ code: 'operator_approval_stale' });
      expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale?.reason).toBe(
        'expired',
      );
      expect(sent()).toHaveLength(0);
      expect(h.domain.sessions.isRunning(target.id)).toBe(true);
    },
  );

  it('sweeps expired proposals and allows an explicit new proposal', async () => {
    let now = new Date();
    await setup(false, undefined, () => now);
    const result = await operate(message());
    now = new Date(now.getTime() + 24 * 60 * 60_000);
    h.domain.operatorApprovals.sweep();
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale?.reason).toBe(
      'expired',
    );
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    const again = await h.domain.operatorActions.run('AR', request.id, 'Try again', message(), plan);
    expect(again.inbox_item_id).not.toBe(result.inbox_item_id);
    expect(sent()).toHaveLength(0);
  });

  it('marks a consumed open proposal interrupted after restart without replay', async () => {
    await setup(true);
    const result = await operate(message());
    expect(h.repos.operatorRequests.claimStep(result.step_id)).toBe(true);
    h = await restartDomainHarness(h);
    h.domain.operatorApprovals.sweep();
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale?.reason).toBe(
      'interrupted',
    );
    await expect(resolve(result.inbox_item_id!)).rejects.toMatchObject({ code: 'operator_approval_stale' });
    expect(sent()).toHaveLength(0);
  });

  it('consumes a failed execution and makes the proposal dismiss-only', async () => {
    await setup();
    const result = await operate(message());
    const send = vi.spyOn(h.domain.messaging, 'send').mockRejectedValueOnce(new Error('transport failed'));
    await expect(resolve(result.inbox_item_id!)).rejects.toThrow('transport failed');
    const item = h.domain.inbox.get('AR', result.inbox_item_id!);
    expect(operatorApprovalOf(item)?.stale?.reason).toBe('interrupted');
    expect(item.options.map((o) => o.id)).toEqual(['dismiss']);
    await expect(resolve(item.id)).rejects.toMatchObject({ code: 'operator_approval_stale' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('rechecks recipient membership before approval', async () => {
    await setup();
    const result = await operate(message());
    await h.domain.members.removeHuman('AR', 'dana', by);
    await expect(resolve(result.inbox_item_id!)).rejects.toMatchObject({ code: 'operator_approval_stale' });
    expect(sent()).toHaveLength(0);
  });

  it.each([false, true])(
    'refuses an entire direct Operator send to non-owner humans before storing any attachment (signal=%s)',
    async (signal) => {
      await setup();
      await expect(
        h.domain.teamTools.sendMessage(ctx, {
          to: ['owner', 'dana'],
          text: 'Hello',
          kind: 'info',
          attachments: ['missing.txt'],
          ...(signal ? { signalId: 'ops_signal' } : {}),
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('operator_owner_approval') });
      const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
      expect(h.repos.operatorRequests.steps(request.id).at(-1)).toMatchObject({
        status: 'refused',
        member: 'dana',
        refusal: { code: 'operator_owner_approval' },
      });
      expect(sent()).toHaveLength(0);
      await expect(
        h.domain.teamTools.sendMessage(ctx, { to: ['owner', 'dev-1'], text: 'Report', kind: 'info' }),
      ).resolves.toBeDefined();
    },
  );

  it('allows only the owner to change the watch level, including clearing it', async () => {
    await setup();
    const patchAs = async (operatorWatch: 'report' | 'unblock' | 'drive' | null, meta: typeof by) =>
      h.domain.projects.patch(
        'AR',
        {
          baseVersion: (await h.domain.projects.load('AR')).version,
          operatorWatch,
        },
        meta,
      );
    const admin = { actor: humanActor('dana'), author: { name: 'Dana', email: 'dana@example.test' } };
    const integrator = {
      actor: { ...OWNER_ACTOR, via: 'integrator' as const },
      author: { ...OWNER, via: 'integrator' as const },
    };
    const originalVersion = (await h.domain.projects.load('AR')).version;
    for (const meta of [admin, integrator])
      await expect(patchAs('unblock', meta)).rejects.toMatchObject({
        code: meta === admin ? 'owner_only' : 'owner_login_required',
        status: 403,
      });
    expect((await h.domain.projects.load('AR')).version).toBe(originalVersion);
    expect(operatorWatchOf((await patchAs('drive', by)).config)).toBe('drive');
    for (const meta of [admin, integrator])
      await expect(patchAs(null, meta)).rejects.toMatchObject({
        code: meta === admin ? 'owner_only' : 'owner_login_required',
        status: 403,
      });
    const cleared = await patchAs(null, by);
    expect(cleared.config.team).not.toHaveProperty('operatorWatch');
    expect(operatorWatchOf(cleared.config)).toBe('report');
    await expect(patchAs('report', admin)).resolves.toBeDefined();
    await expect(patchAs(null, integrator)).resolves.toBeDefined();
  });

  it('changes and clears the watch level only after owner approval', async () => {
    await setup(true);
    for (const level of ['unblock', null] as const) {
      const before = await h.domain.projects.config('AR');
      const result = await operate({ op: 'config_patch', patch: { operatorWatch: level } });
      expect(result.status).toBe('awaiting_approval');
      expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))).toMatchObject({
        consequence: 'operator_watch',
        changes: [{ area: 'project', field: 'operatorWatch', level: 'approval', after: level }],
      });
      expect(await h.domain.projects.config('AR')).toEqual(before);
      expect((await h.configStore.load('AR')).config.team.operatorWatch).toBe(before.team.operatorWatch);
      await resolve(result.inbox_item_id!);
      const config = await h.domain.projects.config('AR');
      expect(operatorWatchOf(config)).toBe(level ?? 'report');
      expect((await h.configStore.load('AR')).config.team.operatorWatch).toBe(level ?? undefined);
      if (level === null) {
        expect(config.team).not.toHaveProperty('operatorWatch');
        expect((await h.configStore.load('AR')).config.team).not.toHaveProperty('operatorWatch');
      }
    }
    h = await restartDomainHarness(h);
    expect(operatorWatchOf(await h.domain.projects.config('AR'))).toBe('report');
  });

  it('keeps the approved watch level in project state after a server restart', async () => {
    await setup(true);
    const result = await operate({ op: 'config_patch', patch: { operatorWatch: 'unblock' } });
    await resolve(result.inbox_item_id!);
    h = await restartDomainHarness(h);
    expect((await h.domain.projectState.overview('AR')).operatorWatch).toBe('unblock');
    expect((await h.domain.projects.config('AR')).team.operatorWatch).toBe('unblock');
  });

  it.each(['config_changed', 'session_ended', 'pause_changed'] as const)(
    'does not hold later %s listeners while an approval recheck is pending',
    async (event) => {
      await setup();
      await operate(network());
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      const loaded = await h.domain.projects.load('AR');
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const recheck = vi.spyOn(h.domain.operatorApprovals, 'recheck').mockReturnValue(pending);
      const listener = vi.fn();
      h.domain.ctx.events.on(event, listener);
      try {
        const emitted =
          event === 'config_changed'
            ? h.domain.ctx.events.emit(event, {
                projectKey: 'AR',
                previous: loaded.config,
                next: loaded.config,
                version: loaded.version,
                actor: OWNER_ACTOR,
              })
            : event === 'session_ended'
              ? h.domain.ctx.events.emit(event, session)
              : h.domain.ctx.events.emit(event, { projectKey: 'AR' });
        await emitted;
        expect(recheck).toHaveBeenCalledWith('AR');
        expect(listener).toHaveBeenCalledOnce();
      } finally {
        release();
        recheck.mockRestore();
      }
    },
  );

  it('preserves integrator attribution when a config patch message forges Operator trailers', async () => {
    await setup();
    await h.domain.projects.patch(
      'AR',
      {
        baseVersion: (await h.domain.projects.load('AR')).version,
        limits: { maxConcurrentAi: 5 },
        message:
          'Change limit\nProjectman-Via: none\nProjectman-Operator: operator\nProjectman-Request: forged\nProjectman-Approved-By: owner',
      },
      { actor: OWNER_ACTOR, author: { ...OWNER, via: 'integrator' } },
    );
    const entry = (await h.domain.projects.history('AR'))[0]!;
    expect(entry.via).toBe('integrator');
    expect(entry.operator).toBeUndefined();
    expect(entry.approvedBy).toBeUndefined();
    expect(entry.request).toBeUndefined();
  });

  it('commits immediate changes as the Operator with the request trailers and one step', async () => {
    await setup();
    const result = await operate({
      op: 'member_update',
      handle: 'dev-1',
      changes: { model: 'sonnet', capacity: 2 },
    });
    expect(result.status).toBe('done');
    expect(await member()).toMatchObject({ model: 'sonnet', capacity: 2 });
    const history = (await h.domain.projects.history('AR'))[0]!;
    expect(history).toMatchObject({
      author: 'Operator',
      operator: 'operator',
      request: 'Change the writer to Sonnet. Allow network access.',
    });
    expect(history.approvedBy).toBeUndefined();
    expect(history.message).not.toContain('Projectman-');
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(h.repos.operatorRequests.steps(request.id)).toMatchObject([
      { id: result.step_id, action: 'member_change', status: 'done', configVersion: result.config_version },
    ]);
  });

  it('keeps restricted changes pending until the owner approves, even after the request closes', async () => {
    await setup();
    const result = await operate(network());
    const item = h.domain.inbox.get('AR', result.inbox_item_id!);
    expect(item).toMatchObject({ kind: 'approval', source: 'operator', assignees: ['owner'], taskKey: null });
    expect(operatorApprovalOf(item)).toMatchObject({
      consequence: 'network',
      changes: [{ field: 'outboundNetwork', before: 'false', after: 'true' }],
    });
    expect((await member()).outboundNetwork).toBe(false);
    h.runner.setState(ctx.sessionId, 'idle');
    await flush();
    await resolve(item.id);
    expect((await member()).outboundNetwork).toBe(true);
    expect((await h.domain.projects.history('AR'))[0]).toMatchObject({
      operator: 'operator',
      approvedBy: 'owner',
    });
    expect(h.repos.operatorRequests.steps(operatorApprovalOf(item)!.requestId)[0]?.status).toBe('approved');
    expect(h.repos.messages.pending('AR', 'operator').some((m) => m.body.includes('approved by owner'))).toBe(
      true,
    );
  });

  it('rejects without changing configuration or waking the Operator', async () => {
    await setup();
    const result = await operate(network());
    const version = (await h.domain.projects.load('AR')).version;
    await resolve(result.inbox_item_id!, 'reject');
    expect((await h.domain.projects.load('AR')).version).toBe(version);
    expect((await member()).outboundNetwork).toBe(false);
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(h.repos.operatorRequests.steps(request.id)[0]?.status).toBe('rejected');
    expect(h.repos.messages.pending('AR', 'operator').some((m) => m.body.includes('rejected'))).toBe(true);
  });

  it('marks a changed field stale proactively and permits only dismissal', async () => {
    await setup();
    const result = await operate(network());
    await h.domain.members.update('AR', 'dev-1', { outboundNetwork: true }, by);
    await flush();
    const item = h.domain.inbox.get('AR', result.inbox_item_id!);
    expect(operatorApprovalOf(item)?.stale?.reason).toBe('config_changed');
    expect(item.options.map((o) => o.id)).toEqual(['dismiss']);
    await expect(resolve(item.id)).rejects.toMatchObject({ code: 'operator_approval_stale', status: 409 });
    await expect(resolve(item.id, 'reject')).rejects.toMatchObject({ code: 'operator_approval_stale' });
    expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
    await resolve(item.id, 'dismiss');
    expect(h.domain.inbox.get('AR', item.id).state).toBe('resolved');
  });

  it('replays against current configuration when an unrelated field changed', async () => {
    await setup();
    const result = await operate(network());
    await h.domain.members.update('AR', 'dev-1', { model: 'sonnet' }, by);
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale).toBeNull();
    await resolve(result.inbox_item_id!);
    expect((await member()).outboundNetwork).toBe(true);
    expect((await member()).model).toBe('sonnet');
  });

  it('allows one of two concurrent decisions to execute only once', async () => {
    await setup();
    const result = await operate(network());
    const outcomes = await Promise.allSettled([
      resolve(result.inbox_item_id!),
      resolve(result.inbox_item_id!),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await h.domain.projects.history('AR')).filter((row) => row.approvedBy === 'owner')).toHaveLength(
      1,
    );
  });

  it('rechecks the approved rows at commit if state changes after the replay', async () => {
    await setup();
    const result = await operate(network());
    const execute = h.domain.operatorActions.execute.bind(h.domain.operatorActions);
    vi.spyOn(h.domain.operatorActions, 'execute').mockImplementationOnce(async (...args) => {
      await h.domain.members.update('AR', 'dev-1', { outboundNetwork: true }, by);
      return execute(...args);
    });
    await expect(resolve(result.inbox_item_id!)).rejects.toMatchObject({
      code: 'operator_approval_stale',
      status: 409,
    });
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale?.reason).toBe(
      'config_changed',
    );
    expect((await h.domain.projects.history('AR')).some((row) => row.approvedBy === 'owner')).toBe(false);
  });

  it('sets and removes the full test of a repository only after the owner approves (PM-538)', async () => {
    await setup();
    const reviewTest = { command: 'npm run merge-test', maxWorkers: 4, timeoutMinutes: 30 };
    const repo = async () => (await h.domain.projects.config('AR')).project.repos[0]!;
    const set = await operate({
      op: 'config_patch',
      patch: { repoReviewTest: [{ repo: 'web', reviewTest }] },
    });
    expect(set.status).toBe('awaiting_approval');
    const item = h.domain.inbox.get('AR', set.inbox_item_id!);
    expect(operatorApprovalOf(item)).toMatchObject({
      consequence: 'review_test',
      changes: [
        {
          area: 'repos',
          target: 'web',
          field: 'reviewTest',
          before: null,
          after: '{"command":"npm run merge-test","maxWorkers":4,"timeoutMinutes":30}',
          level: 'approval',
        },
      ],
    });
    expect(await repo()).not.toHaveProperty('reviewTest');
    await resolve(item.id);
    expect(await repo()).toMatchObject({ reviewTest });
    expect((await h.domain.projects.history('AR'))[0]).toMatchObject({
      operator: 'operator',
      approvedBy: 'owner',
    });

    const removed = await operate({
      op: 'config_patch',
      patch: { repoReviewTest: [{ repo: 'web', reviewTest: null }] },
    });
    expect(operatorApprovalOf(h.domain.inbox.get('AR', removed.inbox_item_id!))).toMatchObject({
      consequence: 'review_test',
      changes: [{ field: 'reviewTest', before: expect.stringContaining('merge-test'), after: null }],
    });
    await resolve(removed.inbox_item_id!);
    expect(await repo()).not.toHaveProperty('reviewTest');
  });

  it('asks for approval for fullTestAtMerge too, and refuses an unknown repository (PM-538)', async () => {
    await setup();
    const result = await operate({
      op: 'config_patch',
      patch: { repoFullTestAtMerge: [{ repo: 'web', fullTestAtMerge: true }] },
    });
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))).toMatchObject({
      consequence: 'review_test',
      changes: [{ field: 'fullTestAtMerge', after: 'true' }],
    });
    await expect(
      operate({
        op: 'config_patch',
        patch: { repoReviewTest: [{ repo: 'ghost', reviewTest: null }] },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('unknown_repo') });
  });

  it('does not let a non-owner approve a full test change (PM-538)', async () => {
    await setup();
    const result = await operate({
      op: 'config_patch',
      patch: {
        repoReviewTest: [{ repo: 'web', reviewTest: { command: 'true', maxWorkers: 2, timeoutMinutes: 15 } }],
      },
    });
    await expect(
      h.domain.inbox.resolve(
        'AR',
        result.inbox_item_id!,
        { optionId: 'approve' },
        { handle: 'dana', access: 'admin' },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      h.domain.inbox.resolve(
        'AR',
        result.inbox_item_id!,
        { optionId: 'approve' },
        { ...owner, via: 'integrator' },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await h.domain.projects.config('AR')).toMatchObject({ project: { repos: [{ name: 'web' }] } });
    expect((await h.domain.projects.config('AR')).project.repos[0]).not.toHaveProperty('reviewTest');
  });

  it('rejects integrator decisions and non-owner human decisions', async () => {
    await setup();
    const result = await operate(network());
    await expect(
      h.domain.inbox.resolve(
        'AR',
        result.inbox_item_id!,
        { optionId: 'approve' },
        { ...owner, via: 'integrator' },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      h.domain.inbox.resolve(
        'AR',
        result.inbox_item_id!,
        { optionId: 'approve' },
        { handle: 'dana', access: 'admin' },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect((await member()).outboundNetwork).toBe(false);
  });

  it('logs forbidden configuration operations and refuses other tool callers', async () => {
    await setup();
    await expect(operate({ op: 'member_retire', handle: 'operator' })).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('operator_never:'),
    });
    await expect(
      operate({ op: 'member_update', handle: 'operator', changes: { capacity: 2 } }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('operator_never:') });
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(h.repos.operatorRequests.steps(request.id).every((s) => s.status === 'refused')).toBe(true);
    await expect(
      h.domain.teamTools.operate({ ...ctx, member: 'dev-1' }, { title: 'Change', operation: network() }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('operator_only:') });
    await expect(
      h.domain.teamTools.startTask({ ...ctx, member: 'dev-1' }, { taskKey: 'AR-1' }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('operator_only:') });
  });

  it('requires an open owner request before either tool writes', async () => {
    await setup();
    h.runner.setState(ctx.sessionId, 'idle');
    await flush();
    await expect(operate(network())).rejects.toMatchObject({
      message: expect.stringContaining('operator_no_request:'),
    });
    await expect(h.domain.teamTools.startTask(ctx, { taskKey: 'AR-1' })).rejects.toMatchObject({
      message: expect.stringContaining('operator_no_request:'),
    });
  });

  it('marks stopping an ended session stale and forbids stopping itself', async () => {
    await setup();
    await h.domain.messaging.sendReporting('AR', 'owner', { to: ['dev-1'], text: 'Hello' });
    await flush();
    const target = h.domain.sessions.list('AR', { member: 'dev-1' })[0]!;
    const result = await operate({ op: 'session_stop', sessionId: target.id });
    await h.domain.sessions.stop('AR', target.id);
    await flush();
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale?.reason).toBe(
      'session_changed',
    );
    await expect(resolve(result.inbox_item_id!)).rejects.toMatchObject({ code: 'operator_approval_stale' });
    await expect(operate({ op: 'session_stop', sessionId: ctx.sessionId })).rejects.toMatchObject({
      message: expect.stringContaining('operator_never:'),
    });
  });

  it('stops a matching live session only after approval', async () => {
    await setup();
    await h.domain.messaging.sendReporting('AR', 'owner', { to: ['dev-1'], text: 'Hello' });
    await flush();
    const target = h.domain.sessions.list('AR', { member: 'dev-1' })[0]!;
    const result = await operate({ op: 'session_stop', sessionId: target.id });
    expect(h.domain.sessions.isRunning(target.id)).toBe(true);
    await resolve(result.inbox_item_id!);
    expect(h.domain.sessions.isRunning(target.id)).toBe(false);
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale).toBeNull();
  });

  it('makes pause approval stale when the pause state changes', async () => {
    await setup();
    const result = await operate({ op: 'project_pause' });
    await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'app' });
    await flush();
    expect(operatorApprovalOf(h.domain.inbox.get('AR', result.inbox_item_id!))?.stale?.reason).toBe(
      'pause_changed',
    );
    await expect(resolve(result.inbox_item_id!)).rejects.toMatchObject({ code: 'operator_approval_stale' });
  });

  it('pauses only after approval and resumes an approved matching pause', async () => {
    await setup();
    const pause = await operate({ op: 'project_pause' });
    expect(h.domain.pauses.isPaused('AR')).toBe(false);
    await resolve(pause.inbox_item_id!);
    expect(h.domain.pauses.isPaused('AR')).toBe(true);
    const resume = await operate({ op: 'project_resume' });
    await resolve(resume.inbox_item_id!);
    expect(h.domain.pauses.isPaused('AR')).toBe(false);
  });

  it('hires and retires through the existing member service after approval', async () => {
    await setup();
    const hire = await operate({ op: 'member_hire', request: { role: 'developer', handle: 'writer' } });
    expect(memberOf(await h.domain.projects.config('AR'), 'writer')).toBeUndefined();
    await resolve(hire.inbox_item_id!);
    expect(await member('writer')).toMatchObject({ role: 'developer', sponsor: 'owner' });
    const retire = await operate({ op: 'member_retire', handle: 'writer' });
    await resolve(retire.inbox_item_id!);
    expect(memberOf(await h.domain.projects.config('AR'), 'writer')).toBeUndefined();
  });

  it('judges a revert by its resulting changes and attributes the new commit', async () => {
    await setup();
    const version = (await h.domain.projects.load('AR')).version;
    await h.domain.members.update('AR', 'dev-1', { model: 'sonnet' }, by);
    const now = await operate({ op: 'config_revert', version });
    expect(now.status).toBe('done');
    await h.domain.members.update('AR', 'dev-1', { outboundNetwork: true }, by);
    const approval = await operate({ op: 'config_revert', version });
    expect(approval.status).toBe('awaiting_approval');
    await resolve(approval.inbox_item_id!);
    expect((await member()).outboundNetwork).toBe(false);
    expect((await h.domain.projects.history('AR'))[0]).toMatchObject({
      operator: 'operator',
      approvedBy: 'owner',
    });
  });

  it('preserves approval proposals and decisions across a server restart', async () => {
    await setup(true);
    const result = await operate(network());
    h = await restartDomainHarness(h);
    await resolve(result.inbox_item_id!);
    expect((await member()).outboundNetwork).toBe(true);
  });

  it('starts ready work and restarts a stalled work-stage task', async () => {
    await setup();
    const task = await h.domain.tasks.create('AR', { title: 'Write', stageId: 'ready' }, OWNER_ACTOR);
    const first = await h.domain.teamTools.startTask(ctx, { taskKey: task.key, assignee: 'dev-1' });
    expect(first.session_id).toBeTruthy();
    expect(first.assignee).toBe('dev-1');
    expect(h.domain.tasks.get('AR', task.key).stageId).toBe('development');
    await h.domain.sessions.stop('AR', first.session_id!);
    const second = await h.domain.teamTools.startTask(ctx, { taskKey: task.key });
    expect(second.session_id).toBeTruthy();
    expect(h.domain.sessions.isRunning(second.session_id!)).toBe(true);
  });

  it('names a refused leave start and records no waiting start', async () => {
    await setup(false, (config) => {
      (memberOf(config, 'dev-1') as AiMemberConfig).onLeave = true;
    });
    const task = await h.domain.tasks.create('AR', { title: 'Write', stageId: 'ready' }, OWNER_ACTOR);
    await expect(
      h.domain.teamTools.startTask(ctx, { taskKey: task.key, assignee: 'dev-1' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('member_on_leave') });
    expect(h.domain.tasks.get('AR', task.key)).toMatchObject({ stageId: 'ready', assignee: null });
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(h.repos.operatorRequests.steps(request.id).at(-1)).toMatchObject({
      action: 'task_start',
      status: 'refused',
      refusal: { code: 'member_on_leave' },
    });
  });

  it('reports which Senior the card waits for without assigning a developer', async () => {
    await setup(false, (config) => {
      (memberOf(config, 'dev-2') as AiMemberConfig).senior = true;
    });
    const busy = await h.domain.tasks.create('AR', { title: 'Busy', stageId: 'ready' }, OWNER_ACTOR);
    await h.domain.teamTools.startTask(ctx, { taskKey: busy.key, assignee: 'dev-2' });
    const task = await h.domain.tasks.create(
      'AR',
      {
        title: 'Senior work',
        stageId: 'ready',
        developerLevel: { level: 'senior', reason: 'Runner changes' },
      },
      OWNER_ACTOR,
    );
    const result = await h.domain.teamTools.startTask(ctx, { taskKey: task.key });
    expect(result).toMatchObject({ assignee: null, session_id: null, senior_wait: { seniors: ['dev-2'] } });
  });

  it('honors the explicit prerequisite override only for the owner-requested Operator start', async () => {
    await setup();
    const task = await h.domain.tasks.create('AR', { title: 'Dependent', stageId: 'ready' }, OWNER_ACTOR);
    const prerequisite = await h.domain.tasks.create('AR', { title: 'First' }, OWNER_ACTOR);
    await h.domain.tasks.update(
      'AR',
      task.key,
      { relations: { add: [{ kind: 'prerequisite', key: prerequisite.key }] } },
      OWNER_ACTOR,
    );
    await expect(h.domain.teamTools.startTask(ctx, { taskKey: task.key })).rejects.toThrow();
    const result = await h.domain.teamTools.startTask(ctx, { taskKey: task.key, despitePrerequisites: true });
    expect(result.session_id).toBeTruthy();
  });

  it('starts AI gate setters and waits for their label', async () => {
    await setup(false, (config) => {
      config.team.members.push({
        kind: 'ai',
        handle: 'des',
        displayName: 'Designer',
        role: 'designer',
        sponsor: 'owner',
        model: 'sonnet',
        capacity: 1,
        temp: false,
        permissionMode: 'auto',
        instructions: '',
      });
      config.pipeline.labels.push({
        id: 'design-ok',
        name: 'Design ready',
        setBy: { duties: ['ux_design'] },
      });
      config.pipeline.stages.find((s) => s.id === 'development')!.gate = {
        conditions: [{ type: 'has_label', label: 'design-ok' }],
      };
    });
    const task = await h.domain.tasks.create('AR', { title: 'Screen', stageId: 'ready' }, OWNER_ACTOR);
    const result = await h.domain.teamTools.startTask(ctx, { taskKey: task.key });
    expect(result.session_id).toBeNull();
    expect(result.awaiting).toEqual({ labels: ['design-ok'], members: ['des'] });
    expect(result.assignee).toBeNull();
    expect(h.domain.sessions.list('AR', { taskKey: task.key }).map((s) => s.member)).toEqual(['des']);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toMatchObject({
      reason: 'label_missing',
    });
  });

  it('refuses a fix-limit hold without granting another fix round', async () => {
    await setup();
    const task = await h.domain.tasks.create('AR', { title: 'Fix', stageId: 'ready' }, OWNER_ACTOR);
    h.repos.taskFixLimits.save({
      taskKey: task.key,
      projectKey: 'AR',
      countedFrom: null,
      extraRounds: 0,
      holdPhase: 'owner',
      heldAt: new Date().toISOString(),
      decider: null,
      deciders: ['owner'],
      reason: 'again',
      inboxItemId: null,
    });
    await expect(h.domain.teamTools.startTask(ctx, { taskKey: task.key })).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('the Operator cannot start'),
    });
    expect(h.repos.taskFixLimits.get(task.key)?.extraRounds).toBe(0);
  });

  it('hires a policy-limited temp worker as the system and names it in the start step', async () => {
    await setup(false, (config) => {
      (memberOf(config, 'dev-1') as AiMemberConfig).onLeave = true;
      (memberOf(config, 'dev-2') as AiMemberConfig).onLeave = true;
      config.team.limits.tempWorkers = { enabled: true, max: 1, role: 'developer' };
    });
    const task = await h.domain.tasks.create(
      'AR',
      { title: 'Temporary work', stageId: 'ready' },
      OWNER_ACTOR,
    );
    const result = await h.domain.teamTools.startTask(ctx, { taskKey: task.key });
    expect(result.hired).toBeTruthy();
    expect(await member(result.hired!)).toMatchObject({ temp: true, sponsor: 'owner' });
    const request = h.repos.operatorRequests.latest('AR', 1)[0]!;
    expect(h.repos.operatorRequests.steps(request.id).at(-1)).toMatchObject({
      action: 'task_start',
      status: 'done',
      member: result.hired,
    });
    expect(h.domain.timeline.list('AR').find((e) => e.type === 'member_hired')?.actor.kind).toBe('system');
    const next = await h.domain.tasks.create('AR', { title: 'No more temps', stageId: 'ready' }, OWNER_ACTOR);
    await expect(h.domain.teamTools.startTask(ctx, { taskKey: next.key })).rejects.toThrow();
    expect(
      (await h.domain.projects.config('AR')).team.members.filter((m) => m.kind === 'ai' && m.temp),
    ).toHaveLength(1);
  });
});
