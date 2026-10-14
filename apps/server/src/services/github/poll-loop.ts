import { Clock, Data, Effect, FiberHandle, Scope } from 'effect';
import type { FastifyBaseLogger } from 'fastify';
import { abortable } from '../../kernel';

export interface PollLoopDeps {
  /** Earliest epoch millisecond for a round; infinity when nothing is watched. */
  nextDueAt(): number;
  /** Stops cooperatively when the signal aborts. */
  round(signal: AbortSignal): Promise<void>;
  logger: FastifyBaseLogger;
}
export interface PollLoopEffects {
  /** Arms or brings forward a sleeping cycle; never replaces a round in flight. */
  readonly schedule: Effect.Effect<void>;
  /** Aborts and waits for the old cycle, then schedules any new subscribers. */
  readonly halt: Effect.Effect<void>;
}
class PollRoundFailed extends Data.TaggedError('PollRoundFailed')<{ cause: unknown }> {}

export const makePollLoop = (deps: PollLoopDeps): Effect.Effect<PollLoopEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    const loop = yield* FiberHandle.make<void, never>();
    let armedAt = Number.POSITIVE_INFINITY;
    let roundRunning = false;
    const cycle = Effect.gen(function* () {
      let minDelay = 0;
      while (true) {
        const dueAt = deps.nextDueAt();
        armedAt = dueAt;
        if (dueAt === Number.POSITIVE_INFINITY) return;
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(minDelay, dueAt - now));
        armedAt = Number.POSITIVE_INFINITY;
        roundRunning = true;
        yield* abortable(
          (signal) => deps.round(signal),
          (cause) => new PollRoundFailed({ cause }),
        ).pipe(
          Effect.catchTag('PollRoundFailed', (e) =>
            Effect.sync(() => {
              deps.logger.error({ err: e.cause }, 'github: pull request polling round failed');
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              roundRunning = false;
            }),
          ),
        );
        // sleep(0) yields; the old timer after a round waited at least 1 ms (PM-604).
        minDelay = 1;
      }
    });
    const schedule = Effect.suspend(() => {
      const dueAt = deps.nextDueAt();
      if (roundRunning || dueAt === Number.POSITIVE_INFINITY || armedAt <= dueAt) return Effect.void;
      return FiberHandle.run(loop, cycle);
    });
    const halt = Effect.gen(function* () {
      yield* FiberHandle.clear(loop);
      armedAt = Number.POSITIVE_INFINITY;
      yield* schedule;
    });
    return { schedule, halt };
  });
