import type { ProjectConfig, Session, TeamMessage } from '@projectman/shared';
import { parseInjectedTeamMessage, splitTeamMessageBatch } from '@projectman/shared';
import { Clock, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageDelivery, makeMessageDelivery, type DeliveryDeps, type DeliveryEffects } from './delivery';

/**
 * The delivery's Effect program under the TestClock (the retry ladder to the millisecond), and the
 * facade under fake timers (no timer is left behind). The fake deps stand in for the services; the
 * end-to-end delivery is covered by the domain tests and team-message-delivery.integration.test.ts.
 */

const config = {
  team: {
    members: [
      { handle: 'dev', kind: 'ai' },
      { handle: 'qa', kind: 'ai' },
      { handle: 'owner', kind: 'human' },
    ],
  },
} as unknown as ProjectConfig;

const session = {
  id: 'ses_1',
  projectKey: 'AR',
  member: 'dev',
  state: 'idle',
  workItem: { type: 'general' },
} as unknown as Session;

function messageOf(id: string): TeamMessage {
  return {
    id,
    projectKey: 'AR',
    from: 'qa',
    to: ['dev'],
    body: `message ${id}`,
    kind: 'action',
    taskKey: null,
    attachments: [],
    receipts: [],
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as unknown as TeamMessage;
}

function setup() {
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const waiting = new Map<string, TeamMessage>();
  const control = { typeInto: 'fail' as 'fail' | 'ok' | 'hang' };
  const typeInto = vi.fn(async (_session: Session, _text: string) => {
    if (control.typeInto === 'hang') return new Promise<boolean>(() => {});
    if (control.typeInto === 'fail') throw new Error('not taken');
    return true;
  });
  const markRecipientDelivered = vi.fn((id: string) => {
    waiting.delete(id);
  });
  const deps: DeliveryDeps = {
    ctx: {
      logger,
      now: () => new Date(0),
      repos: {
        tasks: { get: () => null },
        inbox: { get: () => null },
        timeline: { roundEvents: () => [] },
        messages: { hasNewerAction: () => false },
      },
    } as unknown as DeliveryDeps['ctx'],
    sessions: {
      find: () => session,
      isRunning: () => true,
      isPaused: () => false,
      permissionRestartDue: () => false,
      hasPendingInput: () => false,
      reviewRoundDue: () => false,
      typeInto,
      sourceHead: async () => null,
    } as unknown as DeliveryDeps['sessions'],
    projects: { cachedConfig: () => config, config: async () => config },
    messages: {
      waiting: () => [...waiting.values()],
      get: (id: string) => waiting.get(id),
      wakes: () => true,
      markRecipientDelivered,
    } as unknown as DeliveryDeps['messages'],
    decisionCandidates: { unseen: () => 0 },
  };
  const add = (id: string) => waiting.set(id, messageOf(id));
  return { deps, logger, typeInto, markRecipientDelivered, control, add, waiting };
}

/** Lets the promises of the fake deps settle (real turns of the event loop). */
const settled = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

/** Moves the TestClock by `ms` and lets the work it starts finish. */
const advance = (ms: number) => Effect.andThen(TestClock.adjust(ms), settled);

function run<A>(deps: DeliveryDeps, body: (delivery: DeliveryEffects) => Effect.Effect<A>): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        return yield* Effect.gen(function* () {
          const delivery = yield* makeMessageDelivery(deps);
          return yield* body(delivery);
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
}

describe('message delivery under the TestClock', () => {
  it('carries the stored actor into a batch and direct delivery', async () => {
    const { deps, typeInto, control, waiting } = setup();
    control.typeInto = 'ok';
    const actor = {
      kind: 'ai' as const,
      handle: 'actual-operator',
      via: 'integrator' as const,
      operatorMode: 'super' as const,
      credential: { id: 'key', prefix: 'pmi_test' },
    };
    const message = { ...messageOf('super'), from: actor.handle, via: actor.via, actor };
    waiting.set(message.id, message);
    await run(deps, (delivery) =>
      Effect.gen(function* () {
        yield* delivery.deliverWaiting(session);
        yield* settled;
        expect(splitTeamMessageBatch(typeInto.mock.calls[0]![1])?.items[0]?.actor).toEqual(actor);
        yield* delivery.deliver(session, message);
        yield* settled;
        expect(parseInjectedTeamMessage(typeInto.mock.calls[1]![1])?.actor).toEqual(actor);
      }),
    );
  });
  it('frames the text of an e-mail reply as outside data, in a batch and in direct delivery', async () => {
    const { deps, typeInto, control, waiting } = setup();
    control.typeInto = 'ok';
    const message = { ...messageOf('mail'), from: 'owner', email: { emailId: 'eml_1', subject: 'Re: Plan' } };
    waiting.set(message.id, message);
    await run(deps, (delivery) =>
      Effect.gen(function* () {
        yield* delivery.deliverWaiting(session);
        yield* settled;
        yield* delivery.deliver(session, message);
        yield* settled;
      }),
    );
    for (const call of typeInto.mock.calls)
      expect(call[1]).toContain('[E-mail reply from owner to your e-mail "Re: Plan"');
    expect(typeInto).toHaveBeenCalledTimes(2);
  });
  it('retries after 10, 40, 100, 220 and 520 seconds, then logs once and stops', async () => {
    const { deps, typeInto, logger, add } = setup();
    add('m1');
    await run(deps, (delivery) =>
      Effect.gen(function* () {
        yield* delivery.deliverWaiting(session);
        yield* settled;
        expect(typeInto).toHaveBeenCalledTimes(1);

        let calls = 1;
        let elapsed = 0;
        for (const at of [10_000, 40_000, 100_000, 220_000, 520_000]) {
          yield* advance(at - elapsed - 1);
          expect(typeInto).toHaveBeenCalledTimes(calls);
          yield* advance(1);
          calls += 1;
          expect(typeInto).toHaveBeenCalledTimes(calls);
          elapsed = at;
        }
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
          { sessionId: 'ses_1', member: 'dev' },
          'team messages could not be typed into the session; they stay waiting for its next idle moment',
        );

        yield* advance(3_600_000);
        expect(typeInto).toHaveBeenCalledTimes(calls);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(Error) }),
          'team message batch delivery failed',
        );
      }),
    );
  });

  it('starts the ladder over at 10 seconds after typing worked', async () => {
    const { deps, typeInto, control, add, markRecipientDelivered } = setup();
    add('m1');
    await run(deps, (delivery) =>
      Effect.gen(function* () {
        yield* delivery.deliverWaiting(session);
        yield* settled;
        expect(typeInto).toHaveBeenCalledTimes(1);
        control.typeInto = 'ok';
        yield* advance(10_000);
        expect(typeInto).toHaveBeenCalledTimes(2);
        expect(markRecipientDelivered).toHaveBeenCalledWith('m1', 'dev');

        // A new message that is not taken either: the first pause is the short one again.
        control.typeInto = 'fail';
        add('m2');
        yield* delivery.deliverWaiting(session);
        yield* settled;
        expect(typeInto).toHaveBeenCalledTimes(3);
        yield* advance(9_999);
        expect(typeInto).toHaveBeenCalledTimes(3);
        yield* advance(1);
        expect(typeInto).toHaveBeenCalledTimes(4);
      }),
    );
  });

  it('tries no more once the held state of the session is dropped', async () => {
    const { deps, typeInto, add } = setup();
    add('m1');
    await run(deps, (delivery) =>
      Effect.gen(function* () {
        yield* delivery.deliverWaiting(session);
        yield* settled;
        yield* advance(5_000);
        yield* delivery.dropHeld(session.id);
        yield* advance(3_600_000);
        expect(typeInto).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('types the messages again after 10 seconds when the first input was not taken', async () => {
    const { deps, typeInto, control, add, markRecipientDelivered, logger } = setup();
    add('m1');
    await run(deps, (delivery) =>
      Effect.gen(function* () {
        control.typeInto = 'ok';
        const messages = [messageOf('m1')];
        yield* delivery.deliverWithFirstInput('dev', messages, Promise.resolve(false), session);
        yield* settled;
        expect(markRecipientDelivered).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          { sessionId: 'ses_1', handle: 'dev' },
          'team messages in the first input not taken',
        );
        yield* advance(9_999);
        expect(typeInto).not.toHaveBeenCalled();
        yield* advance(1);
        expect(typeInto).toHaveBeenCalledTimes(1);
        expect(markRecipientDelivered).toHaveBeenCalledWith('m1', 'dev');
      }),
    );
  });

  it('counts the messages as delivered once the first input was taken', async () => {
    const { deps, typeInto, add, markRecipientDelivered } = setup();
    add('m1');
    await run(deps, (delivery) =>
      Effect.gen(function* () {
        yield* delivery.deliverWithFirstInput('dev', [messageOf('m1')], Promise.resolve(true), session);
        yield* settled;
        expect(markRecipientDelivered).toHaveBeenCalledWith('m1', 'dev');
        yield* advance(3_600_000);
        expect(typeInto).not.toHaveBeenCalled();
      }),
    );
  });

  it('closing the scope stops a pending retry', async () => {
    const { deps, typeInto, add } = setup();
    add('m1');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make();
          yield* Effect.gen(function* () {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const delivery = yield* makeMessageDelivery(deps);
                yield* delivery.deliverWaiting(session);
                yield* settled;
              }),
            );
            yield* advance(3_600_000);
          }).pipe(Effect.provideService(Clock.Clock, clock));
        }),
      ),
    );
    expect(typeInto).toHaveBeenCalledTimes(1);
  });
});

