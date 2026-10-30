import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_SIGNAL_WAKE_INTERVAL_MS, routes } from '@projectman/shared';
import type { ServerEvent } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import {
  createDomainHarness,
  restartDomainHarness,
  OWNER_ACTOR,
  waitForSession,
} from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';
import { canSeeProjectEvent } from '../src/core/projects';
import { WorkOutages } from '../src/runtime/watchers';

let h: DomainHarness;
let app: AppHarness | undefined;
let now: Date;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
  await app?.close();
  app = undefined;
});
async function setup() {
  now = new Date('2026-10-11T10:00:00Z');
  h = await createDomainHarness({
    now: () => now,
    adjust: (config) => {
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') pm.onLeave = false;
    },
  });
}
const failedCleanup = {
  scopeId: 'scp_0123456789abcdef',
  kind: 'process_group' as const,
  outcome: 'failed' as const,
  reason: 'stop' as const,
  killed: true,
  survivors: 1,
  durationMs: 7000,
};
const cleanupSignals = () =>
  h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'process_cleanup_failed');
async function startCleanupTask() {
  await setup();
  await h.domain.tasks.create('AR', { title: 'Cleanup test' }, OWNER_ACTOR);
  await h.domain.taskStarts.start('AR', 'AR-1', {
    assignee: 'dev-1',
    actor: OWNER_ACTOR,
    author: { name: 'Owner', email: 'owner@example.com' },
  });
  return h.runner.lastStarted().sessionId;
}
it('holds back the failed process cleanup signal while the failure is within the grace period', async () => {
  const sessionId = await startCleanupTask();
  h.runner.emit({ type: 'exit', sessionId, exitCode: 0, signal: null, cleanup: failedCleanup });
  now = new Date(now.getTime() + 60_000);
  h.runner.emit({ type: 'scope_recovered', sessionId, cleanup: { ...failedCleanup, reason: 'recovery' } });
  await flush();
  expect(cleanupSignals()).toHaveLength(0);
  h.runner.emit({
    type: 'scope_recovered',
    sessionId,
    cleanup: { ...failedCleanup, outcome: 'clean', reason: 'recovery', survivors: 0 },
  });
  await flush();
  expect(cleanupSignals()).toHaveLength(0);
});
it('raises a failed process cleanup signal and resolves it on confirmed recovery', async () => {
  const sessionId = await startCleanupTask();
  const cleanup = failedCleanup;
  h.runner.emit({ type: 'exit', sessionId, exitCode: 0, signal: null, cleanup });
  now = new Date(now.getTime() + 121_000);
  h.runner.emit({ type: 'scope_recovered', sessionId, cleanup: { ...cleanup, reason: 'recovery' } });
  await flush();
  const signal = cleanupSignals()[0];
  expect(signal).toMatchObject({
    caseKey: `cleanup:${cleanup.scopeId}`,
    subject: cleanup.scopeId,
    taskKey: 'AR-1',
    resolvedAt: null,
  });
  h.runner.emit({
    type: 'scope_recovered',
    sessionId,
    cleanup: { ...cleanup, outcome: 'clean', reason: 'recovery', survivors: 0 },
  });
  await flush();
  expect(h.repos.operatorSignals.get(signal!.id)?.resolvedAt).not.toBeNull();
});
function raise(caseKey = 'outage:test') {
  return h.domain.operatorSignals.raise({ projectKey: 'AR', kind: 'outage', caseKey, subject: 'test' });
}
const get = (id: string) => h.repos.operatorSignals.get(id)!;
const tool = async (): Promise<ToolContext> => ({
  projectKey: 'AR',
  member: 'pm',
  taskKey: null,
  sessionId: (await waitForSession(h.domain, { member: 'pm' })).id,
});
async function deliver() {
  await h.domain.operatorSignals.deliver('AR');
  await flush();
  const session = h.domain.sessions.list('AR', { member: 'pm' })[0];
  if (session) {
    h.runner.setState(session.id, 'working');
    h.runner.setState(session.id, 'idle');
    await flush();
  }
}

