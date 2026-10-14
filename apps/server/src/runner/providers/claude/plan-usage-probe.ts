import { Duration, Effect, Option } from 'effect';

/** One running probe process, as the facade sees it. */
export interface ProbeProcess {
  /** Claude Code's answer; null when the process failed or closed without one. Never rejects. */
  readonly answer: Promise<unknown>;
  /** Resolves when the process closed, or when it never started. Never rejects. */
  readonly closed: Promise<void>;
  /** Ends stdin: no prompt was sent, so this ends the process. */
  end(): void;
  /** True while the process started and has neither exited nor been killed by a signal. */
  running(): boolean;
  /** Kills it with SIGKILL. */
  kill(): void;
}

/** Waits for the answer, then ends the process and reaps it within a bounded grace period. */
export const probeWithin = (
  child: ProbeProcess,
  timeoutMs: number,
  killAfterMs: number,
): Effect.Effect<unknown> =>
  Effect.gen(function* () {
    const answer = yield* Effect.promise(() => child.answer).pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.map(Option.getOrNull),
    );
    // No prompt was sent: closing stdin ends the process; a stuck one is killed.
    yield* Effect.sync(() => child.end());
    const reap = Effect.promise(() => child.closed).pipe(
      Effect.timeoutOption(Duration.millis(killAfterMs)),
      Effect.andThen(
        Effect.sync(() => {
          if (child.running()) child.kill();
        }),
      ),
    );
    yield* Effect.forkDetach(reap, { startImmediately: true });
    return answer;
  });
