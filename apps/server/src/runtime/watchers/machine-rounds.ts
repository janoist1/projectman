import { Data, Deferred, Effect, Exit, FiberHandle, Scope } from 'effect';
import type { FastifyBaseLogger } from 'fastify';
import { runFork, runPromise } from '../../kernel';

export interface MachineRoundsOptions {
  measure: () => Promise<void>;
  nextDelay: () => number | null;
  wanted: () => boolean;
  logger: FastifyBaseLogger;
  /** Test seam: returns the cancellation of the pending wait. */
  after?: (run: () => void, ms: number) => () => void;
}

export interface MachineRoundsEffects {
  readonly round: Effect.Effect<void>;
  readonly roundWithin: (ms: number) => Effect.Effect<void>;
  readonly schedule: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

class MeasureFailed extends Data.TaggedError('MeasureFailed')<{ cause: unknown }> {}

export const makeMachineRounds = (
  o: MachineRoundsOptions,
): Effect.Effect<MachineRoundsEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const armed = yield* FiberHandle.make<void>();
    // Observer callbacks start outside the timer fiber, with the same clock as the core.
    const context = yield* Effect.context<never>();
    let running: Deferred.Deferred<void> | null = null;
    let stopped = false;

    const wait = (ms: number): Effect.Effect<void> =>
      o.after
        ? Effect.callback<void>((resume) => {
            const cancel = o.after!(() => resume(Effect.void), ms);
            return Effect.sync(cancel);
          })
        : Effect.sleep(ms);

    const schedule: Effect.Effect<void> = Effect.suspend(() => {
      if (stopped || running) return Effect.void;
      const delay = o.nextDelay();
      if (delay === null) return FiberHandle.clear(armed);
      return Effect.gen(function* () {
        const fiber = yield* FiberHandle.run(armed, wait(Math.max(1, delay)));
        // The handle releases its fiber first; clearing it from the round cannot self-interrupt.
        fiber.addObserver((exit) => {
          if (Exit.isSuccess(exit) && o.wanted()) runFork(Effect.provide(round, context));
        });
      });
    });

    const round: Effect.Effect<void> = Effect.suspend(() => {
      if (running) return Deferred.await(running);
      if (stopped) return Effect.void;
      const done = Deferred.makeUnsafe<void>();
      running = done;
      const measured = Effect.tryPromise({
        try: () => o.measure(),
        catch: (cause) => new MeasureFailed({ cause }),
      }).pipe(
        Effect.catchTag('MeasureFailed', (err) =>
          Effect.sync(() => o.logger.warn({ err: err.cause }, 'the machine measurement failed')),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            running = null;
            yield* schedule;
            Deferred.doneUnsafe(done, Effect.void);
          }),
        ),
      );
      return Effect.gen(function* () {
        yield* FiberHandle.clear(armed);
        yield* Effect.forkIn(measured, scope, { startImmediately: true });
        yield* Deferred.await(done);
      });
    });

    return {
      round,
      roundWithin: (ms) => round.pipe(Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.void })),
      schedule,
      stop: Effect.gen(function* () {
        stopped = true;
        yield* FiberHandle.clear(armed);
        if (running) yield* Deferred.await(running);
      }),
    };
  });

/** Demand-driven measurement rounds; no Effect type crosses this facade. */
export class MachineRounds {
  private readonly scope = Scope.makeUnsafe();
  private readonly core: MachineRoundsEffects;

  constructor(options: MachineRoundsOptions) {
    this.core = Effect.runSync(Scope.provide(makeMachineRounds(options), this.scope));
  }

  roundWithin(ms: number): Promise<void> {
    return runPromise(this.core.roundWithin(ms));
  }

  schedule(): void {
    runFork(this.core.schedule);
  }

  async stop(): Promise<void> {
    await runPromise(this.core.stop);
    await runPromise(Scope.close(this.scope, Exit.void));
  }
}

export function sleepFor(ms: number): Promise<void> {
  return runPromise(Effect.sleep(ms));
}
