import { describe, expect, it } from 'vitest';
import type { MessageProcessingFacts, ProcessingSession } from './message-processing';
import { messageProcessingOf, PROCESSING_STALE_MS } from './message-processing';
import { visibleProcessing } from './message';
import type { TaskViewer } from './task';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const session = (patch: Partial<ProcessingSession> = {}): ProcessingSession => ({
  state: 'working',
  stateSince: at(3),
  lastActivityAt: at(1),
  engineConnected: true,
  ...patch,
});

const project = (facts: Partial<MessageProcessingFacts>) =>
  messageProcessingOf({ handle: 'designer', now: NOW, ...facts });

describe('messageProcessingOf', () => {
  it.each<[string, Partial<MessageProcessingFacts>, string]>([
    ['a stored message', {}, 'stored'],
    ['a held message', { hold: { name: 'handoff', since: at(3) } }, 'held'],
    ['a message a session starts for', { startingSince: at(1) }, 'starting'],
    [
      'a held message that is starting too',
      { startingSince: at(1), hold: { name: 'engine', since: at(3) } },
      'starting',
    ],
    ['a delivered message', { deliveredAt: at(4) }, 'delivered'],
    ['a message a person read', { deliveredAt: at(4), readAt: at(2) }, 'read'],
    ['a message handed on', { deliveredAt: at(4), handedOffTo: 'codex' }, 'handed_off'],
    [
      'a message in a working turn',
      { deliveredAt: at(4), turn: { typedAt: at(4), endedAt: null }, session: session() },
      'working',
    ],
    [
      'a message in a finished turn',
      { deliveredAt: at(4), turn: { typedAt: at(4), endedAt: at(1) }, session: session() },
      'turn_ended',
    ],
    [
      'a message with an answer',
      { deliveredAt: at(4), reply: { at: at(1), reply: { eventId: 'e1' } } },
      'replied',
    ],
    ['a mention without a notice', { notSent: true }, 'not_sent'],
  ])('projects %s', (_name, facts, state) => {
    expect(project(facts).state).toBe(state);
  });

  it('prefers the answer to the end of the turn, and the end of the turn to the session state', () => {
    const turn = { typedAt: at(4), endedAt: at(2) };
    expect(
      project({ turn, session: session(), reply: { at: at(1), reply: { messageId: 'm1' } } }).state,
    ).toBe('replied');
    expect(project({ turn, session: session({ state: 'waiting_permission' }) }).state).toBe('turn_ended');
  });

  it('is working when the session entered that state before the message was acknowledged', () => {
    expect(
      project({
        turn: { typedAt: at(4), endedAt: null },
        session: session({ stateSince: at(10) }),
        deliveredAt: at(4),
      }),
    ).toMatchObject({ state: 'working', since: at(4) });
  });

  it('is only delivered while the turn’s session is not working yet', () => {
    expect(
      project({
        turn: { typedAt: at(4), endedAt: null },
        session: session({ state: 'idle' }),
        deliveredAt: at(4),
      }).state,
    ).toBe('delivered');
  });

  it.each<[string, Partial<ProcessingSession>, string | undefined]>([
    ['a permission', { state: 'waiting_permission' }, 'permission'],
    ['an input', { state: 'waiting_input' }, 'input'],
    ['a pause', { pausedSince: at(2) }, 'paused'],
  ])('waits for %s', (_name, patch, reason) => {
    expect(
      project({ deliveredAt: at(4), turn: { typedAt: at(4), endedAt: null }, session: session(patch) }),
    ).toMatchObject({ state: 'waiting', reason });
  });

  it.each<[string, Partial<ProcessingSession>, string]>([
    ['an engine that is not connected', { engineConnected: false }, 'engine_offline'],
    [
      'a working session silent for a quarter of an hour',
      { lastActivityAt: new Date(NOW - PROCESSING_STALE_MS).toISOString() },
      'no_report',
    ],
  ])('is stale for %s', (_name, patch, cause) => {
    expect(
      project({ deliveredAt: at(30), turn: { typedAt: at(30), endedAt: null }, session: session(patch) }),
    ).toMatchObject({ state: 'stale', cause });
  });

  it('is stale when the turn’s session cannot be read', () => {
    expect(
      project({ deliveredAt: at(4), turn: { typedAt: at(4), endedAt: null }, session: null }),
    ).toMatchObject({ state: 'stale', cause: 'no_report' });
  });
});

describe('visibleProcessing', () => {
  const items = [
    { handle: 'designer', state: 'waiting' as const, reason: 'permission' as const, since: at(2) },
    { handle: 'dev', state: 'delivered' as const, at: at(1) },
  ];
  const viewer = (access: TaskViewer['access'], handle: string): TaskViewer => ({ access, handle });

  it('shows the author their own and an owner everyone’s, and nobody else any', () => {
    expect(visibleProcessing(viewer('developer', 'pm'), 'pm', items)).toHaveLength(2);
    expect(visibleProcessing(viewer('owner', 'boss'), 'pm', items)).toHaveLength(2);
    expect(visibleProcessing(viewer('developer', 'dev'), 'pm', items)).toBeUndefined();
  });

  it('leaves the waiting reason out for a client', () => {
    const [waiting] = visibleProcessing(viewer('client', 'ugyfel'), 'ugyfel', items)!;
    expect(waiting).toEqual({ handle: 'designer', state: 'waiting', since: items[0]!.since });
  });
});
