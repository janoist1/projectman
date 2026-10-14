# Effect in projectman

Read this before you write or change Effect code. It is short on purpose; the reasons for the
trial are on the card PM-590 (and the later cards of the refactor, "Refaktor 2").

## Where Effect is allowed

Only in a module that has been rewritten on purpose, behind a plain TypeScript facade. Today:

Each card edits only its own item; the bold first line never changes.

- **the runner's input queue**

  File: `apps/server/src/runner/input-queue.ts`. Facade: `InputQueue` (same file).

- **the message delivery**

  File: `apps/server/src/runtime/delivery/delivery.ts`. Facade: `MessageDelivery` (same file, exported by `runtime/delivery/index.ts`).

- **the merge queue**

  File: `apps/server/src/services/merges/queue.ts`. Facade: `Merges` (`services/merges/merges.ts`, exported by its `index.ts`).

- **the full test queue**

  File: `apps/server/src/services/full-tests/queue.ts`. Facade: `FullTestRuns` (`services/full-tests/full-tests.ts`, exported by its `index.ts`).

- **screenshot execution and polling**

  File: `apps/server/src/services/full-tests/screenshot-core.ts`. Facade: `ScreenshotRuns` (`services/full-tests/screenshot-runs.ts`, exported by its `index.ts`).

- **the GitHub pull request poller**

  File: `apps/server/src/services/github/poll-loop.ts`. Facade: `createPullRequestPoller` (`services/github/poller.ts`).

- **the schedule timer**

  File: `apps/server/src/services/schedules/timer.ts`. Facade: `MinuteTimer` (same file), used by `ScheduleService`, exported by its `index.ts`.

- **the document write queue**

  File: `apps/server/src/services/project-docs/write-queue.ts`. Facade: `DocWrites` (`services/project-docs/doc-writes.ts`, exported by its `index.ts`).

- **PM-613 sweeps**

  File: `apps/server/src/kernel/sweeps.ts`. Facade: `startSweeps` (same file, exported by
  `kernel/index.ts`), called by the composition's `start()` and `stop()` (`domain/index.ts`).
  One ticker fiber per sweep in a `FiberSet` (`Effect.forever(sleep → tick)`, a fixed rate as
  `setInterval` had) and the rounds in a `FiberMap` keyed by name with `onlyIfMissing`: a tick
  while its round runs is skipped. A round is `abortable` and ignores the signal, so `stop()`
  (closing the Scope: the tickers first, then the rounds) waits for the rounds running. The
  start runs with the kernel `runFork`, so an `atStart` round and every tick's round start on
  the caller's stack.

- **PM-615 plan usage (runtime/usage)**

  Planned.

- **PM-616 admission (if any)**

  Planned.

- **PM-617 machine and outages**

  Planned.

- **PM-618 pause**

  Planned.

- **PM-619 session lifecycle**

  Planned.

- **PM-620 turn, input wait, compaction and cleanup**

  Planned.

- **PM-621 runner session and CLI**

  Planned.

- **PM-622 hooks and permission gate**

  Planned.

- **PM-623 transcript tailer, plan usage and trust**

  Planned.

- **PM-624 worktree dependency copy**

  File: `apps/server/src/worktree/copy-budget.ts`. Facade: `copyWithinBudget` (same file), used by `cloneDependencies` (`worktree/dependencies.ts`).

- **PM-625 engine host (if any)**

  Planned.

- **PM-626 heavy-run lock and sandboxed run**

  Files: `apps/server/src/full-test/heavy-lock-core.ts`, `apps/server/src/full-test/run-sandboxed-core.ts`.
  Facades: `acquireHeavyLock` (`full-test/heavy-lock.ts`, imported directly by `scripts/heavy/run.ts`)
  and `runSandboxed` (`full-test/run-sandboxed.ts`), exported by `full-test/index.ts`.
  The abort signal is cooperative, not an interruption: a round that takes the lock is never cut.
  A held lock's heartbeat keeps the process alive until `release()`.

Everything else stays plain TypeScript. Do not start using Effect in another module, in a route
handler, in `packages/shared` or in the web app without a card that says so. **No Effect type crosses
a facade, a contract or the engine-link**: a caller of a facade sees methods, promises and the errors
it always saw.

## Version and bans

- The stable `effect` package, **pinned exactly** (`4.0.4` in `apps/server/package.json`, no `^`).
  Import only from `effect` and `effect/testing`. No `effect/unstable/*`, no other `@effect/*`
  package (`@effect/vitest` needs a newer vitest than ours).
- No `Layer`, no `Context.Service`, no `ManagedRuntime` in production code. A program takes its
  dependencies as a plain `deps` object, as the code did before.
- No 3.x API. Renames to know (checked in `node_modules/effect/src`):

