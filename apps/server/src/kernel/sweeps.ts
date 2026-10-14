import { Data, Effect, Exit, FiberMap, FiberSet, Scope } from 'effect';
import { abortable, runFork, runPromise } from './effect';

/** One periodic sweep of the composition (PM-613). */
export interface Sweep {
  /** Unique within one list: the key of its round. */
  readonly name: string;
  /** Milliseconds between ticks; values below 1 count as 1. */
  readonly everyMs: number;
  /** Also starts once on the caller's stack (default false). */
  readonly atStart?: boolean;
  /** Starts on the caller's stack; stopping waits for it and never cuts it. */
  readonly run: () => Promise<void>;
  /** Handles a rejection or synchronous throw of `run`. */
  readonly onError: (err: unknown) => void;
}

export interface RunningSweeps {
  /** Stops ticks immediately and waits for running rounds; repeated calls return the same promise. */
  stop(): Promise<void>;
}

class SweepRoundFailed extends Data.TaggedError('SweepRoundFailed')<{ cause: unknown }> {}

function settle(sweep: Sweep): Promise<void> {
  let started: Promise<void>;
  try {
    started = sweep.run();
  } catch (err) {
    started = Promise.reject(err);
  }
  return started.catch(sweep.onError);
}

const makeSweeps = (sweeps: readonly Sweep[]): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Scope closes in reverse order: stop ticks before waiting for rounds (PM-613).
    const rounds = yield* FiberMap.make<string>();
    const tickers = yield* FiberSet.make();
    for (const sweep of sweeps) {
      const round = abortable(
        () => settle(sweep),
        (cause) => new SweepRoundFailed({ cause }),
      ).pipe(Effect.ignore);
      const tick = FiberMap.run(rounds, sweep.name, round, { onlyIfMissing: true }).pipe(Effect.asVoid);
      if (sweep.atStart) yield* tick;
      yield* FiberSet.run(
        tickers,
        Effect.forever(Effect.andThen(Effect.sleep(Math.max(1, sweep.everyMs)), tick)),
      );
    }
  });

/** Starts nothing if the list contains a duplicate name. */
export function startSweeps(sweeps: readonly Sweep[]): RunningSweeps {
  const names = new Set<string>();
  for (const sweep of sweeps) {
    if (names.has(sweep.name)) throw new Error(`sweep "${sweep.name}" is listed twice`);
    names.add(sweep.name);
  }
  const scope = Scope.makeUnsafe();
  runFork(Scope.provide(makeSweeps(sweeps), scope));
  let stopping: Promise<void> | undefined;
  return {
    stop: () => (stopping ??= runPromise(Scope.close(scope, Exit.void))),
  };
}
