import { Clock, Effect, Exit, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFork, runPromise } from '../../kernel';
import { makeScreenshotCore } from './screenshot-core';
import type { ScreenshotCoreEffects } from './screenshot-core';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function clockTest(body: (core: ScreenshotCoreEffects) => Effect.Effect<void>) {
  return runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const core = yield* makeScreenshotCore({ pollMs: 100 });
            yield* body(core);
          }),
        ).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
}

describe('screenshot core', () => {
  afterEach(() => vi.useRealTimers());

  it('returns exactly at the polling deadline under the TestClock', async () => {
    await clockTest((core) =>
      Effect.gen(function* () {
        let returned = false;
        const waiting = yield* Effect.forkChild(
          core.waitFor(new Promise<void>(() => {})).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                returned = true;
              }),
            ),
          ),
          { startImmediately: true },
        );
        yield* TestClock.adjust(99);
        expect(returned).toBe(false);
        yield* TestClock.adjust(1);
        yield* Fiber.join(waiting);
        expect(returned).toBe(true);
      }),
    );
  });

  it('returns when the run ends and removes the pending polling sleep', async () => {
    await clockTest((core) =>
      Effect.gen(function* () {
        let end!: () => void;
        let returned = false;
        const over = new Promise<void>((resolve) => {
          end = resolve;
        });
        const waiting = yield* Effect.forkChild(
          core.waitFor(over).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                returned = true;
              }),
            ),
          ),
          { startImmediately: true },
        );
        yield* TestClock.adjust(99);
        end();
        yield* Fiber.join(waiting);
        expect(returned).toBe(true);
        yield* TestClock.adjust(1);
        expect(returned).toBe(true);
      }),
    );
  });

  it('starts the call and aborts its signal on the caller stack, waiting for its end', async () => {
    const scope = Scope.makeUnsafe();
    const core = Effect.runSync(Scope.provide(makeScreenshotCore({ pollMs: 100 }), scope));
    let signal!: AbortSignal;
    let end!: () => void;
    runFork(
      core.launch('1', (s) => {
        signal = s;
        return new Promise<void>((resolve) => {
          end = resolve;
        });
      }),
    );
    expect(signal.aborted).toBe(false);
    let stopped = false;
    const stopping = runPromise(core.stop('1')).then(() => {
      stopped = true;
    });
    expect(signal.aborted).toBe(true);
    await turn();
    expect(stopped).toBe(false);
    // A concurrent close also waits for the already interrupted call.
    let closed = false;
    const closing = runPromise(Scope.close(scope, Exit.void)).then(() => {
      closed = true;
    });
    await turn();
    expect(closed).toBe(false);
    end();
    await Promise.all([stopping, closing]);
    expect(closed).toBe(true);
  });

  it('ignores missing run ids and aborts active calls when the scope closes', async () => {
    const scope = Scope.makeUnsafe();
    const core = Effect.runSync(Scope.provide(makeScreenshotCore({ pollMs: 100 }), scope));
    let signal!: AbortSignal;
    let end!: () => void;
    runFork(
      core.launch('1', (s) => {
        signal = s;
        return new Promise<void>((resolve) => {
          end = resolve;
        });
      }),
    );
    await runPromise(core.stop('missing'));
    expect(signal.aborted).toBe(false);
    const closing = runPromise(Scope.close(scope, Exit.void));
    expect(signal.aborted).toBe(true);
    end();
    await closing;
  });

  it('leaves no polling timer after an early completion', async () => {
    vi.useFakeTimers();
    const scope = Scope.makeUnsafe();
    const core = Effect.runSync(Scope.provide(makeScreenshotCore({ pollMs: 100 }), scope));
    let end!: () => void;
    const waiting = runPromise(
      core.waitFor(
        new Promise<void>((resolve) => {
          end = resolve;
        }),
      ),
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    end();
    await waiting;
    await runPromise(Scope.close(scope, Exit.void));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
