import { Cause, Clock, Effect, Exit, Fiber, FiberSet, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionDecision } from '../contracts';
import { awaitPermission, type PermissionWaitInput } from './permission-wait';

const TIMEOUT_MS = 60_000;

function setup() {
  let signal!: AbortSignal;
  let resolve!: (decision: PermissionDecision) => void;
  let reject!: (cause: unknown) => void;
  const withdrawn = new AbortController();
  const input: PermissionWaitInput = {
    request: { sessionId: 'ses_1', toolName: 'Bash', toolInput: null, raw: {} },
    timeoutMs: TIMEOUT_MS,
    withdrawn: withdrawn.signal,
    broker: {
      decide: (_request, brokerSignal) => {
        signal = brokerSignal;
        return new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
      },
    },
  };
  return {
    input,
    withdrawn,
    signal: () => signal,
    resolve: (d: PermissionDecision) => resolve(d),
    reject: (e: unknown) => reject(e),
  };
}

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

const start = (input: PermissionWaitInput) =>
  Effect.forkChild(awaitPermission(input), { startImmediately: true });

describe('permission wait under the TestClock', () => {
  it('returns the decision before the deadline without aborting the broker', async () => {
    const s = setup();
    await run(
      Effect.gen(function* () {
        const fiber = yield* start(s.input);
        s.resolve({ behavior: 'allow' });
        expect(yield* Fiber.join(fiber)).toEqual({ kind: 'decided', decision: { behavior: 'allow' } });
        expect(s.signal().aborted).toBe(false);
        yield* TestClock.adjust(TIMEOUT_MS);
        expect(s.signal().aborted).toBe(false);
      }),
    );
  });

  it('times out exactly at the deadline even when the broker never settles on abort', async () => {
    const s = setup();
    await run(
      Effect.gen(function* () {
        const fiber = yield* start(s.input);
        yield* TestClock.adjust(TIMEOUT_MS - 1);
        expect(fiber.pollUnsafe()).toBeUndefined();
        expect(s.signal().aborted).toBe(false);
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(fiber)).toEqual({ kind: 'timeout' });
        expect(s.signal().aborted).toBe(true);
      }),
    );
  });

  it.each([false, true])(
    'withdraws without awaiting the broker (already aborted: %s)',
    async (alreadyAborted) => {
      const s = setup();
      if (alreadyAborted) s.withdrawn.abort();
      await run(
        Effect.gen(function* () {
          const fiber = yield* start(s.input);
          s.withdrawn.abort();
          expect(yield* Fiber.join(fiber)).toEqual({ kind: 'withdrawn' });
          expect(s.signal().aborted).toBe(true);
        }),
      );
    },
  );

  it.each([false, true])('preserves the original broker failure (synchronous: %s)', async (synchronous) => {
    const s = setup();
    const cause = new Error('broker unavailable');
    if (synchronous)
      s.input.broker = {
        decide: () => {
          throw cause;
        },
      };
    await run(
      Effect.gen(function* () {
        const fiber = yield* start(s.input);
        if (!synchronous) s.reject(cause);
        const outcome = yield* Fiber.join(fiber);
        expect(outcome.kind).toBe('failed');
        if (outcome.kind === 'failed') expect(outcome.cause).toBe(cause);
      }),
    );
  });

  it('closing the scope interrupts the wait and aborts a broker that never settles', async () => {
    const s = setup();
    await run(
      Effect.gen(function* () {
        const scope = Scope.makeUnsafe();
        const fibers = yield* Scope.provide(FiberSet.make(), scope);
        const fiber = yield* start(s.input);
        FiberSet.addUnsafe(fibers, fiber);
        yield* Scope.close(scope, Exit.void);
        expect(s.signal().aborted).toBe(true);
        const exit = yield* Effect.exit(Fiber.join(fiber));
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }),
    );
  });

  it('removes the withdrawal listener after a decision and drops a late broker rejection', async () => {
    const s = setup();
    const remove = vi.spyOn(s.withdrawn.signal, 'removeEventListener');
    await run(
      Effect.gen(function* () {
        const fiber = yield* start(s.input);
        s.resolve({ behavior: 'deny' });
        yield* Fiber.join(fiber);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      }),
    );
    const late = setup();
    await run(
      Effect.gen(function* () {
        const fiber = yield* start(late.input);
        late.withdrawn.abort();
        yield* Fiber.join(fiber);
        late.reject(new Error('late rejection'));
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      }),
    );
  });
});
