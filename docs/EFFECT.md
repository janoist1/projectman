# Effect in projectman

Read this before you write or change Effect code. It is short on purpose; the reasons for the
trial are on the card PM-590 (and the later cards of the refactor, "Refaktor 2").

## Where Effect is allowed

Only in a module that has been rewritten on purpose, behind a plain TypeScript facade. Today:

| Program                  | File                                           | Facade                                                                 |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------- |
| the runner's input queue | `apps/server/src/runner/input-queue.ts`        | `InputQueue` (same file)                                               |
| the message delivery     | `apps/server/src/runtime/delivery/delivery.ts` | `MessageDelivery` (same file, exported by `runtime/delivery/index.ts`) |

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
tests that count promise ticks) and callers depend on that. The facade of the input queue therefore
runs its program with an **inline scheduler** (a trampoline: a task runs at once on the caller's
stack, tasks queued meanwhile run after it; `executionMode: 'sync'`, `shouldYield: () => false`),
given through the context of `Effect.runSyncWith(context)` / `runForkWith(context)`, and with its own
`runPromise` (`runFork(effect).addObserver(...)` that resolves or rejects the promise by hand).

Two traps found while doing this: `Effect.provideService(effect, Scheduler.Scheduler, ...)` does not
change how the fiber is scheduled (the scheduler must be in the context the run function gets); and
`MixedScheduler('sync')` alone was not enough, tick counts still went from 1 to 2. The delivery facade
has its own copy of the same ~40 lines; a shared place would be a new module, so decide that on a card
before a third program needs it.

## Timers and cleanup

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