| 3.x                         | 4.x                                                                     |
| --------------------------- | ----------------------------------------------------------------------- |
| `Effect.fork`               | `Effect.forkChild`, `Effect.forkIn(effect, scope)`, `Effect.forkScoped` |
| `Context.Tag`, `Effect.Tag` | `Context.Service` (not used here)                                       |
| `Scope.unsafeMake`          | `Scope.makeUnsafe`                                                      |
| `Deferred.unsafeDone`       | `Deferred.doneUnsafe`                                                   |
| `Effect.catchAllCause`      | `Effect.catchCause`                                                     |
| `Effect.catchAllDefect`     | `Effect.catchDefect`                                                    |

When an API name is not in this file, look it up in `node_modules/effect/src/<Module>.ts`; the
documentation in `node_modules/effect/CLAUDE.md` is for the same version.

## The pattern

```ts
// Core: an Effect that lives as long as its Scope.
export const makeThing = (deps: ThingDeps): Effect.Effect<ThingEffects, never, Scope.Scope> =>
  Effect.gen(function* () { ...; return { doIt, ... }; });

// Facade: today's class, plain methods.
export class Thing {
  private readonly scope = Scope.makeUnsafe();
  private readonly core: ThingEffects;
  constructor(deps: ThingDeps) {
    this.core = runSync(Scope.provide(makeThing(deps), this.scope));
  }
  doIt(): void { runSync(this.core.doIt()); }
  close(): Promise<void> { return runPromise(Scope.close(this.scope, Exit.void)); }
}
```

- The core returns an object of Effects; the facade runs them. A synchronous member uses
  `runSync`, a promise member rejects with the **original** error (see Errors).
- State that was a field stays a plain closed-over variable (a `Map`, a `Set`, a flag). Effect is
  there for time and concurrency, not to turn every field into a `Ref`.
- Keep the old comments that explain a rule (PM numbers); move them with the code.
- A new facade class has the same members as before, plus `close()` when it owns background work.
  The server's shutdown calls it.

### Running on the caller's stack (the scheduler)

Effect's default scheduler resumes a fiber with `setImmediate`, and `Effect.runPromise` adds a promise
hop. The code these programs replaced reacted within the same promise turn, and tests (session
tests that count promise ticks) and callers depend on that. A facade therefore starts its
promise-returning members and `close()` with an **inline scheduler** (a trampoline: a task runs at
once on the caller's stack, tasks queued meanwhile run after it; `executionMode: 'sync'`,
`shouldYield: () => false`), given through the context of `Effect.runForkWith(context)`, and with its
own `runPromise` (`runFork(effect).addObserver(...)` that resolves or rejects the promise by hand).

The synchronous members use plain `Effect.runSync`: in effect 4.0.4 `runSyncWith(context)` always
passes its own `MixedScheduler('sync')` to the fiber (`runSyncExitWith` in
`node_modules/effect/src/internal/effect.ts`), which overrides the scheduler of the context, so an
inline scheduler would not apply there (nor to the fibers forked from that run). The tests that count
promise ticks pass with it.

Two more traps found while doing this: `Effect.provideService(effect, Scheduler.Scheduler, ...)` does
not change how the fiber is scheduled (the scheduler must be in the context the run function gets);
and `MixedScheduler('sync')` alone was not enough for `runFork`/`runPromise`, tick counts still went
from 1 to 2.

The inline scheduler, `runFork` and `runPromise` live once in `apps/server/src/kernel/effect.ts` (PM-600;
the input queue, the delivery, the document write queue and the merge queue import them from `kernel/`). Do not write a private copy.

### Running an async function that must be stopped cooperatively (`abortable`)

