import { afterEach, describe, expect, it, vi } from 'vitest';
import { PatternFacts, structuralReviewOf } from '@projectman/shared';
import type { AiMemberConfig, TimelineEvent } from '@projectman/shared';
import { StructuralPatterns, normalizedEvidencePath } from '../src/services/operator/structural-patterns';
import { CoordinationRequests } from '../src/services/operator';
import { OperatorTools } from '../src/mcp/operator/handler';
import {
  createDomainHarness,
  OWNER_ACTOR,
  restartDomainHarness,
  waitForSession,
} from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

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
    const operator = h.domain.sessions.list('AR', { member: 'operator' });
    expect(operator).toEqual([]);
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
    const operator = await h.domain.sessions.ensureSession('AR', 'operator', { type: 'general' });
    await expect(
      h.domain.teamTools.requestStructuralReview(
        { ...ctx, sessionId: operator.session.id, member: 'operator' },
        { signalId: signal.id, note: 'Review.' },
      ),
    ).rejects.toThrow('project_manager_only');
  });
});
