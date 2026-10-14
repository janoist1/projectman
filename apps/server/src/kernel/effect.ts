import { Cause, Context, Effect, Exit, Scheduler } from 'effect';

/**
 * Fibers started with `runFork` run at once on the caller's stack (tasks queue while one runs), as
 * resolving a Promise ran its callbacks before: the default scheduler resumes a fiber on
 * `setImmediate`, which lets a caller observe the queue several turns late (docs/EFFECT.md).
 * This applies to `runFork`/`runPromise` only: `Effect.runSync` always brings its own synchronous
 * scheduler, so it takes no part in it.
 */
const inlineDispatcher = ((): Scheduler.SchedulerDispatcher => {
  const tasks: Array<() => void> = [];
  let running = false;
  const flush = () => {
    if (running) return;
    running = true;
    try {
      for (let task = tasks.shift(); task; task = tasks.shift()) task();
    } finally {
      running = false;
    }
  };
  return {
    scheduleTask: (task) => {
      tasks.push(task);
      flush();
    },
    flush,
  };
})();

const inlineScheduler: Scheduler.Scheduler = {
  executionMode: 'sync',
  shouldYield: () => false,
  makeDispatcher: () => inlineDispatcher,
};

const inline = Context.make(Scheduler.Scheduler, inlineScheduler);

/** Starts a fiber that runs at once on the caller's stack. */
export const runFork = Effect.runForkWith(inline);

/**
 * Like `Effect.runPromise` (a failure rejects with the original error), but a settled fiber settles
 * the promise at once: `runPromise` adds a promise hop, one turn later than resolving it by hand.
 */
export const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  new Promise((resolve, reject) => {
    runFork(effect).addObserver((exit) =>
      Exit.isSuccess(exit) ? resolve(exit.value) : reject(Cause.squash(exit.cause)),
    );
  });

/**
 * An async function as a cooperatively interruptible Effect. `run` gets an AbortSignal; a rejection
 * becomes the typed failure `onError(cause)`. Interrupting the Effect aborts the signal and then
 * **waits until the promise has settled**: the function stops on its own checkpoints (it may finish
 * a step that must not be cut, such as a push) and whatever follows the interruption (a finalizer, a
 * freed slot) happens after it, never beside it. The settled value of an interrupted run is dropped.
 */
export const abortable = <A, E>(
  run: (signal: AbortSignal) => Promise<A>,
  onError: (cause: unknown) => E,
): Effect.Effect<A, E> =>
  Effect.callback<A, E>((resume) => {
    const controller = new AbortController();
    // Neither handler throws: the outcome goes to `resume`, which ignores it once interrupted.
    const settled = run(controller.signal).then(
      (value) => resume(Effect.succeed(value)),
      (cause: unknown) => resume(Effect.suspend(() => Effect.fail(onError(cause)))),
    );
    return Effect.promise(() => {
      controller.abort();
      return settled;
    });
  });
