import { Clock, Effect, Exit, Fiber, Scope } from 'effect';
import type { Fiber as FiberType } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InputQueue,
  makeInputQueue,
  NotSubmittedError,
  SessionGoneError,
  type InputQueueEffects,
  type InputQueueHost,
} from './input-queue';
import { silentLogger } from './test-helpers';
import { ENTER_KEY, PASTE_END, PASTE_START } from './typing';

/**
 * The Effect program of the input queue under the TestClock: time moves only when the test says so,
 * exactly to the millisecond. The facade's own checks (fake timers) are at the end.
 */

const timing = {
  stepDelayMs: 10,
  enterDelayMs: 100,
  enterRetryMs: 1_000,
  maxEnterRetries: 2,
  submitTimeoutMs: 5_000,
  lateSubmitMs: 20_000,
};
/** Time to type a one-piece message and press Enter. */
const TYPE_MS = timing.stepDelayMs + timing.enterDelayMs;

function hostOf(overrides: Partial<InputQueueHost> = {}) {
  const writes: string[] = [];
  const state = { idle: true };
  const warn = vi.fn();
  const host: InputQueueHost = {
    sessionId: 'ses_1',
    timing,
    logger: { ...silentLogger(), warn } as unknown as InputQueueHost['logger'],
    isIdle: () => state.idle,
    checkBeforeTyping: () => 0,
    write: (data) => writes.push(data),
    ...overrides,
  };
  const typed = () => ({
    pastes: writes.filter((w) => w.startsWith(PASTE_START)).map((w) => w.slice(6, -PASTE_END.length)),
    enters: writes.filter((w) => w === ENTER_KEY).length,
    writes: writes.length,
  });
  return { host, state, warn, typed };
}

