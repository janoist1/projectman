import { Clock, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFork } from '../../kernel';
import { ScheduleService, type ScheduleDeps } from './schedules';
import { makeScheduleTimer, MinuteTimer, type ScheduleTimerEffects } from './timer';

const settled = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
const advance = (ms: number) => Effect.andThen(TestClock.adjust(ms), settled);

function run(body: (timer: ScheduleTimerEffects, clock: Clock.Clock) => Effect.Effect<void>) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* Effect.gen(function* () {
          const timer = yield* makeScheduleTimer;
          yield* body(timer, clock);
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
}

describe('Schedule timer core', () => {
  it('calls once at the requested millisecond', async () => {
    const callback = vi.fn();
    await run((timer) =>
      Effect.gen(function* () {
        yield* timer.set(callback, 30_000);
        yield* advance(29_999);
        expect(callback).not.toHaveBeenCalled();
        yield* advance(1);
        expect(callback).toHaveBeenCalledTimes(1);
        yield* advance(60_000);
        expect(callback).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('replaces the pending call', async () => {
    const first = vi.fn();
    const second = vi.fn();
    await run((timer) =>
      Effect.gen(function* () {
        yield* timer.set(first, 30_000);
        yield* advance(10_000);
        yield* timer.set(second, 30_000);
        yield* advance(29_999);
        expect(first).not.toHaveBeenCalled();
        expect(second).not.toHaveBeenCalled();
        yield* advance(1);
        expect(second).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('clears the pending call without invoking it', async () => {
    const callback = vi.fn();
    await run((timer) =>
      Effect.gen(function* () {
        yield* timer.set(callback, 30_000);
        yield* timer.clear;
        yield* advance(60_000);
        expect(callback).not.toHaveBeenCalled();
      }),
    );
  });

  it('allows a callback to arm the next call without interrupting itself', async () => {
    const second = vi.fn();
    await run((timer, clock) =>
      Effect.gen(function* () {
        const first = vi.fn(() => {
          runFork(timer.set(second, 30_000).pipe(Effect.provideService(Clock.Clock, clock)));
        });
        yield* timer.set(first, 30_000);
        yield* advance(30_000);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
        yield* advance(30_000);
        expect(second).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('drops the pending call when its scope closes', async () => {
    const callback = vi.fn();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make();
          yield* Effect.gen(function* () {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const timer = yield* makeScheduleTimer;
                yield* timer.set(callback, 30_000);
              }),
            );
            yield* advance(60_000);
            expect(callback).not.toHaveBeenCalled();
          }).pipe(Effect.provideService(Clock.Clock, clock));
        }),
      ),
    );
  });
});

describe('MinuteTimer facade', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls on the timer turn and leaves no timer after close', async () => {
    const timer = new MinuteTimer();
    const callback = vi.fn();
    try {
      expect(timer.set(callback, 60_000)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(60_000);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      await timer.close();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a sleeping timer on close without calling back', async () => {
    const timer = new MinuteTimer();
    const callback = vi.fn();
    timer.set(callback, 60_000);
    expect(vi.getTimerCount()).toBe(1);
    await timer.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it('arms the next timer directly from a callback', async () => {
    const timer = new MinuteTimer();
    const second = vi.fn();
    try {
      timer.set(() => timer.set(second, 60_000), 60_000);
      vi.advanceTimersByTime(60_000);
      expect(second).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(60_000);
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      await timer.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains the default timer when ScheduleService stops', async () => {
    const unsubscribe = vi.fn();
    const deps = {
      ctx: {
        events: { on: () => unsubscribe },
        repos: { schedules: { live: () => [] } },
        now: () => new Date(0),
        logger: { warn: vi.fn() },
      },
      projects: { summaries: () => [] },
      admission: {},
      timeline: {},
    } as unknown as ScheduleDeps;
    const schedules = new ScheduleService(deps);
    try {
      schedules.start();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await schedules.stop();
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
