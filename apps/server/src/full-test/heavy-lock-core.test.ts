import { getEventListeners } from 'node:events';
import { Cause, Clock, Effect, Exit, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it, vi } from 'vitest';
import { runPromise } from '../kernel';
import { holderHeartbeat, waitForLock } from './heavy-lock-core';
import type { LockWaitDeps, TurnResult } from './heavy-lock-core';

const turn = (): TurnResult => ({ acquired: false, holder: null, ahead: 0 });
const depsOf = (overrides: Partial<LockWaitDeps> = {}): LockWaitDeps => ({
  takeTurn: async () => turn(),
  remakeQueue: vi.fn(async () => {}),
  touchTicket: vi.fn(async () => {}),
  removeTicket: vi.fn(async () => {}),
  queuedAt: 0,
  heartbeatMs: 40,
  pollMs: 10,
  notifyMs: 30,
  ...overrides,
});
const flush = () => Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
const clockRun = (body: Effect.Effect<void, never, Scope.Scope>) =>
  runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* body.pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe('heavy lock Effect timing', () => {
  it('beats only at the heartbeat boundary and stops after acquisition', async () => {
    let acquired = false;
    const deps = depsOf({ pollMs: 40, takeTurn: async () => (acquired ? { acquired: true } : turn()) });
    await clockRun(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(waitForLock(deps).pipe(Effect.orDie), {
          startImmediately: true,
        });
        yield* flush();
        yield* TestClock.adjust(39);
        yield* flush();
        expect(deps.touchTicket).not.toHaveBeenCalled();
        yield* TestClock.adjust(1);
        yield* flush();
        expect(deps.touchTicket).toHaveBeenCalledTimes(1);
        acquired = true;
        yield* TestClock.adjust(40);
        yield* flush();
        yield* Fiber.join(fiber);
        const beats = vi.mocked(deps.touchTicket).mock.calls.length;
        yield* TestClock.adjust(100);
        yield* flush();
        expect(deps.touchTicket).toHaveBeenCalledTimes(beats);
      }),
    );
  });

  it('lets an acquiring round finish even when the caller aborts mid-round', async () => {
    const controller = new AbortController();
    let finishTurn!: (turn: TurnResult) => void;
    const deps = depsOf({
      signal: controller.signal,
      takeTurn: () =>
        new Promise((resolve) => {
          finishTurn = resolve;
        }),
    });
    await clockRun(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(waitForLock(deps).pipe(Effect.orDie), {
          startImmediately: true,
        });
        yield* flush();
        controller.abort(new Error('stop'));
        finishTurn({ acquired: true });
        expect(yield* Fiber.join(fiber)).toBe(0);
        expect(deps.removeTicket).not.toHaveBeenCalled();
      }),
    );
  });
  it('notifies immediately and at the deadline, shortens the final pause and cleans up', async () => {
    const onWait = vi.fn();
    const deps = depsOf({ onWait, maxWaitMs: 35 });
    await clockRun(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(Effect.exit(waitForLock(deps)), { startImmediately: true });
        yield* flush();
        expect(onWait).toHaveBeenCalledTimes(1);
        for (const ms of [10, 10, 9]) {
          yield* TestClock.adjust(ms);
          yield* flush();
        }
        expect(onWait).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust(1);
        yield* flush();
        expect(onWait).toHaveBeenCalledTimes(2);
        yield* TestClock.adjust(4);
        yield* flush();
        expect(deps.removeTicket).not.toHaveBeenCalled();
        yield* TestClock.adjust(1);
        yield* flush();
        expect(failure(yield* Fiber.join(fiber))).toMatchObject({ _tag: 'LockWaitTimedOut' });
        expect(deps.removeTicket).toHaveBeenCalledTimes(1);
      }),
    );
  });
  it('aborts a pause with the exact reason and stops ticket heartbeats', async () => {
    const controller = new AbortController();
    const reason = {};
    const deps = depsOf({ signal: controller.signal });
    await clockRun(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(Effect.exit(waitForLock(deps)), { startImmediately: true });
        yield* flush();
        controller.abort(reason);
        expect(failure(yield* Fiber.join(fiber))).toMatchObject({ _tag: 'LockWaitAborted', reason });
        expect(deps.removeTicket).toHaveBeenCalledTimes(1);
        expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
        yield* TestClock.adjust(100);
        yield* flush();
        expect(deps.touchTicket).not.toHaveBeenCalled();
      }),
    );
  });
  it('retries twenty failed rounds and preserves the last cause', async () => {
    const cause = new Error('unusable');
    const deps = depsOf({
      takeTurn: async () => {
        throw cause;
      },
    });
    await clockRun(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(Effect.exit(waitForLock(deps)), { startImmediately: true });
        yield* flush();
        for (let i = 0; i < 19; i++) {
          yield* TestClock.adjust(10);
          yield* flush();
        }
        expect(failure(yield* Fiber.join(fiber))).toMatchObject({ _tag: 'LockQueueUnusable', cause });
        expect(deps.remakeQueue).toHaveBeenCalledTimes(19);
      }),
    );
  });
  it('resets failed rounds after success, ignores display errors and stops heartbeats on acquisition', async () => {
    let rounds = 0;
    const deps = depsOf({
      takeTurn: async () => {
        rounds++;
        if (rounds === 20) return turn();
        if (rounds === 40) return { acquired: true };
        throw new Error('retry');
      },
      onWait: () => {
        throw new Error('display');
      },
    });
    await clockRun(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(waitForLock(deps).pipe(Effect.orDie), {
          startImmediately: true,
        });
        yield* flush();
        for (let i = 0; i < 39; i++) {
          yield* TestClock.adjust(10);
          yield* flush();
        }
        expect(yield* Fiber.join(fiber)).toBe(390);
        expect(deps.touchTicket).toHaveBeenCalledTimes(9);
        yield* TestClock.adjust(100);
        yield* flush();
        expect(deps.touchTicket).toHaveBeenCalledTimes(9);
        expect(deps.removeTicket).not.toHaveBeenCalled();
      }),
    );
  });
  it('warns once and waits for an in-flight holder beat before closing', async () => {
    let resolveBeat!: (value: boolean) => void;
    const takenOver = vi.fn();
    let calls = 0;
    await clockRun(
      Effect.gen(function* () {
        const scope = Scope.makeUnsafe();
        yield* Effect.forkIn(
          holderHeartbeat({
            heartbeatMs: 10,
            takenOver,
            beat: async () => {
              if (++calls <= 2) return false;
              return new Promise<boolean>((resolve) => {
                resolveBeat = resolve;
              });
            },
          }),
          scope,
          { startImmediately: true },
        );
        for (let i = 0; i < 3; i++) {
          yield* TestClock.adjust(10);
          yield* flush();
        }
        expect(takenOver).toHaveBeenCalledTimes(1);
        let closed = false;
        const closing = yield* Effect.forkScoped(
          Scope.close(scope, Exit.void).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                closed = true;
              }),
            ),
          ),
          { startImmediately: true },
        );
        yield* flush();
        expect(closed).toBe(false);
        resolveBeat(true);
        yield* Fiber.join(closing);
        expect(closed).toBe(true);
      }),
    );
  });
});