/** Runs `body` with a queue built in its own scope, under a TestClock. */
function run<A>(
  host: InputQueueHost,
  body: (queue: InputQueueEffects, scope: Scope.Closeable) => Effect.Effect<A>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        return yield* Effect.gen(function* () {
          const scope = Scope.makeUnsafe();
          const queue = yield* Scope.provide(makeInputQueue(host), scope);
          return yield* Effect.ensuring(body(queue, scope), Scope.close(scope, Exit.void));
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
}

/** Starts an effect in the background and lets it run to its first wait. */
const start = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkChild(Effect.exit(effect), { startImmediately: true });

const failureOf = <A, E>(fiber: FiberType.Fiber<Exit.Exit<A, E>>) =>
  Effect.map(Fiber.join(fiber), (exit) => (Exit.isFailure(exit) ? exit.cause : undefined));

const adjust = (ms: number) => TestClock.adjust(ms);

describe('input queue under the TestClock', () => {
  it('warns once at ten minutes with waiting messages, even when hold is repeated', async () => {
    const { host, warn } = hostOf();
    await run(host, (queue) =>
      Effect.gen(function* () {
        yield* queue.hold;
        yield* start(queue.enqueue('waiting'));
        yield* adjust(9 * 60_000);
        yield* queue.hold;
        yield* adjust(60_000 - 1);
        expect(warn).not.toHaveBeenCalled();
        yield* adjust(1);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          { sessionId: 'ses_1', queued: 1, heldMs: 10 * 60_000 },
          'input held with waiting messages',
        );
        yield* queue.hold;
        yield* adjust(20 * 60_000);
        expect(warn).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('cancels the warning when unheld at nine minutes and starts a fresh warning on the next hold', async () => {
    const { host, state, warn } = hostOf();
    state.idle = false;
    await run(host, (queue) =>
      Effect.gen(function* () {
        yield* queue.hold;
        yield* start(queue.enqueue('waiting'));
        yield* adjust(9 * 60_000);
        yield* queue.unhold();
        yield* adjust(2 * 60_000);
        expect(warn).not.toHaveBeenCalled();
        yield* queue.hold;
        yield* adjust(10 * 60_000);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          { sessionId: 'ses_1', queued: 1, heldMs: 10 * 60_000 },
          'input held with waiting messages',
        );
      }),
    );
  });

  it('does not warn when the held queue is empty', async () => {
    const { host, warn } = hostOf();
    await run(host, (queue) =>
      Effect.gen(function* () {
        yield* queue.hold;
        yield* adjust(20 * 60_000);
        expect(warn).not.toHaveBeenCalled();
      }),
    );
  });

  it('does not warn after closing a held queue with waiting messages', async () => {
    const { host, warn } = hostOf();
    await run(host, (queue, scope) =>
      Effect.gen(function* () {
        yield* queue.hold;
        const waiting = yield* start(queue.enqueue('waiting'));
        yield* adjust(9 * 60_000);
        yield* Scope.close(scope, Exit.void);
        expect(String(yield* failureOf(waiting))).toContain('exited');
        yield* adjust(20 * 60_000);
        expect(warn).not.toHaveBeenCalled();
      }),
    );
  });

  it('stops waiting at submitTimeoutMs and types the next message, but fails a silent one only at lateSubmitMs', async () => {
    const { host, typed, warn } = hostOf();
    await run(host, (queue) =>
      Effect.gen(function* () {
        const first = yield* start(queue.enqueueSubmitted('first'));
        const second = yield* start(queue.enqueue('second'));
        yield* adjust(TYPE_MS);
        expect(typed().pastes).toEqual(['first']);
        expect(queue.state().awaitingSubmit).toBe(true);

        yield* adjust(timing.submitTimeoutMs - 1);
        expect(queue.state().awaitingSubmit).toBe(true);
        expect(warn).not.toHaveBeenCalled();
        expect(typed().pastes).toEqual(['first']);

        yield* adjust(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(queue.state().awaitingSubmit).toBe(false);
        // The next message is typed now; the first one is still waited for.
        yield* adjust(TYPE_MS);
        expect(typed().pastes).toEqual(['first', 'second']);
        yield* Fiber.join(second);

        yield* adjust(timing.lateSubmitMs - TYPE_MS - 1);
        expect(first.pollUnsafe()).toBeUndefined();
        yield* adjust(1);
        const cause = yield* failureOf(first);
        expect(String(cause)).toContain(new NotSubmittedError('ses_1').message);
      }),
    );
  });

  it.each([
    ['a turn hook came', (_state: { idle: boolean }, queue: InputQueueEffects) => queue.noteTurnActivity],
    [
      'the CLI left idle',
      (state: { idle: boolean }) =>
        Effect.sync(() => {
          state.idle = false;
        }),
    ],
  ])('takes a typed message as unconfirmed at submitTimeoutMs when %s', async (_name, signal) => {
    const { host, state, typed } = hostOf();
    await run(host, (queue) =>
      Effect.gen(function* () {
        const message = yield* start(queue.enqueueSubmitted('busy'));
        yield* adjust(TYPE_MS);
        yield* signal(state, queue);
        yield* adjust(timing.submitTimeoutMs);
        expect(yield* failureOf(message)).toBeUndefined();
        expect(typed().pastes).toEqual(['busy']);
      }),
    );
  });

  it.each([
    ['a submission', (queue: InputQueueEffects) => queue.submitted],
    ['a turn hook', (queue: InputQueueEffects) => queue.noteTurnActivity],
  ])('takes a silent message late when %s comes within lateSubmitMs', async (_name, signal) => {
    const { host, typed } = hostOf();
    await run(host, (queue) =>
      Effect.gen(function* () {
        const message = yield* start(queue.enqueueSubmitted('quiet'));
        yield* adjust(TYPE_MS + timing.submitTimeoutMs);
        expect(message.pollUnsafe()).toBeUndefined();
        expect(queue.state().awaitingSubmit).toBe(false);
        yield* adjust(timing.lateSubmitMs / 2);
        yield* signal(queue);
        expect(yield* failureOf(message)).toBeUndefined();
        // No new text was typed, and the expired late wait raises nothing.
        yield* adjust(timing.lateSubmitMs);
        expect(typed().pastes).toEqual(['quiet']);
      }),
    );
  });

  it('does not hold a late message in pending input, and fails it when the scope closes', async () => {
    const { host } = hostOf();
    await run(host, (queue, scope) =>
      Effect.gen(function* () {
        const message = yield* start(queue.enqueueSubmitted('quiet'));
        yield* adjust(TYPE_MS + timing.submitTimeoutMs);
        expect(queue.state()).toMatchObject({ typing: false, queued: 0, awaitingSubmit: false });
        yield* Scope.close(scope, Exit.void);
        expect(String(yield* failureOf(message))).toContain('exited');
      }),
    );
  });

  describe('deliveryId', () => {
    const DELIVERY = 'dlv_00000000000000000000000000000001';

    it('joins a repeated call to the message still awaited instead of typing it again', async () => {
      const { host, typed } = hostOf();
      await run(host, (queue) =>
        Effect.gen(function* () {
          const first = yield* start(queue.enqueueSubmitted('once', DELIVERY));
          yield* adjust(TYPE_MS);
          const repeat = yield* start(queue.enqueueSubmitted('once', DELIVERY));
          yield* queue.submitted;
          expect(yield* failureOf(first)).toBeUndefined();
          expect(yield* failureOf(repeat)).toBeUndefined();
          expect(typed().pastes).toEqual(['once']);
        }),
      );
    });

    it('does not type a message again that the CLI took', async () => {
      const { host, typed } = hostOf();
      await run(host, (queue) =>
        Effect.gen(function* () {
          const first = yield* start(queue.enqueueSubmitted('once', DELIVERY));
          yield* adjust(TYPE_MS);
          yield* queue.submitted;
          yield* Fiber.join(first);
          const repeat = yield* start(queue.enqueueSubmitted('once', DELIVERY));
          yield* adjust(TYPE_MS);
          expect(yield* failureOf(repeat)).toBeUndefined();
          expect(typed().pastes).toEqual(['once']);
        }),
      );
    });

    it('types a message again that the CLI never took', async () => {
      const { host, typed } = hostOf();
      await run(host, (queue) =>
        Effect.gen(function* () {
          const first = yield* start(queue.enqueueSubmitted('again', DELIVERY));
          yield* adjust(TYPE_MS + timing.submitTimeoutMs + timing.lateSubmitMs);
          expect(yield* failureOf(first)).toBeDefined();
          const repeat = yield* start(queue.enqueueSubmitted('again', DELIVERY));
          yield* adjust(TYPE_MS);
          yield* queue.submitted;
          expect(yield* failureOf(repeat)).toBeUndefined();
          expect(typed().pastes).toEqual(['again', 'again']);
        }),
      );
    });
  });

  it('presses Enter again every enterRetryMs, at most maxEnterRetries times', async () => {
    const { host, typed } = hostOf();
    await run(host, (queue) =>
      Effect.gen(function* () {
        yield* start(queue.enqueue('hello'));
        yield* adjust(TYPE_MS);
        expect(typed().enters).toBe(1);
        yield* adjust(timing.enterRetryMs - 1);
        expect(typed().enters).toBe(1);
        yield* adjust(1);
        expect(typed().enters).toBe(2);
        yield* adjust(timing.enterRetryMs);
        expect(typed().enters).toBe(3);
        yield* adjust(timing.enterRetryMs);
        expect(typed().enters).toBe(3);
      }),
    );
  });

  it('presses no Enter again once the CLI reported the prompt', async () => {
    const { host, typed } = hostOf();
    await run(host, (queue) =>
      Effect.gen(function* () {
        yield* start(queue.enqueue('hello'));
        yield* adjust(TYPE_MS);
        yield* adjust(timing.enterRetryMs);
        expect(typed().enters).toBe(2);
        yield* queue.submitted;
        yield* adjust(timing.submitTimeoutMs);
        expect(typed().enters).toBe(2);
        expect(queue.state().awaitingSubmit).toBe(false);
      }),
    );
  });

  it('does not press Enter again after a slash command', async () => {
    const { host, typed } = hostOf();
    await run(host, (queue) =>
      Effect.gen(function* () {
        yield* start(queue.enqueue('/clear'));
        yield* adjust(TYPE_MS + timing.submitTimeoutMs);
        expect(typed().enters).toBe(1);
      }),
    );
  });

  it('fails the message and writes nothing more when the scope closes between typing steps', async () => {
    const { host, typed } = hostOf();
    await run(host, (queue, scope) =>
      Effect.gen(function* () {
        const message = yield* start(queue.enqueue('one\ntwo'));
        // Typed so far: the first piece; the sleep after it is running.
        expect(typed().writes).toBe(1);
        yield* adjust(timing.stepDelayMs / 2);
        yield* Scope.close(scope, Exit.void);
        const writesAtClose = typed().writes;
        const cause = yield* failureOf(message);
        expect(cause).toBeDefined();
        expect(String(cause)).toContain(new SessionGoneError('ses_1', 'exited').message);
        yield* adjust(timing.submitTimeoutMs * 2);
        expect(typed().writes).toBe(writesAtClose);
        expect(queue.state()).toMatchObject({
          closed: true,
          typing: false,
          queued: 0,
          awaitingSubmit: false,
        });
      }),
    );
  });

  it('fails queued messages and an awaited submit when the scope closes', async () => {
    const { host, state } = hostOf();
    await run(host, (queue, scope) =>
      Effect.gen(function* () {
        const taken = yield* start(queue.enqueueSubmitted('first'));
        yield* adjust(TYPE_MS);
        state.idle = false;
        const queued = yield* start(queue.enqueue('second'));
        yield* Scope.close(scope, Exit.void);
        expect(String(yield* failureOf(taken))).toContain('exited');
        expect(String(yield* failureOf(queued))).toContain('exited');
        const late = yield* start(queue.enqueue('late'));
        expect(String(yield* failureOf(late))).toContain('is not running');
      }),
    );
  });

  it('types nothing new while held, finishes the message being typed, and puts `first` ahead on unhold', async () => {
    const { host, typed } = hostOf();
    await run(host, (queue) =>
      Effect.gen(function* () {
        yield* start(queue.enqueue('half\ntyped'));
        yield* adjust(timing.stepDelayMs);
        yield* queue.hold;
        yield* start(queue.enqueue('waiting'));
        yield* adjust(TYPE_MS + timing.stepDelayMs * 2);
        // The half-typed message went on to its Enter; the waiting one stayed back.
        expect(typed().pastes).toEqual(['half', 'typed']);
        expect(typed().enters).toBeGreaterThanOrEqual(1);
        expect(queue.state().queued).toBe(1);

        yield* adjust(timing.submitTimeoutMs);
        expect(typed().pastes).toEqual(['half', 'typed']);

        yield* queue.unhold('first');
        yield* adjust(TYPE_MS);
        expect(typed().pastes).toEqual(['half', 'typed', 'first']);
        // The waiting message follows once the CLI took `first`.
        yield* queue.submitted;
        yield* queue.pump;
        yield* adjust(TYPE_MS);
        expect(typed().pastes).toEqual(['half', 'typed', 'first', 'waiting']);
      }),
    );
  });
});

describe('InputQueue facade timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the held warning timer on unhold', async () => {
    const { host, warn } = hostOf();
    const queue = new InputQueue(host);
    queue.hold();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    queue.unhold();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(warn).not.toHaveBeenCalled();
    queue.close();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('leaves no held warning timer or warning after close', async () => {
    const { host, warn } = hostOf();
    const queue = new InputQueue(host);
    queue.hold();
    const waiting = expect(queue.enqueue('waiting')).rejects.toThrow('exited');
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    queue.close();
    await vi.advanceTimersByTimeAsync(0);
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
    queue.hold();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves no timer behind after close, with a scheduled pump, an awaited submit and a queued message', async () => {
    const { host, state } = hostOf();
    const queue = new InputQueue(host);
    const taken = queue.enqueueSubmitted('first');
    const rejected = expect(taken).rejects.toThrow('exited');
    await vi.advanceTimersByTimeAsync(TYPE_MS);
    expect(queue.isAwaitingSubmit).toBe(true);
    state.idle = false;
    const queued = queue.enqueue('second');
    const queuedRejected = expect(queued).rejects.toThrow('exited');
    queue.schedule(60_000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    queue.close();
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    await queuedRejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