describe('MessageDelivery facade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves no timer behind after dropHeld', async () => {
    const { deps, typeInto, add } = setup();
    add('m1');
    const delivery = new MessageDelivery(deps);
    delivery.deliverWaiting(session);
    await vi.advanceTimersByTimeAsync(0);
    expect(typeInto).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    delivery.dropHeld(session.id);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(typeInto).toHaveBeenCalledTimes(1);
    await delivery.close();
  });

  it('leaves no timer behind after close', async () => {
    const { deps, typeInto, add } = setup();
    add('m1');
    const delivery = new MessageDelivery(deps);
    delivery.deliverWaiting(session);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await delivery.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(typeInto).toHaveBeenCalledTimes(1);
  });

  it('logs no failure and starts no retry for a typing that close() interrupts', async () => {
    const { deps, typeInto, logger, control } = setup();
    control.typeInto = 'hang';
    const delivery = new MessageDelivery(deps);
    delivery.deliver(session, messageOf('m1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(typeInto).toHaveBeenCalledTimes(1);
    await delivery.close();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(typeInto).toHaveBeenCalledTimes(1);
  });

  it('retries on the real ladder through the facade', async () => {
    const { deps, typeInto, add } = setup();
    add('m1');
    const delivery = new MessageDelivery(deps);
    delivery.deliverWaiting(session);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(typeInto).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(typeInto).toHaveBeenCalledTimes(2);
    await delivery.close();
  });

  it('rejects startAndDeliver with the error the start failed with', async () => {
    const { deps } = setup();
    const delivery = new MessageDelivery(deps);
    const failure = new Error('no capacity');
    await expect(
      delivery.startAndDeliver('AR', 'dev', { type: 'general' } as Session['workItem'], async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await delivery.close();
  });

  it('rejects flushWaiting with the error typing failed with', async () => {
    const { deps, add } = setup();
    add('m1');
    const delivery = new MessageDelivery(deps);
    await expect(delivery.flushWaiting(session)).rejects.toThrow('not taken');
    await delivery.close();
  });
});
