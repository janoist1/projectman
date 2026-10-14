import { Effect, Exit, FiberHandle, Scope } from 'effect';
import { runFork, runPromise } from '../../kernel';
import type { ScheduleTimer } from './ports';

export interface ScheduleTimerEffects {
  /** Calls `callback` once `delayMs` has passed; replaces the pending call. */
  readonly set: (callback: () => void, delayMs: number) => Effect.Effect<void>;
  /** Drops the pending call. */
  readonly clear: Effect.Effect<void>;
}

export const makeScheduleTimer: Effect.Effect<ScheduleTimerEffects, never, Scope.Scope> = Effect.gen(
  function* () {
    const handle = yield* FiberHandle.make<void>();
    return {
      set: (callback, delayMs) =>
        Effect.gen(function* () {
          const fiber = yield* FiberHandle.run(handle, Effect.sleep(delayMs));
          // The handle releases the fiber first, so a callback can arm the next minute (PM-603).
          fiber.addObserver((exit) => {
            if (Exit.isSuccess(exit)) callback();
          });
        }),
      clear: FiberHandle.clear(handle),
    };
  },
);

/** The default `ScheduleTimer` (PM-603): one fiber asleep until the next call; `close()` drops it. */
export class MinuteTimer implements ScheduleTimer {
  private readonly scope = Scope.makeUnsafe();
  private readonly core: ScheduleTimerEffects;

  constructor() {
    this.core = Effect.runSync(Scope.provide(makeScheduleTimer, this.scope));
  }

  set(callback: () => void, delayMs: number): unknown {
    runFork(this.core.set(callback, delayMs));
    return undefined;
  }

  clear(_handle?: unknown): void {
    runFork(this.core.clear);
  }

  close(): Promise<void> {
    return runPromise(Scope.close(this.scope, Exit.void));
  }
}
