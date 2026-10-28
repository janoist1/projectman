import { afterEach, describe, expect, it, vi } from 'vitest';
import { PatternFacts, structuralReviewOf, coordinatorSuperActorOf } from '@projectman/shared';
import type { AiMemberConfig, TimelineEvent } from '@projectman/shared';
import type { IntegratorExecutionScope, MemberStartResult } from '../src/contracts';
import { forbidden, runIntegratorExecution } from '../src/kernel';
import { StructuralPatterns, normalizedEvidencePath } from '../src/services/operator/structural-patterns';
import { CoordinationRequests, StructuralReviews } from '../src/services/operator';
import { OperatorTools } from '../src/mcp/operator/handler';
import {
  createDomainHarness,
  OWNER_ACTOR,
  restartDomainHarness,
  waitForSession,
} from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { seedOperatorSession } from './helpers/operator-session';

let h: DomainHarness;
let now: Date;
let sequence = 0;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});
async function setup(architect = true, armed = true) {
  now = new Date('2026-10-16T09:00:00Z');
  h = await createDomainHarness({
    persistent: true,
    screenQuestions: true,
    now: () => now,
    adjust: (config) => {
      (config.team.members.find((m) => m.handle === 'pm') as AiMemberConfig).onLeave = false;
      config.team.operatorWatch = 'drive';
      if (architect)
        config.team.members.push({
          ...(config.team.members.find((m) => m.handle === 'dev-1') as AiMemberConfig),
          handle: 'planner',
          role: 'architect',
          capacity: 2,
        });
      config.team.members.push({
        kind: 'human',
        handle: 'admin',
        displayName: 'Admin',
        access: 'admin',
        roles: [],
      });
    },
  });
  if (armed)
    for (const kind of ['structural_pattern', 'milestone_closed'] as const)
      h.repos.operatorSignals.arm('AR', kind, '2026-10-01T00:00:00.000Z');
}
const config = () => h.domain.projects.cachedConfig('AR')!;
const report = () => new StructuralPatterns(h.domain.ctx).report(config());
const signals = () => h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'structural_pattern');
const requests = () => new CoordinationRequests({ ctx: h.domain.ctx, projects: h.domain.projects });
const card = (title = 'Evidence card') => h.domain.tasks.create('AR', { title, repo: 'web' }, OWNER_ACTOR);
function evidence(taskKey: string, type: TimelineEvent['type'], data: Record<string, unknown>, at = now) {
  const event: TimelineEvent = {
    id: `evt_structural_${++sequence}`,
    projectKey: 'AR',
    taskKey,
    sessionId: null,
    actor: { kind: 'system', handle: null },
    type,
    data,
    createdAt: at.toISOString(),
  };
  h.repos.timeline.insert(event);
  return event;
}
function failure(key: string, files: string[] | undefined = ['src/rule.test.ts'], repo = 'web', at = now) {
  return evidence(
    key,
    'task_full_test',
    { outcome: 'failed', repo, failedFiles: files, outputTail: 'FAIL src/guessed.test.ts' },
    at,
  );
}
async function detected() {
  const a = await card();
  const b = await card();
  failure(a.key);
  failure(b.key);
  await h.domain.operatorSignals.sweep('AR');
  await flush();
  const session = await waitForSession(h.domain, { member: 'pm' });
  h.runner.setState(session.id, 'idle');
  await flush();
  return {
    a,
    b,
    signal: signals()[0]!,
    ctx: { projectKey: 'AR', sessionId: session.id, member: 'pm', taskKey: null },
  };
}