`abortable(run, onError)` in `kernel/effect.ts` turns `run(signal) => Promise` into an Effect. A rejection
becomes the typed failure `onError(cause)`. Interrupting the Effect aborts the signal and then **waits
until the promise has settled**, so whatever follows (`Effect.ensuring`, a freed `FiberMap` slot) happens
after the function stopped at its own checkpoint, never beside it; the function may even finish a step that
must not be cut (the merge's push). The document write queue ignores the abort signal, so `stop()` waits for the running write to finish. The value of an interrupted run is dropped. The merge queue uses it
for the merge program (`Merges.cancel` and `stop()` interrupt the slot's fiber). Do not wrap such a
function in a bare `Effect.tryPromise({ signal })`: that stops waiting at once and leaves the function
running beside the next step.

If the slot's cleanup must run after the key left the `FiberMap`, hang it on the fiber's `addObserver`
(the map's own observer is added first), not on `Effect.ensuring`: inside `ensuring` the key is still
there, so `FiberMap.run(..., { onlyIfMissing: true })` from the cleanup would skip the next program.
Likewise, when a timer callback arms the next timer, run it from the fiber's `addObserver`, after
the `FiberHandle` releases the fiber, rather than from inside the fiber itself.

The full test queue (PM-601) owns one drain in a `FiberHandle` and a `FiberMap` of steps.
It awaits each `abortable` step before reading the next durable row; removing a step aborts
its signal and waits for its promise. A step that cancels itself starts the removal with
the kernel's `runFork`, because awaiting its own removal would deadlock. The screenshot core
uses the same scoped `FiberMap` pattern for executor calls. Its polling wait is
`Effect.promise(() => over).pipe(Effect.timeoutOption(Duration.millis(pollMs)), Effect.asVoid)`:
completion interrupts the polling sleep, and the deadline interrupts the promise wait.
Both facades close their scopes on shutdown and rebuild them for a later restart.

## Timers and cleanup

- In effect 4.0.4, `Effect.sleep(0)` is `yieldNow`. A wait after a step that replaced a zero-delay
  Node timer must be at least 1 ms (the GitHub poller's first wait may still yield at 0 ms).
- Interrupt with the kernel's `runFork` when cleanup is asynchronous. The poller's `halt` aborts
  the round on the caller's stack and waits for its promise before scheduling again; `runSync`
  cannot wait for that cleanup. Only replacing a sleeping fiber is synchronous.
- **No `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `.unref()` or timer sets** in
  Effect code. A delay is `Effect.sleep` inside a fiber; a timer you may cancel or replace is a
  `FiberHandle` (one) or a `FiberMap` (one per key, e.g. per session id); background work is
  `Effect.forkIn(effect, scope, { startImmediately: true })`.
- A fiber that must not overlap itself: `FiberMap.run(map, key, effect, { onlyIfMissing: true })`.
- Cleanup is closing the `Scope`: its finalizers run, its fibers are interrupted. Register a finalizer
  with `Effect.addFinalizer`; finalizers run in reverse order, so the one added last runs first.
- A step that must always run after a program ends is `Effect.ensuring`, the old `finally`.
- Check in review: `grep -nE 'setTimeout|setInterval|clearTimeout|clearInterval|NodeJS\.Timeout|\.unref\(' <files>`
  finds nothing in the Effect files.

## Errors

- An **expected** failure is typed: `class TypeIntoFailed extends Data.TaggedError('TypeIntoFailed')<{ cause: unknown }> {}`
  in the Effect's error channel; handle it with `Effect.catchTag`. Wrap a promise that may reject
  with `Effect.tryPromise({ try, catch: (cause) => new TypeIntoFailed({ cause }) })`, and one that
  must not with `Effect.promise`.
- A **program bug** (a failing callback that was not expected to fail) is a defect: `Effect.die`,
  `Effect.catchDefect`.
- A handler that logs a failed background delivery (or retries it) must not run for an interruption
  (`close()`, `dropHeld`): when it catches a whole `Cause`, skip it if `Cause.hasInterruptsOnly(cause)`
  (`catchFailure` in `runtime/delivery/delivery.ts`).
- The facade throws the error callers always got, not the tagged wrapper:
  `effect.pipe(Effect.catchTag('StartFailed', (e) => Effect.die(e.cause)))` before running it as a
  promise, and `Cause.squash` in `runPromise`. A caller does not know about Effect.
- A `Data.TaggedError` with a `message` field keeps the old `Error` message; the existing error classes
  keep their constructors (`new SessionGoneError(sessionId, reason)`).

## Logging

Use the pino/fastify logger the module is given in its deps, with the same messages and fields as
before (log lines are searched in production). Do not use `Effect.log*` and do not read the
environment.

## Testing

- **Core under the `TestClock`:** `effect/testing` has `TestClock.make()` and `TestClock.adjust(ms)`.
  Provide it with `Effect.provideService(Clock.Clock, clock)` around a scoped program, build the module
  in it, and move time exactly (`adjust(n - 1)`: nothing yet, `adjust(1)`: it happens). Fake deps are
  plain objects. Promises of the fake deps settle on real turns: wait for them with
  `new Promise(setImmediate)` after an `adjust`. Examples: `runner/input-queue.clock.test.ts`,
  `runtime/delivery/delivery.test.ts`.
- **Facade under `vi.useFakeTimers()`:** Effect uses the global `setTimeout`, `Date.now()` and
  `setImmediate` at call time, so vitest's fake timers work with it. Check the cleanup with
  `vi.getTimerCount()`: after `close()` (and `await vi.advanceTimersByTimeAsync(0)`) it is `0`.
- The tests written before the rewrite stay as they were; a rewrite is right when they pass
  unchanged.
- Server tests that need a pseudo-terminal (`*.integration.test.ts`, `golden-path-*.test.ts`) do not run in
  the member sandbox; they run in the full test outside it.
