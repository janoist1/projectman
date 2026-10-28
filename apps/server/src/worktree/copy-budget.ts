import { Data, Duration, Effect } from 'effect';
import { abortable, runPromise } from '../kernel';

/** One copying step; it must stop and settle soon after `signal` aborts. */
type CopyStep = (signal: AbortSignal) => Promise<void>;

class CopyStepFailed extends Data.TaggedError('CopyStepFailed')<{ cause: unknown }> {}
export class CopyBudgetExceeded extends Data.TaggedError('CopyBudgetExceeded')<{}> {}

/** Runs steps sequentially within one budget, aborting and awaiting the running step on expiry. */
export const copyStepsWithin = (steps: readonly CopyStep[], budgetMs: number) =>
  Effect.forEach(steps, (step) => abortable(step, (cause) => new CopyStepFailed({ cause })), {
    discard: true,
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(budgetMs),
      orElse: () => Effect.fail(new CopyBudgetExceeded()),
    }),
  );

/** Rejects with the step's own error or with `dependency copying timed out`. */
export function copyWithinBudget(steps: readonly CopyStep[], budgetMs: number): Promise<void> {
  return runPromise(
    copyStepsWithin(steps, budgetMs).pipe(
      Effect.catchTags({
        CopyStepFailed: (e) => Effect.die(e.cause),
        CopyBudgetExceeded: () => Effect.die(new Error('dependency copying timed out')),
      }),
    ),
  );
}