describe('structured pattern evidence', () => {
  it('arms on the first sweep, skips old evidence and preserves the boundary after restart', async () => {
    await setup(true, false);
    const a = await card();
    const b = await card();
    const old = new Date(now.getTime() - 60_000);
    failure(a.key, undefined, 'web', old);
    failure(b.key, undefined, 'web', old);
    const theme = await h.domain.tasks.create('AR', { title: 'Theme', kind: 'theme' }, OWNER_ACTOR);
    evidence(theme.key, 'task_updated', { action: 'closed', previousStatus: 'active' }, old);
    const reads = vi.spyOn(h.repos.timeline, 'structuralEvidence');
    expect(report()).toEqual({ patterns: [], milestones: [] });
    expect(reads).not.toHaveBeenCalled();
    await h.domain.operatorSignals.sweep('AR');
    expect(signals()).toHaveLength(0);
    expect(h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'milestone_closed')).toHaveLength(0);
    const armedAt = now.toISOString();
    for (const kind of ['structural_pattern', 'milestone_closed'] as const)
      expect(h.repos.operatorSignals.armedAt('AR', kind)).toBe(armedAt);
    now = new Date(now.getTime() + 1000);
    failure(a.key);
    expect(report().patterns).toEqual([]); // One old and one new card never form a pattern.
    failure(b.key);
    evidence(theme.key, 'task_updated', { action: 'closed', previousStatus: 'active' });
    await h.domain.operatorSignals.sweep('AR');
    expect(signals()).toHaveLength(1);
    expect(h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'milestone_closed')).toHaveLength(1);
    h = await restartDomainHarness(h, { now: () => now });
    await h.domain.operatorSignals.sweep('AR');
    expect(signals()).toHaveLength(1);
    expect(h.repos.operatorSignals.arm('AR', 'structural_pattern', now.toISOString())).toBe(armedAt);
    expect(h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'milestone_closed')).toHaveLength(1);
    now = new Date(now.getTime() + 8 * 24 * 60 * 60_000);
    await h.domain.operatorSignals.sweep('AR');
    expect(signals()[0]).toMatchObject({ state: 'resolved', resolvedAt: now.toISOString() });
  });

  it('uses separate activation boundaries for patterns and milestones', async () => {
    await setup(true, false);
    const a = await card();
    const b = await card();
    const theme = await h.domain.tasks.create('AR', { title: 'Theme', kind: 'theme' }, OWNER_ACTOR);
    h.repos.operatorSignals.arm('AR', 'milestone_closed', new Date(now.getTime() - 1000).toISOString());
    failure(a.key);
    failure(b.key);
    evidence(theme.key, 'task_updated', { action: 'closed', previousStatus: 'active' });
    expect(report().patterns).toEqual([]);
    expect(report().milestones).toHaveLength(1);
    now = new Date(now.getTime() + 1000);
    h.repos.operatorSignals.arm('AR', 'structural_pattern', now.toISOString());
    expect(report().patterns).toEqual([]);
    expect(report().milestones).toHaveLength(1);
  });

  it('groups independent cards by repository and normalized file, never retries or raw output', async () => {
    await setup();
    const a = await card();
    const b = await card();
    failure(a.key, ['./src/a/../rule.test.ts']);
    failure(a.key);
    evidence(b.key, 'task_full_test', {
      outcome: 'failed',
      repo: 'web',
      outputTail: 'FAIL src/rule.test.ts',
    });
    expect(report().patterns).toEqual([]);
    failure(b.key, ['src/rule.test.ts'], 'other');
    expect(report().patterns).toEqual([]);
    const event = failure(b.key, ['src\\rule.test.ts']);
    expect(report().patterns).toMatchObject([
      { kind: 'failed_test_file', taskKeys: [a.key, b.key], eventIds: expect.arrayContaining([event.id]) },
    ]);
    expect(PatternFacts.safeParse({ ...report().patterns[0], guessed: true }).success).toBe(false);
    for (const path of ['/tmp/a', '../a', 'C:\\a', '', 'a/../../b'])
      expect(normalizedEvidencePath(path)).toBeNull();
  });

  it('uses conflict file metadata and the recorded merge repository, including closed cards', async () => {
    await setup();
    const a = await card();
    const b = await card();
    for (const task of [a, b]) {
      evidence(task.key, 'task_merge_requested', { mergeId: task.key, repo: 'web' });
      evidence(task.key, 'task_merge_failed', {
        mergeId: task.key,
        reason: 'conflict',
        files: ['./src/shared.ts'],
      });
      h.repos.tasks.update(task.id, { status: 'done' });
    }
    expect(report().patterns).toMatchObject([{ kind: 'conflict_file', taskKeys: [a.key, b.key] }]);
  });

  it('requires three fix rounds on each of two cards within the seven-day window', async () => {
    await setup();
    const a = await card();
    const b = await card();
    for (const task of [a, b])
      for (let i = 0; i < 2; i++)
        evidence(task.key, 'task_labels_changed', { added: ['code-review-changes'] });
    evidence(a.key, 'task_stage_changed', { from: 'code_review', to: 'development' });
    expect(report().patterns).toEqual([]);
    evidence(b.key, 'task_labels_changed', { added: ['design-review-changes'] });
    expect(report().patterns).toMatchObject([{ kind: 'fix_rounds', taskKeys: [a.key, b.key] }]);
    now = new Date(now.getTime() + 7 * 24 * 60 * 60_000 + 1);
    expect(report().patterns).toEqual([]);
  });

  it('persists duplicate suppression and daily delivery limits through restart', async () => {
    await setup();
    const { a, b, signal } = await detected();
    expect(signal.deliveredAt).toBeTruthy();
    const facts = h.domain.operatorSignals.structuralFacts(signal);
    now = new Date(now.getTime() + 60_000);
    failure(a.key);
    failure(b.key);
    failure(a.key, ['src/another.test.ts']);
    failure(b.key, ['src/another.test.ts']);
    await h.domain.operatorSignals.sweep('AR');
    expect(signals()).toHaveLength(2);
    expect(signals().filter((s) => s.deliveredAt)).toHaveLength(1);
    h = await restartDomainHarness(h, { now: () => now });
    await h.domain.operatorSignals.sweep('AR');
    expect(signals()).toHaveLength(2);
    expect(signals().filter((s) => s.deliveredAt)).toHaveLength(1);
    expect(h.domain.operatorSignals.structuralFacts(signal)).toEqual(facts);
    now = new Date(now.getTime() + 24 * 60 * 60_000);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    expect(signals().filter((s) => s.deliveredAt)).toHaveLength(2);
  });

  it('recognizes real theme and collecting closure, never an ordinary card completion', async () => {
    await setup();
    const ordinary = await card();
    evidence(ordinary.key, 'task_stage_changed', { from: 'development', to: 'done' });
    expect(report().milestones).toEqual([]);
    const theme = await h.domain.tasks.create('AR', { title: 'Theme', kind: 'theme' }, OWNER_ACTOR);
    evidence(theme.key, 'task_updated', { action: 'closed', previousStatus: 'active' });
    const a = await card();
    const b = await card();
    h.repos.tasks.update(a.id, { parentKey: ordinary.key });
    h.repos.tasks.update(b.id, { parentKey: ordinary.key });
    evidence(a.key, 'task_stage_changed', { from: 'development', to: 'done' });
    expect(report().milestones).toHaveLength(1);
    const final = evidence(b.key, 'task_stage_changed', { from: 'development', to: 'done' });
    expect(report().milestones).toHaveLength(2);
    expect(report().milestones).toContainEqual({ taskKey: ordinary.key, eventId: final.id });
    await h.domain.operatorSignals.sweep('AR');
    await h.domain.operatorSignals.sweep('AR');
    expect(h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'milestone_closed')).toHaveLength(2);
  });

  it("does not infer a milestone from today's sibling statuses or a final cancellation", async () => {
    await setup();
    const parent = await card();
    const a = await card();
    const b = await card();
    h.repos.tasks.update(a.id, { parentKey: parent.key, status: 'done' });
    h.repos.tasks.update(b.id, { parentKey: parent.key, status: 'done' });
    evidence(a.key, 'task_stage_changed', { from: 'development', to: 'done' });
    expect(report().milestones).toEqual([]);
    evidence(b.key, 'task_updated', { action: 'cancelled', previousStatus: 'active' });
    expect(report().milestones).toEqual([]);
  });
});

