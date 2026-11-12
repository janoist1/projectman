# Effect in projectman

Read this before you write or change Effect code. The trial started on PM-590 (the owner's go on
2026-10-13) and was closed on PM-1388 (decision 79: the architect sets the boundary).

## The boundary (PM-1388)

Effect stays only for long-running work with real concurrency, behind a plain TypeScript facade.
A plain timer is plain TypeScript.

**Effect fits** a module that owns long-running work with at least one of these:

1. several operations in flight that must be serialized, keyed or kept from overlapping;
2. a cancellation that must wait until the running step stops at its own checkpoint (`abortable`);
3. a retry or backoff ladder;
4. a shutdown that must wait for running work;

and whose plain version would need its own bookkeeping of timers, in-flight promises and flags.

**Effect does not fit** one delay, one interval, a timeout around a promise, a polling loop or a
sequence of awaits. Write these with `setTimeout`, `setInterval` or `node:timers/promises`, clear
them on stop, and `unref()` them when they must not keep the process alive. Effect is never used in a
route handler, in `core`, in `packages/shared`, in `apps/server/src/contracts`, in the engine-link
protocol, in `scripts`, in the web app or in the widget.

The items of the list below belong to three groups (by their bold names):

- **Kept; Effect may grow here:** the runner's input queue, the message delivery, the merge queue,
  the full test queue, screenshot execution and polling, the document write queue, PM-619 session
  lifecycle, PM-622 hooks and permission gate, PM-626 heavy-run lock and sandboxed run, and the
  kernel's PM-600 shared Effect helper and PM-613 sweeps. A card may change and extend them in Effect.
- **Frozen:** the GitHub pull request poller, the schedule timer, PM-615 plan usage, the machine
  rounds of PM-617, PM-620 turn, input wait, compaction and cleanup, PM-621 runner session and CLI,
  and the trust lock of PM-623. These are timers that work and are tested. Fix and change them in
  place by the rules of this file; add no new Effect program to them. A card that replaces the
  mechanism of one (for example, an interval becomes a deadline timer) writes the replacement in plain
  TypeScript and removes its file from the item in the same change.
- **Back to plain TypeScript:** the five small wrappers, `runner/transcript/poll-ticker.ts` (with the
  tailer's own scope in `runner/transcript/tailer.ts`), `runtime/watchers/provider-status-wait.ts`,
  `worktree/copy-budget.ts`, `runtime/sessions/shutdown-wait.ts` and
  `runner/providers/claude/plan-usage-probe.ts`. A card that changes one of them rewrites it in plain
  TypeScript in the same change; a cleanup card takes the rest. The facades and their callers keep
  their behaviour and their tests unchanged; the tests of an Effect core become fake-timer tests of
  the same cases. Remove the file from its item, and the item when it is empty.

**Periodic work** of a hub module is a kernel sweep (a `Sweep` for `startSweeps` in
`kernel/sweeps.ts`): no module keeps its own `setInterval` or Effect loop for it. The sweep gives it
the slow-round log (PM-1120) and the ordered stop. The timers of a process or a connection
(heartbeats, watchdogs, the engine's poll, machine pressure, the memory log) and one-shot
`setTimeout`s stay plain TypeScript, owned by that process or connection.

**A new Effect program** needs a card whose technical plan names its file and the points above that
it meets; that card adds its item to the list below. Upgrading `effect` is a card of its own.

No Effect type crosses a facade, a contract or the engine-link: a caller of a facade sees methods,
promises and the errors it always saw.

## Where Effect is allowed

The files that may import `effect` today. Each card edits only its own item; the bold first line
never changes. `apps/server/test/architecture/effect-allowlist.test.ts` reads the `File:`/`Files:`
and `Facade:` paths of these items and fails when a file outside them imports `effect` or a listed
file no longer does, so keep that form.

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
  `kernel/index.ts`), called by the composition's `start()` and `stop()` (`assembly.ts`).
  One ticker fiber per sweep in a `FiberSet` (`Effect.forever(sleep → tick)`, a fixed rate as
  `setInterval` had) and the rounds in a `FiberMap` keyed by name with `onlyIfMissing`: a tick
  while its round runs is skipped. A round is `abortable` and ignores the signal, so `stop()`
  (closing the Scope: the tickers first, then the rounds) waits for the rounds running. The
  start runs with the kernel `runFork`, so an `atStart` round and every tick's round start on
  the caller's stack.

- **PM-615 plan usage (runtime/usage)**

  File: `apps/server/src/runtime/usage/refresh-loop.ts`. Facade: `RefreshLoop` (same file), used by `PlanUsageMonitor` (`runtime/usage/plan-usage.ts`, exported by `runtime/usage/index.ts`). Its sleep keeps the process alive between `start()` and `stop()`; the old interval was unref'd.

- **PM-617 machine and outages**

  Files: `apps/server/src/runtime/watchers/machine-rounds.ts` (facade: `MachineRounds`, same
  file, used by `MachineMonitor`) and
  `apps/server/src/runtime/watchers/provider-status-wait.ts` (facade: `waitForStatus`, same file,
  used by `WorkOutages`). `MachineMonitor` and `WorkOutages` are exported by
  `runtime/watchers/index.ts`.

- **PM-618 pause**

  File: `apps/server/src/runtime/sessions/shutdown-wait.ts`. Facade: `waitForShutdownStops` (same file), used by `PauseService.pauseForShutdown` (`runtime/sessions/pause.ts`); not exported by `runtime/sessions/index.ts`.

- **PM-619 session lifecycle**

  File: `apps/server/src/runtime/sessions/lifecycle.ts`. Facade: `SessionLifecycle` (same file), owned by `SessionOrchestrator`. One `Scope` per session manager: the runner subscription (`acquireRelease`, released first), a `FiberSet` that tracks the sessions' background jobs (a job starts on the caller's stack; closing stops the tracking, never the job, and refuses new jobs), and the synchronous `onClose` (the timers) last. `dispose()` closes it with the kernel `runPromise`; `settleFolderRemovals()` awaits it.

