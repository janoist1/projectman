import { Clock, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it, vi } from 'vitest';
import { makePollLoop, type PollLoopDeps, type PollLoopEffects } from './poll-loop';
import { createTestLogger } from './test-fixtures/harness';

const settled = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
const advance = (ms: number) => Effect.andThen(TestClock.adjust(ms), settled);

function setup(dueAt = 1000) {
  const state = { dueAt };
  const logger = createTestLogger();
  const round = vi.fn(async (_signal: AbortSignal) => {
    state.dueAt = Number.POSITIVE_INFINITY;
  });
  const deps: PollLoopDeps = { nextDueAt: () => state.dueAt, round, logger };
  return { state, logger, round, deps };
}

function run(deps: PollLoopDeps, body: (core: PollLoopEffects) => Effect.Effect<void>) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* Effect.gen(function* () {
          const core = yield* makePollLoop(deps);
          yield* body(core);
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
}

describe('pull request polling loop under TestClock', () => {
  it('waits until the exact due millisecond', async () => {
    const { deps, round } = setup();
    await run(deps, (core) =>
      Effect.gen(function* () {
        yield* core.schedule;
        yield* advance(999);
        expect(round).not.toHaveBeenCalled();
        yield* advance(1);
        expect(round).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('replaces an armed wait only when the new due time is earlier', async () => {
    const { deps, round, state } = setup();
    await run(deps, (core) =>
      Effect.gen(function* () {
        yield* core.schedule;
        state.dueAt = 2000;
        yield* core.schedule;
        yield* advance(999);
        expect(round).not.toHaveBeenCalled();
        yield* advance(1);
        expect(round).toHaveBeenCalledTimes(1);
        state.dueAt = 3000;
        yield* core.schedule;
        state.dueAt = 1500;
        yield* core.schedule;
        yield* advance(499);
        expect(round).toHaveBeenCalledTimes(1);
        yield* advance(1);
        expect(round).toHaveBeenCalledTimes(2);
      }),
    );
  });

  it('waits at least one millisecond after a round whose next due time has passed', async () => {
    const { deps, round, state } = setup();
    round.mockImplementation(async () => {
      state.dueAt = 0;
    });
    await run(deps, (core) =>
      Effect.gen(function* () {
        yield* core.schedule;
        yield* advance(1000);
        expect(round).toHaveBeenCalledTimes(1);
        yield* advance(0);
        expect(round).toHaveBeenCalledTimes(1);
        yield* advance(1);
        expect(round).toHaveBeenCalledTimes(2);
        state.dueAt = Number.POSITIVE_INFINITY;
        yield* core.halt;
      }),
    );
  });

  it('does not replace a running round and rearms itself after it settles', async () => {
    const { deps, round, state } = setup();
    let finish!: () => void;
    round.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await run(deps, (core) =>
      Effect.gen(function* () {
        yield* core.schedule;
        yield* advance(1000);
        state.dueAt = 0;
        yield* core.schedule;
        yield* advance(100);
        expect(round).toHaveBeenCalledTimes(1);
        expect(round.mock.calls[0]![0].aborted).toBe(false);
        finish();
        yield* settled;
        yield* advance(0);
        expect(round).toHaveBeenCalledTimes(1);
        yield* advance(1);
        expect(round).toHaveBeenCalledTimes(2);
      }),
    );
  });

  it('aborts immediately, waits for the round and rearms a subscriber arriving during cleanup', async () => {
    const { deps, round, state, logger } = setup();
    let finish!: () => void;
    let halted = false;
    round.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await run(deps, (core) =>
      Effect.gen(function* () {
        yield* core.schedule;
        yield* advance(1000);
        state.dueAt = Number.POSITIVE_INFINITY;
        const halt = yield* Effect.forkChild(
          core.halt.pipe(
            Effect.andThen(
              Effect.sync(() => {
                halted = true;
              }),
            ),
          ),
          { startImmediately: true },
        );
        expect(round.mock.calls[0]![0].aborted).toBe(true);
        expect(halted).toBe(false);
        state.dueAt = 2000;
        yield* core.schedule;
        finish();
        yield* Fiber.join(halt);
        expect(halted).toBe(true);
        yield* advance(999);
        expect(round).toHaveBeenCalledTimes(1);
        yield* advance(1);
        expect(round).toHaveBeenCalledTimes(2);
        expect(logger.error).not.toHaveBeenCalled();
      }),
    );
  });

  it('logs a rejected round once and continues polling', async () => {
    const { deps, round, state, logger } = setup();
    const cause = new Error('round failed');
    round.mockRejectedValueOnce(cause);
    await run(deps, (core) =>
      Effect.gen(function* () {
        yield* core.schedule;
        yield* advance(1000);
        expect(logger.error).toHaveBeenCalledExactlyOnceWith(
          { err: cause },
          'github: pull request polling round failed',
        );
        state.dueAt = 1001;
        yield* advance(1);
        expect(round).toHaveBeenCalledTimes(2);
      }),
    );
  });

  it('ends when nothing is due and can start a fresh cycle later', async () => {
    const { deps, round, state } = setup(Number.POSITIVE_INFINITY);
    await run(deps, (core) =>
      Effect.gen(function* () {
        yield* core.schedule;
        yield* advance(1000);
        expect(round).not.toHaveBeenCalled();
        state.dueAt = 1001;
        yield* core.schedule;
        yield* advance(1);
        expect(round).toHaveBeenCalledTimes(1);
        yield* advance(1000);
        expect(round).toHaveBeenCalledTimes(1);
        state.dueAt = 2002;
        yield* core.schedule;
        yield* advance(1);
        expect(round).toHaveBeenCalledTimes(2);
      }),
    );
  });
});