describe('owner-approved occasional review', () => {
  it('rechecks changed evidence when the owner actually approves', async () => {
    await setup();
    const { ctx, signal, b } = await detected();
    const proposal = await h.domain.teamTools.requestStructuralReview(ctx, {
      signalId: signal.id,
      note: 'Review.',
    });
    h.repos.db
      .prepare("DELETE FROM timeline_events WHERE task_key = ? AND type = 'task_full_test'")
      .run(b.key);
    await expect(
      h.domain.inbox.resolve(
        'AR',
        proposal.inbox_item_id!,
        { optionId: 'approve' },
        { handle: 'owner', access: 'owner' },
      ),
    ).rejects.toThrow('signal');
    expect(h.domain.sessions.list('AR', { member: 'planner' })).toEqual([]);
  });

  it.each(['timeline', 'expiry', 'config'] as const)(
    'rechecks %s at assertStart after the review request awaits',
    async (change) => {
      await setup();
      const { ctx, signal, b } = await detected();
      if (change === 'expiry') now = new Date(now.getTime() + 7 * 24 * 60 * 60_000 - 1);
      const proposal = await h.domain.teamTools.requestStructuralReview(ctx, {
        signalId: signal.id,
        note: 'Review.',
      });
      await h.domain.inbox.resolve(
        'AR',
        proposal.inbox_item_id!,
        { optionId: 'approve' },
        { handle: 'owner', access: 'owner' },
      );
      await flush();
      const original = OperatorTools.prototype.startMember;
      vi.spyOn(OperatorTools.prototype, 'startMember').mockImplementationOnce(async function (
        this: OperatorTools,
        ctx,
        args,
      ) {
        await Promise.resolve();
        if (change === 'timeline')
          h.repos.db
            .prepare("DELETE FROM timeline_events WHERE task_key = ? AND type = 'task_full_test'")
            .run(b.key);
        else if (change === 'expiry') now = new Date(now.getTime() + 1);
        else
          (config().team.members.find((member) => member.handle === 'planner') as AiMemberConfig).onLeave =
            true;
        return original.call(this, ctx, args);
      });
      await expect(
        h.domain.teamTools.requestStructuralReview(ctx, { signalId: signal.id, note: 'Review.' }),
      ).rejects.toThrow('operator_signal_closed');
      expect(h.domain.sessions.list('AR', { member: 'planner' })).toEqual([]);
      expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).toBeNull();
    },
  );

  it('keeps an approved signal open after a failed start so the PM can retry', async () => {
    await setup();
    const { ctx, signal } = await detected();
    const proposal = await h.domain.teamTools.requestStructuralReview(ctx, {
      signalId: signal.id,
      note: 'Review the repeated failure.',
    });
    await h.domain.inbox.resolve(
      'AR',
      proposal.inbox_item_id!,
      { optionId: 'approve' },
      { handle: 'owner', access: 'owner' },
    );
    await flush();
    const start = vi.spyOn(OperatorTools.prototype, 'startMember').mockResolvedValueOnce({
      messageId: 'msg_failed_review',
      recipient: { handle: 'planner', delivery: 'wake', start: { state: 'failed', code: 'start_failed' } },
    });
    expect(
      await h.domain.teamTools.requestStructuralReview(ctx, { signalId: signal.id, note: 'Review.' }),
    ).toMatchObject({ status: 'failed' });
    expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).toBeNull();
    expect(h.repos.operatorRequests.stepsOfSignal(signal.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'structural_review',
          status: 'refused',
          refusal: { code: 'session_start_failed', message: 'start_failed' },
        }),
      ]),
    );
    start.mockRestore();
    expect(
      await h.domain.teamTools.requestStructuralReview(ctx, { signalId: signal.id, note: 'Retry.' }),
    ).toMatchObject({ status: 'started' });
    expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).not.toBeNull();
  });

  it('uses a fresh eligible duty holder after approval and holds while all holders are unavailable', async () => {
    await setup();
    const { ctx, signal } = await detected();
    const proposal = await h.domain.teamTools.requestStructuralReview(ctx, {
      signalId: signal.id,
      note: 'Review the repeated failure.',
    });
    await h.domain.inbox.resolve(
      'AR',
      proposal.inbox_item_id!,
      { optionId: 'approve' },
      { handle: 'owner', access: 'owner' },
    );
    await flush();
    const planner = config().team.members.find((m) => m.handle === 'planner') as AiMemberConfig;
    planner.onLeave = true;
    expect(
      await h.domain.teamTools.requestStructuralReview(ctx, { signalId: signal.id, note: 'Review.' }),
    ).toMatchObject({ status: 'held', member: null });
    config().team.members.push({ ...planner, handle: 'fresh-planner', onLeave: false });
    expect(
      await h.domain.teamTools.requestStructuralReview(ctx, { signalId: signal.id, note: 'Review.' }),
    ).toMatchObject({ status: 'started', member: 'fresh-planner' });
  });

  it('uses an explicit owner request directly and records the originating request', async () => {
    await setup();
    const { ctx, signal } = await detected();
    await h.domain.messaging.sendReporting(
      'AR',
      'owner',
      { to: ['pm'], text: 'Please arrange the architecture review.' },
      { awaitWake: true },
    );
    await flush();
    const request = requests().openFor(ctx.sessionId)!;
    expect(request.source).toBe('message');
    const result = await h.domain.teamTools.requestStructuralReview(ctx, {
      signalId: signal.id,
      note: 'Owner requested this review.',
    });
    expect(result).toMatchObject({ status: 'started', inbox_item_id: null });
    expect(h.repos.messages.get(result.message_id!)?.operatorRequest).toBe(request.id);
    expect(h.repos.operatorRequests.stepsOfSignal(signal.id)).toMatchObject([
      { action: 'structural_review', requestId: request.id },
    ]);
  });

  it('refuses owner presentation and lets the PM close report-only signals with a note', async () => {
    await setup();
    const { ctx, signal } = await detected();
    await expect(
      h.domain.teamTools.sendMessage(ctx, {
        to: ['owner'],
        kind: 'info',
        text: 'A review may help.',
        signalIds: [signal.id],
        actionableSignalIds: [signal.id],
      }),
    ).rejects.toThrow('for you only');
    expect(h.repos.operatorSignals.get(signal.id)?.actionable).toBe(false);
    await expect(
      h.domain.messaging.sendReporting(
        'AR',
        'owner',
        { to: ['pm'], text: 'Yes.' },
        { actor: OWNER_ACTOR, operatorSignal: signal.id },
      ),
    ).rejects.toThrow('signal');
    expect(requests().openFor(ctx.sessionId)).toBeNull();
    await expect(
      h.domain.teamTools.dismissSignal(ctx, { signalId: signal.id, note: 'No review needed.' }),
    ).resolves.toEqual({ signalId: signal.id, state: 'dismissed' });
    expect(h.repos.operatorSignals.get(signal.id)).toMatchObject({
      state: 'dismissed',
      decisionNote: 'No review needed.',
    });
  });

  it('only proposes before approval, rejects an integrator/admin, and continues only the PM request', async () => {
    await setup();
    const { ctx, signal } = await detected();
    const result = await h.domain.teamTools.requestStructuralReview(ctx, {
      signalId: signal.id,
      note: 'Repeated boundary failures.',
    });
    expect(result).toMatchObject({ status: 'awaiting_approval', member: 'planner', message_id: null });
    expect(h.domain.sessions.list('AR', { member: 'planner' })).toEqual([]);
    const item = h.repos.inbox.get(result.inbox_item_id!)!;
    expect(item).toMatchObject({ kind: 'question', state: 'open', source: 'pm' });
    expect(structuralReviewOf(item)?.evidence?.taskKeys).toHaveLength(2);
    expect(
      await h.domain.teamTools.requestStructuralReview(ctx, { signalId: signal.id, note: 'Retry.' }),
    ).toEqual(result);
    for (const by of [
      { handle: 'owner', access: 'owner' as const, via: 'integrator' as const },
      { handle: 'admin', access: 'admin' as const },
    ])
      await expect(h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, by)).rejects.toMatchObject({
        status: 403,
      });
    await h.domain.inbox.resolve(
      'AR',
      item.id,
      { optionId: 'approve' },
      { handle: 'owner', access: 'owner' },
    );
    await flush();
    expect(h.domain.sessions.list('AR', { member: 'planner' })).toEqual([]);
    expect(requests().openFor(ctx.sessionId)).toMatchObject({ source: 'approval', inboxItemId: item.id });
    await expect(
      h.domain.teamTools.startMember(ctx, { member: 'dev-1', text: 'Unrelated work.' }),
    ).rejects.toThrow('changed');
    const started = await h.domain.teamTools.requestStructuralReview(ctx, {
      signalId: signal.id,
      note: 'Changed AI note is ignored.',
    });
    expect(started.status).toBe('started');
    expect(h.repos.messages.get(started.message_id!)?.body).toContain('Repeated boundary failures.');
    expect(h.repos.messages.get(started.message_id!)?.operatorRequest).toBe(
      requests().openFor(ctx.sessionId)?.id,
    );
    await expect(
      h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, { handle: 'owner', access: 'owner' }),
    ).rejects.toThrow('resolved');
    await expect(
      h.domain.teamTools.requestStructuralReview(ctx, { signalId: signal.id, note: 'Again.' }),
    ).rejects.toThrow('operator_signal_closed');
  });

  it('holds when no technical direction holder exists or its capacity is occupied by other work', async () => {
    await setup(false);
    const { ctx, signal, a } = await detected();
    expect(
      await h.domain.teamTools.requestStructuralReview(ctx, { signalId: signal.id, note: 'Review.' }),
    ).toMatchObject({ status: 'held', member: null });
    const ai = config().team.members.find((m) => m.handle === 'dev-1') as AiMemberConfig;
    ai.role = 'architect';
    ai.capacity = 2;
    await h.domain.sessions.ensureSession('AR', ai.handle, { type: 'task', taskKey: a.key });
    expect(
      await h.domain.teamTools.requestStructuralReview(ctx, { signalId: signal.id, note: 'Review.' }),
    ).toMatchObject({ status: 'held', member: null });
  });

  it('rechecks signal freshness after approval and prevents ordinary signal starts even at drive level', async () => {
    await setup();
    const { ctx, signal } = await detected();
    await expect(
      h.domain.teamTools.startMember(ctx, { member: 'planner', text: 'Review.', signalId: signal.id }),
    ).rejects.toThrow('does not allow');
    const result = await h.domain.teamTools.requestStructuralReview(ctx, {
      signalId: signal.id,
      note: 'Review.',
    });
    now = new Date(now.getTime() + 8 * 24 * 60 * 60_000);
    await expect(
      h.domain.inbox.resolve(
        'AR',
        result.inbox_item_id!,
        { optionId: 'approve' },
        { handle: 'owner', access: 'owner' },
      ),
    ).rejects.toThrow('signal');
    const other = seedOperatorSession(h, 'AR', { member: 'dev-1' });
    await expect(
      h.domain.teamTools.requestStructuralReview(
        { ...ctx, sessionId: other.id, member: 'dev-1' },
        { signalId: signal.id, note: 'Review.' },
      ),
    ).rejects.toThrow('project_manager_only');
  });
});

