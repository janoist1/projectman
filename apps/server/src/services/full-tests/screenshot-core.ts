import { Data, Duration, Effect, FiberMap } from 'effect';
import type { Scope } from 'effect';
import { abortable } from '../../kernel';

export interface ScreenshotCoreDeps {
  readonly pollMs: number;
}

export interface ScreenshotCoreEffects {
  /** Returns on completion or the polling deadline, cancelling the other wait. */
  waitFor(over: Promise<void>): Effect.Effect<void>;
  /** Starts the executor on the caller stack when run by the kernel's inline scheduler. */
  launch(runId: string, call: (signal: AbortSignal) => Promise<void>): Effect.Effect<void>;
  /** Aborts synchronously and waits for the executor call to settle. */
  stop(runId: string): Effect.Effect<void>;
}

class ScreenshotCallFailed extends Data.TaggedError('ScreenshotCallFailed')<{ cause: unknown }> {}

/** Scoped execution and polling; the facade keeps the run records and handles executor errors. */
export const makeScreenshotCore = (
  deps: ScreenshotCoreDeps,
): Effect.Effect<ScreenshotCoreEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    const executing = yield* FiberMap.make<string>();
    return {
      waitFor: (over) =>
        Effect.promise(() => over).pipe(Effect.timeoutOption(Duration.millis(deps.pollMs)), Effect.asVoid),
      launch: (runId, call) =>
        FiberMap.run(
          executing,
          runId,
          abortable(call, (cause) => new ScreenshotCallFailed({ cause })).pipe(Effect.orDie),
        ).pipe(Effect.asVoid),
      stop: (runId) => FiberMap.remove(executing, runId),
    };
  });
