import { Cause, Clock, Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyBudgetExceeded, copyStepsWithin, copyWithinBudget } from './copy-budget';

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function run<A, E>(body: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        return yield* body.pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
}

const turn = () => Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe('copy budget under the TestClock', () => {
  it('runs steps sequentially and finishes successfully', async () => {
    const first = deferred();
    const calls: string[] = [];
    await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          copyStepsWithin(
            [
              async () => {
                calls.push('first');
                await first.promise;
                calls.push('first finished');
              },
              async () => {
                calls.push('second');
              },
            ],
            100,
          ),
          { startImmediately: true },
        );
        yield* turn();
        expect(calls).toEqual(['first']);
        first.resolve();
        yield* Fiber.join(fiber);
        expect(calls).toEqual(['first', 'first finished', 'second']);
      }),
    );
  });

  it.each(['reject', 'resolve'] as const)(
    'aborts at the shared deadline and awaits a step that will %s',
    async (settlement) => {
      const stopped = deferred();
      const next = vi.fn(async () => undefined);
      let signal: AbortSignal | undefined;
      let finished = false;
      await run(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.exit(
              copyStepsWithin(
                [
                  (current) => {
                    signal = current;
                    return stopped.promise;
                  },
                  next,
                ],
                100,
              ),
            ),
            { startImmediately: true },
          );
          fiber.addObserver(() => {
            finished = true;
          });
          yield* turn();
          yield* TestClock.adjust(99);
          expect(signal?.aborted).toBe(false);
          expect(finished).toBe(false);
          yield* TestClock.adjust(1);
          yield* turn();
          expect(signal?.aborted).toBe(true);
          expect(finished).toBe(false);
          expect(next).not.toHaveBeenCalled();
          if (settlement === 'reject') stopped.reject(new Error('stopped'));
          else stopped.resolve();
          const exit = yield* Fiber.join(fiber);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(CopyBudgetExceeded);
          expect(next).not.toHaveBeenCalled();
        }),
      );
    },
  );

  it('shares the deadline across completed and running steps', async () => {
    const first = deferred();
    let secondSignal: AbortSignal | undefined;
    await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.exit(
            copyStepsWithin(
              [
                () => first.promise,
                (signal) => {
                  secondSignal = signal;
                  return new Promise<void>((resolve) =>
                    signal.addEventListener('abort', () => resolve(), { once: true }),
                  );
                },
              ],
              100,
            ),
          ),
          { startImmediately: true },
        );
        yield* turn();
        yield* TestClock.adjust(60);
        first.resolve();
        yield* turn();
        yield* TestClock.adjust(39);
        expect(secondSignal?.aborted).toBe(false);
        yield* TestClock.adjust(1);
        const exit = yield* Fiber.join(fiber);
        expect(secondSignal?.aborted).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(CopyBudgetExceeded);
        else throw new Error('expected timeout');
      }),
    );
  });
});

describe('copy budget facade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves the original step error and never starts later steps', async () => {
    const error = new Error('disk full');
    const next = vi.fn(async () => undefined);
    await expect(
      copyWithinBudget(
        [
          async () => {
            throw error;
          },
          next,
        ],
        100,
      ),
    ).rejects.toBe(error);
    expect(next).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer after success', async () => {
    await copyWithinBudget([async () => undefined], 100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the timeout message after aborting the copy', async () => {
    const rejected = expect(
      copyWithinBudget(
        [
          (signal) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
        ],
        100,
      ),
    ).rejects.toThrow('dependency copying timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
