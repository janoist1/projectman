import { Clock, Deferred, Effect, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  makeMachineRounds,
  MachineRounds,
  type MachineRoundsEffects,
  type MachineRoundsOptions,
} from './machine-rounds';

const settled = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
const advance = (ms: number) => Effect.andThen(TestClock.adjust(ms), settled);
const logger = () => ({ warn: vi.fn() }) as unknown as FastifyBaseLogger;

function run(
  options: MachineRoundsOptions,
  body: (core: MachineRoundsEffects) => Effect.Effect<void, never, Scope.Scope>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* Effect.gen(function* () {
          const core = yield* makeMachineRounds(options);
          yield* body(core);
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
}

describe('Machine rounds', () => {
  it('shares a running measurement after a request times out', async () => {
    let finish!: () => void;
    const measure = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await run({ measure, nextDelay: () => null, wanted: () => true, logger: logger() }, (core) =>
      Effect.gen(function* () {
        const first = yield* Effect.forkScoped(core.roundWithin(10), { startImmediately: true });
        const second = yield* Effect.forkScoped(core.round, { startImmediately: true });
        yield* advance(10);
        yield* Fiber.join(first);
        expect(measure).toHaveBeenCalledTimes(1);
        let done = false;
        const third = yield* Effect.forkScoped(
          core.round.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                done = true;
              }),
            ),
          ),
          { startImmediately: true },
        );
        expect(done).toBe(false);
        finish();
        yield* Fiber.join(second);
        yield* Fiber.join(third);
        expect(measure).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it.each([0, 20])(
    'schedules at the exact deadline with a minimum of one millisecond (%s)',
    async (delay) => {
      let next: number | null = delay;
      const measure = vi.fn(async () => {
        next = null;
      });
      await run({ measure, nextDelay: () => next, wanted: () => true, logger: logger() }, (core) =>
        Effect.gen(function* () {
          yield* core.schedule;
          yield* advance(Math.max(1, delay) - 1);
          expect(measure).not.toHaveBeenCalled();
          yield* advance(1);
          expect(measure).toHaveBeenCalledTimes(1);
        }),
      );
    },
  );

  it('checks demand when due and cancels an armed round when demand disappears', async () => {
    let wanted = false;
    let next: number | null = 20;
    const measure = vi.fn(async () => {});
    await run({ measure, nextDelay: () => next, wanted: () => wanted, logger: logger() }, (core) =>
      Effect.gen(function* () {
        yield* core.schedule;
        yield* advance(20);
        expect(measure).not.toHaveBeenCalled();
        wanted = true;
        yield* core.schedule;
        next = null;
        yield* core.schedule;
        yield* advance(20);
        expect(measure).not.toHaveBeenCalled();
      }),
    );
  });

  it('logs a failure and arms the next round', async () => {
    const log = logger();
    const error = new Error('failed');
    let next: number | null = 20;
    const measure = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(async () => {
        next = null;
      });
    await run({ measure, nextDelay: () => next, wanted: () => true, logger: log }, (core) =>
      Effect.gen(function* () {
        yield* core.round;
        expect(log.warn).toHaveBeenCalledWith({ err: error }, 'the machine measurement failed');
        yield* advance(20);
        expect(measure).toHaveBeenCalledTimes(2);
      }),
    );
  });

  it('stop waits for a running round and prevents later rounds', async () => {
    let finish!: () => void;
    const measure = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await run({ measure, nextDelay: () => 20, wanted: () => true, logger: logger() }, (core) =>
      Effect.gen(function* () {
        const round = yield* Effect.forkScoped(core.round, { startImmediately: true });
        const stopped = Deferred.makeUnsafe<void>();
        const stop = yield* Effect.forkScoped(
          core.stop.pipe(Effect.andThen(Deferred.succeed(stopped, undefined))),
          { startImmediately: true },
        );
        expect(yield* Deferred.isDone(stopped)).toBe(false);
        finish();
        yield* Fiber.join(round);
        yield* Fiber.join(stop);
        yield* core.schedule;
        yield* core.round;
        yield* advance(40);
        expect(measure).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('cancels the timer seam when replacing and stopping it', async () => {
    const cancel = vi.fn();
    const after = vi.fn(() => cancel);
    const rounds = new MachineRounds({
      measure: async () => {},
      nextDelay: () => 20,
      wanted: () => true,
      logger: logger(),
      after,
    });
    rounds.schedule();
    rounds.schedule();
    expect(cancel).toHaveBeenCalledTimes(1);
    await rounds.stop();
    expect(cancel).toHaveBeenCalledTimes(2);
    rounds.schedule();
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('leaves no timers after the facade stops', async () => {
    vi.useFakeTimers();
    try {
      const rounds = new MachineRounds({
        measure: async () => {},
        nextDelay: () => 20,
        wanted: () => true,
        logger: logger(),
      });
      rounds.schedule();
      expect(vi.getTimerCount()).toBe(1);
      await rounds.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
