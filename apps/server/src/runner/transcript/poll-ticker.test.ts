import { Clock, Effect, Exit, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it, vi } from 'vitest';
import { runPromise } from '../../kernel';
import { pollEvery } from './poll-ticker';

describe('poll ticker under the TestClock', () => {
  it.each([10, 0])('ticks at the clamped interval %i and stops with its scope', async (interval) => {
    const tick = vi.fn();
    await runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make();
          yield* Effect.gen(function* () {
            const scope = Scope.makeUnsafe();
            yield* Effect.forkIn(pollEvery(interval, tick), scope, { startImmediately: true });
            yield* Effect.ensuring(
              Effect.gen(function* () {
                const ms = Math.max(1, interval);
                yield* TestClock.adjust(ms - 1);
                expect(tick).not.toHaveBeenCalled();
                yield* TestClock.adjust(1);
                expect(tick).toHaveBeenCalledTimes(1);
                yield* TestClock.adjust(ms);
                expect(tick).toHaveBeenCalledTimes(2);
                yield* Scope.close(scope, Exit.void);
                yield* TestClock.adjust(ms * 10);
                expect(tick).toHaveBeenCalledTimes(2);
              }),
              Scope.close(scope, Exit.void),
            );
          }).pipe(Effect.provideService(Clock.Clock, clock));
        }),
      ),
    );
  });
});
