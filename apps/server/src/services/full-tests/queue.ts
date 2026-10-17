import { Cause, Data, Effect, Exit, Fiber, FiberHandle, FiberMap } from 'effect';
import type { Scope } from 'effect';
import type { FastifyBaseLogger } from 'fastify';
import { OPEN_RELEASE_WORK_ADMISSION } from '../../contracts';
import type { ReleaseWorkAdmission } from '../../contracts';
import type { FullTestRunRecord } from '../../db';
import { abortable } from '../../kernel';

export interface FullTestQueueDeps {
  /** The next queued run, or undefined when stopped or empty. */
  next(): FullTestRunRecord | undefined;
  step(run: FullTestRunRecord, signal: AbortSignal): Promise<void>;
  logger: Pick<FastifyBaseLogger, 'warn'>;
  /** The release gate (PM-752): a run starts only with a permit; absent: never held. */
  work?: ReleaseWorkAdmission;
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
        // A hybrid release's maintenance fence (PM-752): the queued run waits until the fence is down.
        const permit = (deps.work ?? OPEN_RELEASE_WORK_ADMISSION).tryAcquire('full_test', run.id);
        if (!permit) return;
        const fiber = yield* FiberMap.run(
          steps,
          run.id,
          abortable(
            (signal) => deps.step(run, signal),
            (cause) => new FullTestStepFailed({ cause }),
          ).pipe(Effect.orDie),
        );
        const exit = yield* Fiber.await(fiber).pipe(Effect.ensuring(Effect.sync(() => permit.release())));
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
          deps.logger.warn({ err: Cause.squash(exit.cause) }, 'the full test queue failed');
      }
    });
    return {
      pump: FiberHandle.run(drain, loop, { onlyIfMissing: true }).pipe(Effect.asVoid),
      abort: (runId) => FiberMap.remove(steps, runId),
    };
  });
