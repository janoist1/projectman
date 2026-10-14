import { Clock, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shutdownWait, waitForShutdownStops, type ShutdownWaitDeps } from './shutdown-wait';

/**
 * The shutdown wait's Effect program under the TestClock (the poll counter to the millisecond), and the
 * facade under fake timers. The end-to-end shutdown is covered by test/pause-shutdown.test.ts.
 */

function depsOf(overrides: Partial<ShutdownWaitDeps> = {}) {
  const state = { stopping: true, polls: 0 };
  const forceLater = vi.fn(async () => {});
  const deps: ShutdownWaitDeps = {
    waitMs: 1_000,
    graceMs: 1_000,
    pollMs: 50,
    stillStopping: () => {
      state.polls += 1;
      return state.stopping;
    },
    forceLater,
    ...overrides,
  };
  return { deps, state, forceLater };
}

/** Runs `body` under a TestClock. */
function run<A>(body: Effect.Effect<A>): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        return yield* body.pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
}

/** Starts the wait in the background; `finished.done` turns true when it ends. */
function startWait(deps: ShutdownWaitDeps) {
  const finished = { done: false };
  const fiber = Effect.forkChild(
    Effect.ensuring(
      shutdownWait(deps),
      Effect.sync(() => {
        finished.done = true;
      }),
    ),
    { startImmediately: true },
  );
  return { finished, fiber };
}

const adjust = (ms: number) => TestClock.adjust(ms);
/** Lets the promises of the fake deps settle. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe('shutdown wait under the TestClock', () => {
  it('is done at once when nothing is stopping: no force, no sleep', async () => {
    const { deps, forceLater, state } = depsOf();
    state.stopping = false;
    await run(shutdownWait(deps));
    expect(forceLater).not.toHaveBeenCalled();
    expect(state.polls).toBe(1);
  });

  it('asks again after each poll and ends when nothing is stopping', async () => {
    const { deps, state } = depsOf({ pollMs: 50 });
    await run(
      Effect.gen(function* () {
        const { finished, fiber } = startWait(deps);
        yield* fiber;
        expect(state.polls).toBe(1);
        yield* adjust(49);
        yield* settle;
        expect(state.polls).toBe(1);
        yield* adjust(1);
        yield* settle;
        expect(state.polls).toBe(2);
        expect(finished.done).toBe(false);
        state.stopping = false;
        yield* adjust(50);
        yield* settle;
        expect(state.polls).toBe(3);
        expect(finished.done).toBe(true);
      }),
    );
  });

  it('cuts exactly once, after the second sleep, when the deadline passes', async () => {
    const { deps, forceLater } = depsOf({ waitMs: 100, graceMs: 1_000, pollMs: 50 });
    await run(
      Effect.gen(function* () {
        yield* startWait(deps).fiber;
        yield* adjust(99);
        yield* settle;
        expect(forceLater).not.toHaveBeenCalled();
        yield* adjust(1);
        yield* settle;
        expect(forceLater).toHaveBeenCalledTimes(1);
        yield* adjust(500);
        yield* settle;
        expect(forceLater).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('cuts before the first sleep when the deadline is zero', async () => {
    const { deps, forceLater, state } = depsOf({ waitMs: 0, graceMs: 1_000, pollMs: 50 });
    await run(
      Effect.gen(function* () {
        yield* startWait(deps).fiber;
        yield* settle;
        expect(forceLater).toHaveBeenCalledTimes(1);
        expect(state.polls).toBe(1);
        yield* adjust(1_000);
        yield* settle;
        expect(forceLater).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('gives up at the deadline plus the grace (three sleeps)', async () => {
    const { deps, forceLater } = depsOf({ waitMs: 50, graceMs: 100, pollMs: 50 });
    await run(
      Effect.gen(function* () {
        const { finished, fiber } = startWait(deps);
        yield* fiber;
        yield* adjust(149);
        yield* settle;
        expect(finished.done).toBe(false);
        yield* adjust(1);
        yield* settle;
        expect(finished.done).toBe(true);
        expect(forceLater).toHaveBeenCalledTimes(1);
      }),
    );
  });
});

describe('waitForShutdownStops facade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with the original error when the cut fails', async () => {
    const error = new Error('boom');
    const { deps } = depsOf({ waitMs: 0, forceLater: async () => Promise.reject(error) });
    await expect(waitForShutdownStops(deps)).rejects.toBe(error);
  });

  it('resolves a normal run and leaves no timer behind', async () => {
    const { deps, state } = depsOf({ pollMs: 50 });
    const done = vi.fn();
    const wait = waitForShutdownStops(deps).then(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(done).not.toHaveBeenCalled();
    state.stopping = false;
    await vi.advanceTimersByTimeAsync(50);
    await wait;
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
