import { Clock, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRefreshLoop, RefreshLoop, type RefreshLoopEffects } from './refresh-loop';

const settled = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
const advance = (ms: number) => Effect.andThen(TestClock.adjust(ms), settled);
const logger = () => ({ warn: vi.fn() }) as unknown as FastifyBaseLogger;

function run(
  tick: () => void,
  body: (loop: RefreshLoopEffects) => Effect.Effect<void>,
  log = logger(),
  intervalMs = 100,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* Effect.gen(function* () {
          const loop = yield* makeRefreshLoop({ intervalMs, tick, logger: log });
          yield* body(loop);
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
}

describe('Refresh loop core', () => {
  it('waits a full interval before each tick', async () => {
    const tick = vi.fn();
    await run(tick, (loop) =>
      Effect.gen(function* () {
        yield* loop.start;
        yield* advance(99);
        expect(tick).not.toHaveBeenCalled();
        yield* advance(1);
        expect(tick).toHaveBeenCalledTimes(1);
        yield* advance(100);
        expect(tick).toHaveBeenCalledTimes(2);
      }),
    );
  });

  it('replaces the running schedule on a second start', async () => {
    const tick = vi.fn();
    await run(tick, (loop) =>
      Effect.gen(function* () {
        yield* loop.start;
        yield* advance(50);
        yield* loop.start;
        yield* advance(99);
        expect(tick).not.toHaveBeenCalled();
        yield* advance(1);
        expect(tick).toHaveBeenCalledTimes(1);
        yield* advance(100);
        expect(tick).toHaveBeenCalledTimes(2);
      }),
    );
  });

  it('stops ticking and can start again', async () => {
    const tick = vi.fn();
    await run(tick, (loop) =>
      Effect.gen(function* () {
        yield* loop.start;
        yield* advance(100);
        yield* loop.stop;
        yield* advance(300);
        expect(tick).toHaveBeenCalledTimes(1);
        yield* loop.start;
        yield* advance(100);
        expect(tick).toHaveBeenCalledTimes(2);
      }),
    );
  });

  it('logs a throwing tick and continues with the next interval', async () => {
    const error = new Error('probe failed');
    const tick = vi.fn().mockImplementationOnce(() => {
      throw error;
    });
    const log = logger();
    await run(
      tick,
      (loop) =>
        Effect.gen(function* () {
          yield* loop.start;
          yield* advance(100);
          expect(log.warn).toHaveBeenCalledWith({ err: error }, 'plan usage refresh failed');
          yield* advance(100);
          expect(tick).toHaveBeenCalledTimes(2);
          expect(log.warn).toHaveBeenCalledTimes(1);
        }),
      log,
    );
  });

  it('clamps a zero interval to one millisecond', async () => {
    const tick = vi.fn();
    await run(
      tick,
      (loop) =>
        Effect.gen(function* () {
          yield* loop.start;
          expect(tick).not.toHaveBeenCalled();
          yield* advance(1);
          expect(tick).toHaveBeenCalledTimes(1);
        }),
      logger(),
      0,
    );
  });
});

describe('RefreshLoop facade', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('owns one timer and drops it on stop, including after restarting', async () => {
    const tick = vi.fn();
    const loop = new RefreshLoop({ intervalMs: 100, tick, logger: logger() });
    try {
      loop.start();
      expect(vi.getTimerCount()).toBe(1);
      loop.start();
      expect(vi.getTimerCount()).toBe(1);
      loop.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      loop.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(tick).toHaveBeenCalledTimes(1);
    } finally {
      loop.stop();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
