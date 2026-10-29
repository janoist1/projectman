import { Cause, Data, Effect, Exit, Fiber, FiberHandle, FiberMap } from 'effect';
import type { Scope } from 'effect';
import type { FastifyBaseLogger } from 'fastify';
import type { FullTestRunRecord } from '../../db';
import { abortable } from '../../kernel';

interface FullTestQueueDeps {
  /** The next queued run, or undefined when stopped or empty. */
  next(): FullTestRunRecord | undefined;
  step(run: FullTestRunRecord, signal: AbortSignal): Promise<void>;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

export interface FullTestQueueEffects {
  /** Starts the drain only when it is not running already. */
  readonly pump: Effect.Effect<void>;
  /** Aborts the step and waits for its cooperative cleanup. */
  abort(runId: string): Effect.Effect<void>;
}

class FullTestStepFailed extends Data.TaggedError('FullTestStepFailed')<{ cause: unknown }> {}

/** One durable FIFO, with cooperatively interrupted steps that settle before the next starts. */
export const makeFullTestQueue = (
  deps: FullTestQueueDeps,
): Effect.Effect<FullTestQueueEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    const drain = yield* FiberHandle.make();
    const steps = yield* FiberMap.make<string>();
    const loop = Effect.gen(function* () {
      for (;;) {
        const run = deps.next();
        if (!run) return;
        const fiber = yield* FiberMap.run(
          steps,
          run.id,
          abortable(
            (signal) => deps.step(run, signal),
            (cause) => new FullTestStepFailed({ cause }),
          ).pipe(Effect.orDie),
        );
        const exit = yield* Fiber.await(fiber);
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
          deps.logger.warn({ err: Cause.squash(exit.cause) }, 'the full test queue failed');
      }
    });
    return {
      pump: FiberHandle.run(drain, loop, { onlyIfMissing: true }).pipe(Effect.asVoid),
      abort: (runId) => FiberMap.remove(steps, runId),
    };
  });