describe('the integrator in super mode requests a review (PM-784)', () => {
  const KEY = { id: 'ikey_one', prefix: 'pmi_abcdefgh' };
  /** One service per harness, so that its running requests are shared by the calls of a test. */
  let cached: { harness: DomainHarness; reviews: StructuralReviews } | null = null;
  const reviews = () => {
    if (cached?.harness !== h)
      cached = {
        harness: h,
        reviews: new StructuralReviews({
          ctx: h.domain.ctx,
          projects: h.domain.projects,
          inbox: {} as never,
          signals: h.domain.operatorSignals,
          requests: requests(),
          steps: {} as never,
          admission: { memberLoad: () => 0 },
        }),
      };
    return cached.reviews;
  };
  /** A live scope of a key, as the authenticated facade makes it; `revoked` turns true when the key goes. */
  function scope(mode: 'super' | 'read' = 'super', revoked: () => boolean = () => false) {
    const actor = coordinatorSuperActorOf(config(), KEY)!;
    return {
      active: true,
      context: {
        principal: {
          kind: 'integrator' as const,
          userId: 'usr_owner',
          keyId: KEY.id,
          prefix: KEY.prefix,
          mode,
        },
        projectKey: 'AR',
        actor,
        requestId: 'req-review-1',
      },
      actorFor: () => {
        if (revoked()) throw forbidden('insufficient_access', 'the key was revoked');
        return actor;
      },
      assertAccess: () => undefined,
      assertMutation: () => {},
      authorizeMutation: async () => {},
    } satisfies IntegratorExecutionScope;
  }
  /** The member start the assembly makes; `state` and `delivery` are what the start answered. */
  const startWith = (state?: 'failed' | 'waiting', delivery: 'wake' | 'held' = 'wake') =>
    vi.fn(
      async (member: string, _text: string) =>
        ({
          messageId: 'msg_external_review',
          recipient: {
            handle: member,
            delivery,
            ...(state ? { start: { state, ...(state === 'failed' ? { code: 'start_failed' } : {}) } } : {}),
          },
        }) as MemberStartResult,
    );
  const request = (
    signalId: string,
    start: ReturnType<typeof startWith>,
    over: { scope?: ReturnType<typeof scope> | null } = {},
  ) => {
    const call = () => reviews().requestExternal('AR', signalId, 'Please review.', start);
    return over.scope === null ? call() : runIntegratorExecution(over.scope ?? scope(), call);
  };
  const questions = () => h.domain.inbox.list('AR', { kind: 'question' });

  it('starts the review of a current signal as the project manager, with no approval request and no session of its own', async () => {
    await setup();
    const { signal } = await detected();
    const asked = questions().length;
    const sessions = h.domain.sessions.list('AR', { member: 'pm' }).length;
    const start = startWith();
    expect(await request(signal.id, start)).toEqual({
      status: 'started',
      member: 'planner',
      message_id: 'msg_external_review',
      inbox_item_id: null,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0]).toBe('planner');
    expect(start.mock.calls[0]![1]).toContain('Reason: Please review.');
    expect(start.mock.calls[0]![1]).toContain('failed_test_file');
    expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).not.toBeNull();
    expect(questions()).toHaveLength(asked);
    expect(h.domain.sessions.list('AR', { member: 'pm' })).toHaveLength(sessions);
    expect(h.repos.operatorRequests.stepsOfSignal(signal.id)).toEqual([]);
  });

  it('keeps the signal open after a failed start, and the retry then starts', async () => {
    await setup();
    const { signal } = await detected();
    expect(await request(signal.id, startWith('failed'))).toMatchObject({
      status: 'failed',
      member: 'planner',
    });
    expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).toBeNull();
    expect(await request(signal.id, startWith())).toMatchObject({ status: 'started' });
    expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).not.toBeNull();
  });

  it.each([
    ['waiting', startWith('waiting'), 'waiting'],
    ['held', startWith(undefined, 'held'), 'held'],
  ] as const)('reports a %s start as it is', async (_name, start, status) => {
    await setup();
    const { signal } = await detected();
    expect(await request(signal.id, start)).toMatchObject({ status, member: 'planner' });
  });

  it('holds while nobody is free, and starts nothing', async () => {
    await setup();
    const { signal } = await detected();
    (config().team.members.find((m) => m.handle === 'planner') as AiMemberConfig).onLeave = true;
    const start = startWith();
    expect(await request(signal.id, start)).toEqual({
      status: 'held',
      member: null,
      message_id: null,
      inbox_item_id: null,
    });
    expect(start).not.toHaveBeenCalled();
    expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).toBeNull();
  });

  it('never bypasses an approval request that is waiting or was decided', async () => {
    await setup();
    const { ctx, signal } = await detected();
    const proposal = await h.domain.teamTools.requestStructuralReview(ctx, {
      signalId: signal.id,
      note: 'Review the repeated failure.',
    });
    expect(proposal.status).toBe('awaiting_approval');
    const start = startWith();
    expect(await request(signal.id, start)).toEqual({
      status: 'awaiting_approval',
      member: 'planner',
      message_id: null,
      inbox_item_id: proposal.inbox_item_id,
    });
    await h.domain.inbox.resolve(
      'AR',
      proposal.inbox_item_id!,
      { optionId: 'reject' },
      { handle: 'owner', access: 'owner' },
    );
    expect(await request(signal.id, start)).toMatchObject({
      status: 'held',
      inbox_item_id: proposal.inbox_item_id,
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses an unknown or an expired signal and one whose evidence is gone', async () => {
    await setup();
    const { signal, b } = await detected();
    const start = startWith();
    await expect(request('sig_missing', start)).rejects.toMatchObject({ code: 'invalid_request' });
    h.repos.db
      .prepare("DELETE FROM timeline_events WHERE task_key = ? AND type = 'task_full_test'")
      .run(b.key);
    await expect(request(signal.id, start)).rejects.toMatchObject({ code: 'operator_signal_closed' });
    expect(start).not.toHaveBeenCalled();
    now = new Date(now.getTime() + 8 * 24 * 60 * 60_000);
    await expect(request(signal.id, start)).rejects.toMatchObject({ code: 'operator_signal_closed' });
  });

  it('refuses a read key and a call outside a scope, and starts nothing', async () => {
    await setup();
    const { signal } = await detected();
    const start = startWith();
    await expect(request(signal.id, start, { scope: scope('read') })).rejects.toMatchObject({
      code: 'integrator_read_only',
    });
    await expect(request(signal.id, start, { scope: null })).rejects.toMatchObject({
      code: 'insufficient_access',
    });
    expect(start).not.toHaveBeenCalled();
    expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).toBeNull();
  });

  it('checks the key again where the start begins, so a key revoked meanwhile starts nothing', async () => {
    await setup();
    const { signal } = await detected();
    const start = startWith();
    // The first check is the entry, the second is the one right before the start.
    let checks = 0;
    await expect(
      request(signal.id, start, { scope: scope('super', () => ++checks >= 2) }),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
    expect(start).not.toHaveBeenCalled();
    expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).toBeNull();
  });

  it('lets one request for a signal run at a time', async () => {
    await setup();
    const { signal } = await detected();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = startWith();
    slow.mockImplementationOnce(async (member: string) => {
      await gate;
      return { messageId: 'msg_slow', recipient: { handle: member, delivery: 'wake' } } as MemberStartResult;
    });
    const first = request(signal.id, slow);
    await flush();
    await expect(request(signal.id, startWith())).rejects.toMatchObject({ code: 'operator_signal_closed' });
    release();
    expect(await first).toMatchObject({ status: 'started' });
  });
});
