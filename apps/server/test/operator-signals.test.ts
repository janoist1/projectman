import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_SIGNAL_WAKE_INTERVAL_MS, routes } from '@projectman/shared';
import type { ServerEvent } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, restartDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';
import { canSeeProjectEvent } from '../src/domain/visibility';

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
  h = await createDomainHarness({ now: () => now });
}
function raise(caseKey = 'outage:test') {
  return h.domain.operatorSignals.raise({ projectKey: 'AR', kind: 'outage', caseKey, subject: 'test' });
}
const get = (id: string) => h.repos.operatorSignals.get(id)!;
const tool = (): ToolContext => ({
  projectKey: 'AR',
  member: 'operator',
  taskKey: null,
  sessionId: h.domain.sessions.list('AR', { member: 'operator' })[0]!.id,
});
async function deliver() {
  await h.domain.operatorSignals.deliver('AR');
  await flush();
  const session = h.domain.sessions.list('AR', { member: 'operator' })[0];
  if (session) {
    h.runner.setState(session.id, 'working');
    h.runner.setState(session.id, 'idle');
    await flush();
  }
}

describe('Operator system signals', () => {
  it('keeps a failed notice pending and retries without spending the wake interval', async () => {
    await setup();
    await h.domain.sessions.ensureSession('AR', 'operator', { type: 'general' });
    const signal = raise();
    vi.spyOn(h.runner, 'sendUserMessage').mockRejectedValueOnce(new Error('Delivery failed'));
    await expect(h.domain.operatorSignals.deliver('AR')).rejects.toThrow('delivery failed');
    expect(get(signal.id)).toMatchObject({ state: 'pending', deliveredAt: null });
    expect(h.domain.operatorSignals.channel('AR').signals).toEqual([]);
    await deliver();
    expect(get(signal.id).state).toBe('open');
  });

  it('does not mark a new session as delivered when its first input never arrives', async () => {
    await setup();
    h.runner.holdFirstInput = true;
    const signal = raise();
    const wake = h.domain.operatorSignals.deliver('AR');
    const failure = expect(wake).rejects.toThrow('first input was not delivered');
    await flush();
    expect(get(signal.id).deliveredAt).toBeNull();
    await expect(h.domain.admission.exclusive(async () => true)).resolves.toBe(true);
    h.runner.setState(tool().sessionId, 'failed');
    await failure;
    expect(get(signal.id)).toMatchObject({ state: 'pending', deliveredAt: null });
    expect(h.domain.operatorSignals.channel('AR').signals).toEqual([]);
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
    expect(h.repos.operatorRequests.openOfSession(tool().sessionId)).toEqual([]);
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
    await expect(h.domain.teamTools.createTask(tool(), { title: 'Unauthorized' })).rejects.toThrow(
      'operator_no_request',
    );
    const sent = await h.domain.teamTools.sendMessage(tool(), {
      to: ['owner'],
      kind: 'info',
      text: 'Service is down. I propose restarting it.',
      signalId: signal.id,
      signalActionable: true,
    });
    expect(h.repos.messages.get(sent.messageId)?.operatorSignal).toBe(signal.id);
    expect(get(signal.id)).toMatchObject({ actionable: true, messageId: sent.messageId });
    await expect(
      h.domain.teamTools.sendMessage(tool(), {
        to: ['owner'],
        kind: 'info',
        text: 'Again',
        signalId: signal.id,
      }),
    ).rejects.toThrow('no longer open');
    h.runner.setState(tool().sessionId, 'idle');
    await flush();
    const accepted = await h.domain.messaging.send(
      'AR',
      'owner',
      { to: ['operator'], text: 'Yes, handle it' },
      { actor: OWNER_ACTOR, operatorSignal: signal.id },
    );
    await flush();
    expect(get(signal.id)).toMatchObject({ state: 'accepted', decidedBy: 'owner' });
    expect(h.repos.operatorRequests.openOfSession(tool().sessionId)[0]?.messageId).toBe(accepted.id);
    await expect(h.domain.teamTools.createTask(tool(), { title: 'Authorized' })).resolves.toBeDefined();
  });

  it('rejects pending, foreign, resolved and non-Operator presentations', async () => {
    await setup();
    const signal = raise();
    expect(() => h.domain.operatorSignals.presentation('AR', signal.id)).toThrow('no longer open');
    await deliver();
    expect(() => h.domain.operatorSignals.presentation('OTHER', signal.id)).toThrow('no longer open');
    await expect(
      h.domain.teamTools.sendMessage(
        { ...tool(), member: 'dev-1' },
        { to: ['owner'], kind: 'info', text: 'Fake', signalId: signal.id },
      ),
    ).rejects.toThrow('invalid_request');
    await expect(
      h.domain.teamTools.sendMessage(tool(), {
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
        { to: ['operator'], text: 'Yes' },
        { actor: OWNER_ACTOR, operatorSignal: signal.id },
      ),
    ).rejects.toMatchObject({ code: 'operator_signal_closed', status: 409 });
    await h.domain.teamTools.sendMessage(tool(), {
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
        { to: ['operator'], text: 'Yes' },
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
    h.runner.setState(tool().sessionId, 'idle');
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
    h = await createDomainHarness({ persistent: true, now: () => now });
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
    await vi.waitFor(() => expect(h.domain.sessions.list('AR', { member: 'operator' })).toHaveLength(1));
    await flush();
    h.runner.setState(tool().sessionId, 'idle');
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
    app.runner.setState(app.app.projectman.domain.sessions.list('AR', { member: 'operator' })[0]!.id, 'idle');
    await flush();
    const url = routes.dismissOperatorSignal('AR', signal.id);
    expect((await app.app.inject({ method: 'POST', url, headers: { cookie: other } })).statusCode).toBe(403);
    expect((await app.app.inject({ method: 'POST', url, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.app.inject({ method: 'POST', url, headers: { cookie } })).statusCode).toBe(409);
  });
});
