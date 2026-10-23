import { Duration, Effect, Exit, FiberMap, FiberSet, Scope } from 'effect';
import { runFork, runPromise } from '../kernel';

/** The session's replaceable timers; an interrupt waits on its own key per call. */
type SessionTimerKey =
  | 'startup-watch'
  | 'process-probe'
  | 'compaction'
  | 'pause-deadline'
  | 'pause-stop-check'
  | `interrupt-${number}`;

interface SessionClockEffects {
  /** Calls once after the delay; only closing the clock drops this call. */
  readonly once: (delayMs: number, callback: () => void) => Effect.Effect<void>;
  /** Replaces the key's pending call, or preserves it with `ifMissing`. */
  readonly after: (
    key: SessionTimerKey,
    delayMs: number,
    callback: () => void,
    options?: { readonly ifMissing?: boolean },
  ) => Effect.Effect<void>;
  /** Repeats until cancelled; a key already ticking keeps its phase. */
  readonly every: (key: SessionTimerKey, periodMs: number, callback: () => void) => Effect.Effect<void>;
  /** Drops the key's pending call; absent keys are harmless. */
  readonly cancel: (key: SessionTimerKey) => Effect.Effect<void>;
}

const delay = (ms: number) => Duration.millis(Math.max(1, ms));

const makeSessionClock: Effect.Effect<SessionClockEffects, never, Scope.Scope> = Effect.gen(function* () {
  const map = yield* FiberMap.make<SessionTimerKey, void>();
  const set = yield* FiberSet.make<void>();
  const every: SessionClockEffects['every'] = (key, periodMs, callback) =>
    Effect.gen(function* () {
      if (FiberMap.hasUnsafe(map, key)) return;
      const fiber = yield* FiberMap.run(map, key, Effect.sleep(delay(periodMs)));
      fiber.addObserver((exit) => {
        if (!Exit.isSuccess(exit)) return;
        // Arm first: cancellation or replacement from the callback also drops the next tick.
        runFork(every(key, periodMs, callback));
        callback();
      });
    });
  return {
    once: (delayMs, callback) =>
      Effect.gen(function* () {
        const fiber = yield* FiberSet.run(set, Effect.sleep(delay(delayMs)));
        fiber.addObserver((exit) => {
          if (Exit.isSuccess(exit)) callback();
        });
      }),
    after: (key, delayMs, callback, options) =>
      Effect.gen(function* () {
        const fiber = yield* FiberMap.run(map, key, Effect.sleep(delay(delayMs)), {
          onlyIfMissing: options?.ifMissing,
        });
        // The map's observer releases the key before a callback can reuse it (PM-621).
        fiber.addObserver((exit) => {
          if (Exit.isSuccess(exit)) callback();
        });
      }),
    every,
    cancel: (key) => FiberMap.remove(map, key),
  };
});

/** Waits for `run()` at most `timeoutMs`; never rejects (`run` must not reject). */
export const waitAtMost = (run: () => Promise<unknown>, timeoutMs: number): Promise<void> =>
  runPromise(Effect.promise(run).pipe(Effect.timeoutOption(delay(timeoutMs)), Effect.asVoid));

/** Session timers, dropped together on exit; callbacks may replace or cancel their own timer. */
export class SessionClock {
  private readonly scope = Scope.makeUnsafe();
  private readonly core: SessionClockEffects;

  constructor() {
    this.core = Effect.runSync(Scope.provide(makeSessionClock, this.scope));
  }

  once(delayMs: number, callback: () => void): void {
    runFork(this.core.once(delayMs, callback));
  }

  after(
    key: SessionTimerKey,
    delayMs: number,
    callback: () => void,
    options?: { ifMissing?: boolean },
  ): void {
    runFork(this.core.after(key, delayMs, callback, options));
  }

  every(key: SessionTimerKey, periodMs: number, callback: () => void): void {
    runFork(this.core.every(key, periodMs, callback));
  }

  cancel(key: SessionTimerKey): void {
    runFork(this.core.cancel(key));
  }

  /** Drops every pending timer; later calls and a second close do nothing. */
  close(): void {
    runFork(Scope.close(this.scope, Exit.void));
  }
}