describe('Operator system signals', () => {
  it('filters every coordinator-only state from the channel and live owner events, retaining outage', async () => {
    await setup();
    for (const kind of ['structural_pattern', 'milestone_closed', 'stalled', 'outage'] as const) {
      for (const state of ['pending', 'open', 'dismissed', 'resolved'] as const) {
        const signal = h.domain.operatorSignals.raise({
          projectKey: 'AR',
          kind,
          caseKey: `${kind}:${state}`,
        });
        const saved = {
          ...signal,
          state,
          deliveredAt: now.toISOString(),
          resolvedAt: state === 'resolved' ? now.toISOString() : null,
        };
        h.repos.operatorSignals.save(saved);
        const event = { type: 'operator_signal' as const, projectKey: 'AR', signal: saved };
        expect(canSeeProjectEvent({ access: 'owner', handle: 'owner' }, event)).toBe(
          kind === 'stalled' || kind === 'outage',
        );
      }
    }
    const channel = h.domain.operatorSignals.channel('AR');
    expect(channel.openSignals).toBe(2);
    expect(channel.signals.map((s) => s.kind)).toEqual([
      'stalled',
      'stalled',
      'stalled',
      'outage',
      'outage',
      'outage',
    ]);
  });
  it('presents multiple signals in one message and preserves per-signal actions', async () => {
    await setup();
    const a = raise('outage:a');
    const b = raise('outage:b');
    await deliver();
    const sent = await h.domain.teamTools.sendMessage(await tool(), {
      to: ['owner'],
      kind: 'info',
      text: 'Summary',
      signalIds: [a.id, b.id],
      actionableSignalIds: [a.id],
    });
    expect(get(a.id)).toMatchObject({ state: 'open', messageId: sent.messageId, actionable: true });
    expect(get(b.id)).toMatchObject({ state: 'open', messageId: sent.messageId, actionable: false });
    expect(h.repos.messages.get(sent.messageId)?.operatorSignal).toBeUndefined();
  });
  it('rejects closed signals, mixed arguments, duplicates and non-owner recipients without binding anything', async () => {
    await setup();
    const a = raise('outage:a');
    const b = raise('outage:b');
    await deliver();
    const input = { to: ['owner'], kind: 'info' as const, text: 'Summary', signalIds: [a.id, b.id] };
    for (const changes of [
      { signalId: a.id },
      { signalActionable: false },
      { signalIds: [a.id, a.id] },
      { actionableSignalIds: ['foreign'] },
      { to: ['dev-1'] },
    ])
      await expect(h.domain.teamTools.sendMessage(await tool(), { ...input, ...changes })).rejects.toThrow(
        'invalid_request',
      );
    h.domain.operatorSignals.resolve('AR', b.caseKey);
    await expect(h.domain.teamTools.sendMessage(await tool(), input)).rejects.toThrow('no longer open');
    expect(get(a.id).messageId).toBeNull();
    expect(get(b.id).messageId).toBeNull();
  });
  it('rolls back all presentations and events if a later presentation fails during recording', async () => {
    await setup();
    const a = raise('outage:a');
    const b = raise('outage:b');
    await deliver();
    const events: ServerEvent[] = [];
    h.domain.bus.subscribe((event) => events.push(event));
    const present = h.domain.operatorSignals.present.bind(h.domain.operatorSignals);
    vi.spyOn(h.domain.operatorSignals, 'present').mockImplementation((project, id, message, actionable) => {
      if (id === b.id) throw new Error('Presentation failed');
      present(project, id, message, actionable);
    });
    await expect(
      h.domain.teamTools.sendMessage(await tool(), {
        to: ['owner'],
        kind: 'info',
        text: 'Summary',
        signalIds: [a.id, b.id],
      }),
    ).rejects.toThrow('Presentation failed');
    expect(get(a.id).messageId).toBeNull();
    expect(get(b.id).messageId).toBeNull();
    expect(events.filter((event) => event.type === 'operator_signal')).toEqual([]);
  });
  it.each(['pending', 'open'] as const)(
    'preserves a %s outage signal before the first restart evaluation',
    async (state) => {
      now = new Date('2026-10-11T10:00:00Z');
      h = await createDomainHarness({
        persistent: true,
        now: () => now,
        adjust: (config) => {
          const pm = config.team.members.find((m) => m.handle === 'pm')!;
          if (pm.kind === 'ai') pm.onLeave = false;
        },
      });
      const signal = raise();
      if (state === 'open') await deliver();
      expect(get(signal.id).state).toBe(state);
      // Hold the startup check at the same boundary as a slow provider probe.
      const check = vi.spyOn(WorkOutages.prototype, 'check').mockResolvedValue(undefined);
      h = await restartDomainHarness(h, { now: () => now });
      check.mockRestore();
      expect(h.domain.outages.activeIds('AR')).toBeNull();
      await h.domain.operatorSignals.sweep('AR');
      expect(get(signal.id)).toMatchObject({ state, resolvedAt: null });
      await h.domain.outages.recheckProvider('claude');
      expect(h.domain.outages.activeIds('AR')).toEqual(new Set());
      await h.domain.operatorSignals.sweep('AR');
      expect(get(signal.id).resolvedAt).toBe(now.toISOString());
    },
  );

  it('resolves an acknowledged outage after restart so the same provider can signal again', async () => {
    now = new Date('2026-10-11T10:00:00Z');
    h = await createDomainHarness({
      persistent: true,
      now: () => now,
      adjust: (config) => {
        const pm = config.team.members.find((m) => m.handle === 'pm')!;
        if (pm.kind === 'ai') pm.onLeave = false;
      },
    });
    Object.assign(h.runner, {
      providerStatus: async (provider: string) => ({
        provider,
        loggedIn: false,
        problem: 'logged_out',
        method: null,
        checkedAt: now.toISOString(),
      }),
    });
    await h.domain.outages.check();
    await flush();
    const alert = h.domain.inbox
      .list('AR', { kind: 'alert', state: 'open' })
      .find((item) => item.payload.alert === 'work_outage')!;
    const signal = h.repos.operatorSignals.list('AR').find((s) => s.kind === 'outage')!;
    expect(h.domain.outages.activeIds('AR')!.has(signal.subject!)).toBe(true);
    await h.domain.inbox.resolve(
      'AR',
      alert.id,
      { optionId: 'seen' },
      (await h.domain.accessFor('AR', 'owner@example.com'))!,
    );
    // Acknowledging the warning does not end a still observed outage.
    await h.domain.operatorSignals.sweep('AR');
    expect(get(signal.id).resolvedAt).toBeNull();
    h = await restartDomainHarness(h, { now: () => now });
    await h.domain.outages.recheckProvider('claude');
    expect(h.domain.outages.activeIds('AR')!.size).toBe(0);
    await h.domain.operatorSignals.sweep('AR');
    expect(get(signal.id)).toMatchObject({ state: 'resolved', resolvedAt: now.toISOString() });
    Object.assign(h.runner, {
      providerStatus: async (provider: string) => ({
        provider,
        loggedIn: false,
        problem: 'logged_out',
        method: null,
        checkedAt: now.toISOString(),
      }),
    });
    await h.domain.outages.recheckProvider('claude');
    const next = h.repos.operatorSignals.openByCase('AR', signal.caseKey)!;
    expect(next.id).not.toBe(signal.id);
    expect(next.resolvedAt).toBeNull();
  });

  it('rolls back the accepted signal and its websocket event when message recording fails', async () => {
    await setup();
    const signal = raise();
    await deliver();
    await h.domain.teamTools.sendMessage(await tool(), {
      to: ['owner'],
      kind: 'info',
      text: 'Proposal',
      signalId: signal.id,
      signalActionable: true,
    });
    const events: ServerEvent[] = [];
    h.domain.bus.subscribe((event) => events.push(event));
    vi.spyOn(h.domain.messages, 'record').mockImplementationOnce(() => {
      throw new Error('Recording failed');
    });
    await expect(
      h.domain.messaging.send(
        'AR',
        'owner',
        { to: ['pm'], text: 'Yes' },
        { actor: OWNER_ACTOR, operatorSignal: signal.id },
      ),
    ).rejects.toThrow('Recording failed');
    expect(get(signal.id)).toMatchObject({ state: 'open', decidedAt: null, decidedBy: null });
    expect(events.filter((event) => event.type === 'operator_signal')).toEqual([]);
  });
  it('keeps a failed notice pending and retries without spending the wake interval', async () => {
    await setup();
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    h.runner.setState(session.id, 'idle');
    const signal = raise();
    vi.spyOn(h.runner, 'sendUserMessage').mockRejectedValueOnce(new Error('Delivery failed'));
    await h.domain.operatorSignals.deliver('AR');
    expect(get(signal.id)).toMatchObject({ state: 'pending', deliveredAt: null });
    expect(h.repos.memberQueue.listOpen('AR', 'pm')).toMatchObject([{ kind: 'signal', state: 'queued' }]);
    expect(h.domain.operatorSignals.channel('AR').signals).toEqual([]);
    await deliver();
    expect(get(signal.id).state).toBe('open');
  });

  it('does not mark a new session as delivered when its first input never arrives', async () => {
    await setup();
    h.runner.holdFirstInput = true;
    const signal = raise();
    const wake = h.domain.operatorSignals.deliver('AR');
    await flush();
    expect(get(signal.id).deliveredAt).toBeNull();
    await expect(h.domain.admission.exclusive('test', async () => true)).resolves.toBe(true);
    h.runner.setState((await tool()).sessionId, 'failed');
    await wake;
    await flush();
    expect(get(signal.id)).toMatchObject({ state: 'pending', deliveredAt: null });
    expect(h.domain.operatorSignals.channel('AR').signals).toEqual([]);
  });
  it('keeps the signal item queued when the coordinator session fails to start, and delivers it later', async () => {
    await setup();
    const signal = raise();
    h.runner.failNextStart = new Error('Start failed');
    await h.domain.operatorSignals.deliver('AR');
    await flush();
    expect(h.repos.memberQueue.listOpen('AR', 'pm')).toMatchObject([{ kind: 'signal', state: 'queued' }]);
    expect(get(signal.id)).toMatchObject({ state: 'pending', deliveredAt: null });

    await h.domain.memberQueueDriver.ensure('AR', 'pm', { net: true });
    await flush();

    expect(get(signal.id).deliveredAt).not.toBeNull();
  });
  it('starts one owner conversation without a request and suppresses duplicates until resolution', async () => {
    await setup();
    const signal = raise();
    expect(get(signal.id).state).toBe('pending');
    expect(h.domain.operatorSignals.channel('AR').signals).toEqual([]);
    await deliver();
    expect(get(signal.id).state).toBe('open');
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.started[0]!.initialMessage).toContain(signal.id);
    expect(h.repos.operatorRequests.openOfSession((await tool()).sessionId)).toEqual([]);
    expect(raise().id).toBe(signal.id);
    h.domain.operatorSignals.decision('AR', signal.id, 'owner', false);
    expect(raise().id).toBe(signal.id);
    h.domain.operatorSignals.resolve('AR', signal.caseKey);
    expect(get(signal.id)).toMatchObject({ state: 'dismissed', resolvedAt: now.toISOString() });
    expect(raise().id).not.toBe(signal.id);
  });

  it('batches new cases after the fifteen minute wake interval', async () => {
    await setup();
    raise();
    await deliver();
    const a = raise('outage:a');
    const b = raise('outage:b');
    await deliver();
    expect(get(a.id).state).toBe('pending');
    expect(get(b.id).state).toBe('pending');
    now = new Date(now.getTime() + OPERATOR_SIGNAL_WAKE_INTERVAL_MS);
    await deliver();
    expect(get(a.id).state).toBe('open');
    expect(get(b.id).state).toBe('open');
    expect(h.runner.messages.at(-1)?.text).toContain(a.id);
    expect(h.runner.messages.at(-1)?.text).toContain(b.id);
  });

  it('presents one signal without authorizing other writes, then accepts an owner request', async () => {
    await setup();
    const signal = raise();
    await deliver();
    await expect(
      h.domain.teamTools.startMember(await tool(), { member: 'dev-1', text: 'Unauthorized' }),
    ).rejects.toThrow('operator_no_request');
    const sent = await h.domain.teamTools.sendMessage(await tool(), {
      to: ['owner'],
      kind: 'info',
      text: 'Service is down. I propose restarting it.',
      signalId: signal.id,
      signalActionable: true,
    });
    expect(h.repos.messages.get(sent.messageId)?.operatorSignal).toBe(signal.id);
    expect(get(signal.id)).toMatchObject({ actionable: true, messageId: sent.messageId });
    await expect(
      h.domain.teamTools.sendMessage(await tool(), {
        to: ['owner'],
        kind: 'info',
        text: 'Again',
        signalId: signal.id,
      }),
    ).rejects.toThrow('no longer open');
    h.runner.setState((await tool()).sessionId, 'idle');
    await flush();
    const accepted = await h.domain.messaging.send(
      'AR',
      'owner',
      { to: ['pm'], text: 'Yes, handle it' },
      { actor: OWNER_ACTOR, operatorSignal: signal.id },
    );
    await flush();
    expect(get(signal.id)).toMatchObject({ state: 'accepted', decidedBy: 'owner' });
    expect(h.repos.operatorRequests.openOfSession((await tool()).sessionId)[0]?.messageId).toBe(accepted.id);
    expect(accepted.operatorSignal).toBe(signal.id);
    await expect(
      h.domain.teamTools.startMember(await tool(), { member: 'dev-2', text: 'Authorized work.' }),
    ).resolves.toHaveProperty('messageId');
  });

  it('rejects pending, foreign, resolved and non-Operator presentations', async () => {
    await setup();
    const signal = raise();
    expect(() => h.domain.operatorSignals.presentation('AR', signal.id)).toThrow('no longer open');
    await deliver();
    expect(() => h.domain.operatorSignals.presentation('OTHER', signal.id)).toThrow('unknown signal');
    await expect(
      h.domain.teamTools.sendMessage(
        { ...(await tool()), member: 'dev-1' },
        { to: ['owner'], kind: 'info', text: 'Fake', signalId: signal.id },
      ),
    ).rejects.toThrow('invalid_request');
    await expect(
      h.domain.teamTools.sendMessage(await tool(), {
        to: ['dev-1'],
        kind: 'info',
        text: 'Wrong recipient',
        signalId: signal.id,
      }),
    ).rejects.toThrow('invalid_request');
    h.domain.operatorSignals.resolve('AR', signal.caseKey);
    expect(() => h.domain.operatorSignals.presentation('AR', signal.id)).toThrow('no longer open');
  });

  it('refuses acceptance without an actionable proposal and through the integrator', async () => {
    await setup();
    const signal = raise();
    await deliver();
    await expect(
      h.domain.messaging.send(
        'AR',
        'owner',
        { to: ['pm'], text: 'Yes' },
        { actor: OWNER_ACTOR, operatorSignal: signal.id },
      ),
    ).rejects.toMatchObject({ code: 'operator_signal_closed', status: 409 });
    await h.domain.teamTools.sendMessage(await tool(), {
      to: ['owner'],
      kind: 'info',
      text: 'Proposal',
      signalId: signal.id,
      signalActionable: true,
    });
    await expect(
      h.domain.messaging.send(
        'AR',
        'owner',
        { to: ['pm'], text: 'Yes' },
        { actor: { ...OWNER_ACTOR, via: 'integrator' }, operatorSignal: signal.id },
      ),
    ).rejects.toMatchObject({ code: 'operator_signal_closed', status: 409 });
    expect(get(signal.id).state).toBe('open');
  });

  it('defers during a pause and wakes only for surviving cases on resume', async () => {
    await setup();
    const scope = { scope: 'project', projectKey: 'AR' } as const;
    const by = { source: 'system', userId: null } as const;
    await h.domain.pauses.pause(scope, by);
    const gone = raise('outage:gone');
    const live = raise('outage:live');
    await deliver();
    expect(h.runner.started).toEqual([]);
    h.domain.operatorSignals.resolve('AR', gone.caseKey);
    expect(h.domain.operatorSignals.channel('AR').signals).toEqual([]);
    await h.domain.pauses.resume(scope, by);
    await flush();
    h.runner.setState((await tool()).sessionId, 'idle');
    await flush();
    expect(get(live.id).state).toBe('open');
    expect(h.runner.started[0]!.initialMessage).not.toContain(gone.id);
  });

  it('raises and resolves silent sessions when activity returns', async () => {
    await setup();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    h.runner.setState(session.id, 'working', 'Long tool');
    now = new Date(now.getTime() + 30 * 60_000);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    const signal = h.repos.operatorSignals.list('AR').find((s) => s.kind === 'silent')!;
    expect(signal.subject).toBe(session.id);
    h.runner.setState(session.id, 'working', 'Tool finished');
    await h.domain.operatorSignals.sweep('AR');
    expect(get(signal.id).resolvedAt).toBe(now.toISOString());
  });

  it('recovers delivered turns and keeps the wake interval across a restart', async () => {
    now = new Date('2026-10-11T10:00:00Z');
    h = await createDomainHarness({
      persistent: true,
      now: () => now,
      adjust: (config) => {
        const pm = config.team.members.find((m) => m.handle === 'pm')!;
        if (pm.kind === 'ai') pm.onLeave = false;
      },
    });
    const first = raise();
    await h.domain.operatorSignals.deliver('AR');
    await flush();
    expect(get(first.id)).toMatchObject({ state: 'pending', deliveredAt: now.toISOString() });
    const waiting = raise('outage:waiting');
    h = await restartDomainHarness(h, { now: () => now });
    expect(get(first.id).state).toBe('open');
    await deliver();
    expect(h.runner.started).toHaveLength(0);
    expect(get(waiting.id).state).toBe('pending');
    now = new Date(now.getTime() + OPERATOR_SIGNAL_WAKE_INTERVAL_MS);
    await deliver();
    expect(get(waiting.id).state).toBe('open');
    expect(h.runner.started).toHaveLength(1);
  });

  it('makes a due follow-up a new queue item of the same signal', async () => {
    await setup();
    const signal = raise();
    await deliver();
    const queueItems = () =>
      h.repos.db
        .prepare("SELECT id, state FROM member_queue_items WHERE kind = 'signal' AND member = 'pm'")
        .all() as Array<{ id: string; state: string }>;
    expect(queueItems()).toHaveLength(1);

    now = new Date(now.getTime() + 60_000);
    h.repos.operatorSignals.followUp(signal.id, now.toISOString());
    await deliver();

    expect(queueItems()).toHaveLength(2);
    expect(get(signal.id).followUpAt).toBe(now.toISOString());
  });

  it('drops the old deferred rows of signals and screening at a restart and works the PM queue', async () => {
    now = new Date('2026-10-11T10:00:00Z');
    h = await createDomainHarness({
      persistent: true,
      now: () => now,
      adjust: (config) => {
        const pm = config.team.members.find((m) => m.handle === 'pm')!;
        if (pm.kind === 'ai') pm.onLeave = false;
      },
    });
    const signal = raise();
    for (const kind of ['operator_signals', 'question_screening'] as const)
      h.repos.deferredStarts.save({
        key: `${kind}:AR`,
        projectKey: 'AR',
        taskKey: null,
        spec: { kind, projectKey: 'AR' },
        waiting: null,
      });

    h = await restartDomainHarness(h, { now: () => now });

    await vi.waitFor(() => expect(h.repos.deferredStarts.list()).toEqual([]));
    await deliver();
    expect(h.runner.started).toHaveLength(1);
    expect(get(signal.id)).toMatchObject({ state: 'open', deliveredTo: 'pm' });
  });

  it('detects a card with no eligible label setter and resolves it when the label arrives', async () => {
    await setup();
    const task = await h.domain.tasks.create('AR', { title: 'Nobody can approve this' }, OWNER_ACTOR);
    // A previously stored configuration can outlive its label setter. Model that state directly.
    const config = h.domain.projects.cachedConfig('AR')!;
    config.pipeline.labels.push({ id: 'unowned', name: 'Unowned', setBy: { members: ['ghost'] } });
    config.pipeline.stages[0]!.gate = { conditions: [{ type: 'has_label', label: 'unowned' }] };
    // Put the card at a stage whose next step requires a label nobody can set.
    await h.domain.operatorSignals.sweep('AR');
    const signal = h.repos.operatorSignals.list('AR').find((s) => s.kind === 'nobody');
    expect(signal?.caseKey).toBe(`nobody:${task.key}:${task.stageId}`);
    h.repos.tasks.update(task.id, { labels: ['unowned'] });
    await h.domain.operatorSignals.sweep('AR');
    expect(get(signal!.id).resolvedAt).not.toBeNull();
  });

  it('connects outage and stalled events and resolves released input', async () => {
    await setup();
    await h.domain.ctx.events.emit('work_outage_started', {
      projectKey: 'AR',
      outageId: 'provider',
      inboxItemId: 'alert_1',
    });
    await vi.waitFor(() => expect(h.domain.sessions.list('AR', { member: 'pm' })).toHaveLength(1));
    await flush();
    h.runner.setState((await tool()).sessionId, 'idle');
    await flush();
    const outage = h.repos.operatorSignals.list('AR')[0]!;
    expect(outage).toMatchObject({ kind: 'outage', state: 'open', inboxItemId: 'alert_1' });
    await h.domain.ctx.events.emit('work_outage_ended', { projectKey: 'AR', outageId: 'provider' });
    expect(get(outage.id).state).toBe('resolved');
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    h.runner.setState(session.id, 'waiting_input');
    await h.domain.ctx.events.emit('session_input_stalled', {
      projectKey: 'AR',
      sessionId: session.id,
      inboxItemId: 'alert_2',
    });
    const stalled = h.repos.operatorSignals.list('AR').find((s) => s.kind === 'stalled')!;
    expect(stalled).toMatchObject({ state: 'pending', subject: session.id, inboxItemId: 'alert_2' });
    await h.domain.ctx.events.emit('session_input_released', session);
    expect(get(stalled.id).resolvedAt).not.toBeNull();
  });

  it('publishes signal state only to owners', async () => {
    await setup();
    const events: ServerEvent[] = [];
    h.domain.bus.subscribe((e) => events.push(e));
    const signal = raise();
    await deliver();
    const event = events.find((e) => e.type === 'operator_signal')!;
    expect(event).toMatchObject({ signal: { id: signal.id, state: 'open' } });
    expect(
      canSeeProjectEvent(
        { access: 'owner', handle: 'owner' },
        event as Parameters<typeof canSeeProjectEvent>[1],
      ),
    ).toBe(true);
    expect(
      canSeeProjectEvent(
        { access: 'admin', handle: 'admin' },
        event as Parameters<typeof canSeeProjectEvent>[1],
      ),
    ).toBe(false);
  });

  it('allows dismissal only by an owner using their own login and rejects repeated decisions', async () => {
    app = await createAppHarness({ app: { claudeTmpRoots: [] } });
    const cookie = await setupOwner(app.app);
    await createProject(app, cookie);
    await app.app.projectman.domain.members.update(
      'AR',
      'pm',
      { onLeave: false },
      { actor: OWNER_ACTOR, author: { name: 'Owner', email: 'owner@example.test' } },
    );
    const other = await addHumanAndLogin(app.app, {
      handle: 'dana',
      email: 'dana@example.test',
      access: 'developer',
      roles: [],
    });
    const signal = app.app.projectman.domain.operatorSignals.raise({
      projectKey: 'AR',
      kind: 'outage',
      caseKey: 'outage:api',
    });
    await app.app.projectman.domain.operatorSignals.deliver('AR');
    await flush();
    app.runner.setState((await waitForSession(app.app.projectman.domain, { member: 'pm' })).id, 'idle');
    await flush();
    const url = routes.dismissOperatorSignal('AR', signal.id);
    expect((await app.app.inject({ method: 'POST', url, headers: { cookie: other } })).statusCode).toBe(403);
    expect((await app.app.inject({ method: 'POST', url, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.app.inject({ method: 'POST', url, headers: { cookie } })).statusCode).toBe(409);
  });
});