- **PM-620 turn, input wait, compaction and cleanup**

  File: `apps/server/src/runtime/sessions/session-timers.ts`. Facade: `SessionTimers` (same file), used by `InputWaits`, `TurnFinishes` and `DoneCleanup`; the session manager closes it at shutdown. One `FiberMap` per group (`turn`, `input`, `cleanup`); a call runs from the fiber's `addObserver`, after its key left the map; delays are at least 1 ms. Its sleeps are ref'd (the old timers were unref'd): shutdown closes them.

- **PM-621 runner session and CLI**

  File: `apps/server/src/runner/session-clock.ts`. Facade: `SessionClock` (same file), which holds every timer of `AgentSession` (`runner/session.ts`). Also `apps/server/src/runner/cli.ts` (`runQuietly`, same file). A timer callback runs from the fiber's `addObserver`, outside the fiber, so it may arm, replace or cancel any timer, its own included; a repeating timer arms its next tick before its callback, as `setInterval` did. A delay below 1 ms is 1 ms, as for a Node timer. The timers are not unref'd (the 30 s process probe was): a running session keeps the process alive, and the server and the engine end with `process.exit`.

- **PM-622 hooks and permission gate**

  File: `apps/server/src/runner/permission-wait.ts`. Facade: `PermissionGate` (`runner/permission-gate.ts`). Interrupting a wait aborts the broker's signal and does not wait for its promise (not `abortable`): the denial must reach the CLI before its hook timeout, and the broker withdraws on its own. The hooks route, the hook forwarder and the tool decision stay plain TypeScript (a route handler; a script the CLI runs; synchronous).

- **PM-623 transcript tailer, plan usage and trust**

  Files: `apps/server/src/runner/transcript/poll-ticker.ts`, `apps/server/src/runner/providers/claude/plan-usage-probe.ts`, `apps/server/src/runner/providers/claude/trust-lock.ts`. Facades: `TranscriptTailer` (`apps/server/src/runner/transcript/tailer.ts`), `probeUsage` (`apps/server/src/runner/providers/claude/plan-usage.ts`), `ensureWorkspaceTrusted` (`apps/server/src/runner/providers/claude/trust.ts`).
  Effect sleep timers keep the process alive, unlike the former unref'd polling interval, so the tailer must be stopped (PM-623); the detached probe reaper ends on process closure or after at most five seconds.

- **PM-624 worktree dependency copy**

  File: `apps/server/src/worktree/copy-budget.ts`. Facade: `copyWithinBudget` (same file), used by `cloneDependencies` (`worktree/dependencies.ts`).

- **PM-626 heavy-run lock and sandboxed run**

  Files: `apps/server/src/full-test/heavy-lock-core.ts`, `apps/server/src/full-test/run-sandboxed-core.ts`.
  Facades: `acquireHeavyLock` (`full-test/heavy-lock.ts`, imported directly by `scripts/heavy/run.ts`)
  and `runSandboxed` (`full-test/run-sandboxed.ts`), exported by `full-test/index.ts`.
  The abort signal is cooperative, not an interruption: a round that takes the lock is never cut.
  A held lock's heartbeat keeps the process alive until `release()`.

- **PM-600 shared Effect helper (kernel)**

  File: `apps/server/src/kernel/effect.ts`. Facade: `runFork`, `runPromise` and `abortable` (same file, exported by `kernel/index.ts`): the inline scheduler and the run functions every program above shares (see "Running on the caller's stack").

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
the programs and facades listed above import them through `kernel/index.ts`). Do not write a private copy.

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
