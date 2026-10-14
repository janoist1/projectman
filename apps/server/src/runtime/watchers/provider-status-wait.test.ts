import { Clock, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import { statusWithin } from './provider-status-wait';

const settled = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe('Provider status wait', () => {
  it('returns answers and drops rejected or synchronously thrown failures', async () => {
    expect(await Effect.runPromise(statusWithin(() => Promise.resolve('ready'), 20))).toBe('ready');
    expect(await Effect.runPromise(statusWithin(() => Promise.resolve(null), 20))).toBeNull();
    expect(await Effect.runPromise(statusWithin(() => Promise.reject(new Error('failed')), 20))).toBeNull();
    expect(
      await Effect.runPromise(
        statusWithin(() => {
          throw new Error('failed');
        }, 20),
      ),
    ).toBeNull();
  });

  it('waits exactly until the deadline and drops a late answer', async () => {
    let resolve!: (value: string) => void;
    const answer = new Promise<string>((done) => {
      resolve = done;
    });
    let result: string | null | undefined;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make();
          yield* Effect.gen(function* () {
            const fiber = yield* Effect.forkScoped(
              statusWithin(() => answer, 20).pipe(
                Effect.tap((value) =>
                  Effect.sync(() => {
                    result = value;
                  }),
                ),
              ),
              { startImmediately: true },
            );
            yield* TestClock.adjust(19);
            yield* settled;
            expect(result).toBeUndefined();
            yield* TestClock.adjust(1);
            yield* Fiber.join(fiber);
            expect(result).toBeNull();
            resolve('late');
            yield* settled;
            expect(result).toBeNull();
          }).pipe(Effect.provideService(Clock.Clock, clock));
        }),
      ),
    );
  });
});
