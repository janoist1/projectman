import { Effect, Exit, FiberSet, Scope } from 'effect';
import { runFork, runPromise } from '../../kernel';

/**
 * The life of the session manager as a whole: the runner subscription, the sessions' background jobs
 * and the shutdown, in one `Scope`. `makeSessionLifecycle` is the Effect program; `SessionLifecycle` is
 * the plain facade the orchestrator owns (docs/EFFECT.md).
 *
 * Closing the scope runs in the reverse order of the build: the runner subscription ends first (no
 * event reaches the sessions any more), then the tracking of background jobs ends, and the
 * synchronous `onClose` (the timers of the sessions) runs last.
 */

interface SessionLifecycleDeps {
  /** Subscribes to the runner's events; returns the unsubscribe. */
  readonly subscribe: () => () => void;
  /** The synchronous shutdown of the sessions' own state (timers), run last. */
  readonly onClose: () => void;
}

interface SessionLifecycleEffects {
  /** Tracks a job that was started, until it settles. A closed lifecycle starts no tracking. */
  readonly track: (settled: Promise<unknown>) => Effect.Effect<void>;
  /** How many tracked jobs have not settled. */
  readonly running: Effect.Effect<number>;
}

const noop = () => {};

/** Builds the lifecycle in the scope it runs in; closing the scope is the shutdown. */
const makeSessionLifecycle = (
  deps: SessionLifecycleDeps,
): Effect.Effect<SessionLifecycleEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    // The finalizers run in reverse order: this one is last.
    yield* Effect.addFinalizer(() => Effect.sync(deps.onClose));
    const background = yield* FiberSet.make();
    // The first to be released.
    yield* Effect.acquireRelease(Effect.sync(deps.subscribe), (unsubscribe) => Effect.sync(unsubscribe));
    return {
      // The job stays the caller's: its outcome is not ours, so a rejection is swallowed here only.
      track: (settled) =>
        FiberSet.run(
          background,
          Effect.promise(() => settled.then(noop, noop)),
        ).pipe(Effect.asVoid),
      running: FiberSet.size(background),
    };
  });

/**
 * Facade: the orchestrator's subscription and background jobs. A job starts on the caller's stack, as
 * a floating promise did; closing stops the tracking and refuses new jobs, but never cuts a job that
 * runs (the jobs do not take an `AbortSignal`, and a restart left half done is worse than one that
 * finishes), and does not wait for one that hangs.
 */
export class SessionLifecycle {
  private readonly scope = Scope.makeUnsafe();
  private readonly core: SessionLifecycleEffects;
  private closing: Promise<void> | undefined;

  constructor(deps: SessionLifecycleDeps) {
    // `Effect.runSync` brings its own synchronous scheduler: the subscription is made here, at once.
    this.core = Effect.runSync(Scope.provide(makeSessionLifecycle(deps), this.scope));
  }

  /**
   * Starts a background job now, on the caller's stack, and tracks it until it settles. The caller
   * handles the job's rejection. After `close()` the job does not start, and the result is undefined.
   */
  run<A>(job: () => Promise<A>): Promise<A | undefined> {
    if (this.closing) return Promise.resolve(undefined);
    const started = job();
    runFork(this.core.track(started));
    return started;
  }

  /** The tracked jobs that have not settled; for tests. */
  get running(): number {
    return Effect.runSync(this.core.running);
  }

  /** Unsubscribes, ends the tracking, runs the synchronous shutdown; the first call does it all, at once. */
  close(): void {
    this.closing ??= runPromise(Scope.close(this.scope, Exit.void));
  }

  /** Resolves once the shutdown has run; at once when it has not begun. */
  settled(): Promise<void> {
    return this.closing ?? Promise.resolve();
  }
}
