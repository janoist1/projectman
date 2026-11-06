# scripts

## Responsibility

The repository's command-line tools (`scripts/`, `apps/server/scripts/`). This file describes the heavy-run queue
(`scripts/heavy`, with its lock in `apps/server/src/full-test`) and the merge-test runner it schedules.

## Machine places (PM-332, PM-1278)

Three full test suites at once (2026-10-04) took the load to 81–89 and the swap to 6 GB: every member's vitest
starts a worker per core, about 150 MB each. So **the machine has one pool of places** (the make-jobserver
pattern; PM-1278, replacing the one-at-a-time lock of PM-332), and every heavy run takes its places from it.
A place is one process's share of the machine: a run of `n` places has one main process and `n − 1` workers.

- **Capacity.** `machinePlaces({ cpus, memoryBytes })` (`packages/shared/src/config/test-workers.ts`):
  `clamp(min(cpus, floor((GiB − 4) / 2)), 2, 16)`. Two GiB per place, four GiB for the machine itself.
- **Requests.** A run asks for `{ min, max }` places or `'all'`. The root `npm test`, the server's full test and
  `npm run merge-test` (through the heavy CLI; the server's merge check runs it under its ticket and takes
  none again) ask for `all`; the root `npm run typecheck` asks for 2, `npm run shots` and `take_screenshots`
  (`SCREENSHOT_PLACES`) for 3, the members' `npm ci` (`DEPENDENCY_PLACES`) for 2, and a workspace `typecheck`
  or `build` script for 1 (`--places 1`; under a holder's ticket it takes nothing). A workspace vitest asks for 2 to 4
  and gives back what it cannot use once it knows its files (`1 + min(workers, files)`); `npm run
handover-check` asks for 2 to 4 once, through the heavy CLI, and its steps run under that ticket. Only the
  head of the queue allocates, and the order is strict FIFO: a small request never overtakes a request for
  more places ahead of it. A grant can be reduced (`lock.reduce`), never grown. A `vitest related` run that
  selects more than `TARGETED_TEST_FILES_MAX` files (PM-1317) is a full run in effect: its reporter says so,
  releases its places and queues again for `'all'`; a `vitest run <files>` is not subject to the threshold.
- **The pool** (`apps/server/src/full-test/heavy-lock.ts`, with an Effect core in
  `full-test/heavy-lock-core.ts`). The CLI imports the facade directly; `full-test/index.ts` also
  loads the sandbox runtime. macOS has no `flock` or `lockf`, so the pool is a
  directory in `/tmp/projectman-<uid>/heavy` (`defaultHeavyLockDir()`, `PROJECTMAN_HEAVY_LOCK_DIR`): its parent
  must be 0700 and ours, or the queue is `heavy_lock_unavailable`. `holders/<ticket>.json` is one file per
  grant (the process, its label, checkout, session, command key and `granted` places); `queue/<ticket>.json`
  is one file per waiter, the ticket sorting by queue time, with its `places` request. `holder/owner.json`
  (the old lock, `mkdir` is atomic) holds **all** the places: a grant of every place takes it too, and a live
  one written by an older build blocks every grant, as does an entry without `places` (it counts as `'all'`).
  Waiters and holders write a heartbeat (`utimes`, every 5 s) on their file. The head of the queue removes the
  tickets and holders that are stale (heartbeat older than 30 s, or the pid gone) and takes its places;
  breaking a holder is a `rename` away, atomic, so one waiter wins. A live holder is never broken, however
  long it runs. After a sleep a live holder can be broken for a moment (two runs overlap); the holder notices
  at its next heartbeat and logs it once. `readHeavyQueue` shows who holds places and who waits, with the free
  places, for the PM-300 display; the wait line names the first holder and the number ahead.
- **One command at a time per session.** The same `sessionId` and command (`heavyCommandKey`: the checkout and
  the argument list) with a live entry of another pid is refused: exit status 79 and a message that names the
  running one. Do not start it again, wait for the running one (a backgrounded run is not restarted). A run
  with no session id has no such rule.
- **The run's directory (PM-847).** Whoever holds the lock prepares its run directory
  (`full-test/sandbox.ts`, `runDirOf` on `canonicalRoot` roots): a byte-measured `pmft-*` directory with room
  for the sandbox's sockets (see "Server full test before review"), made only once the lock is held; when no
  root has room, the run ends as `sandbox_unavailable` and releases the lock.
- **Idle close (PM-569).** An idle session with a live heavy-run holder (any grant) or waiter stays open,
  and gets its full idle interval after the last sweep that saw the run. Heartbeats must be at most
  30 seconds old and the PID must live. After 120 minutes since `lastActivityAt`, idle closure applies
  even with a run present. Other closure reasons and meeting sessions are unchanged. Only queued
  commands are covered; grace is in memory and does not survive a server restart.
- **Who queues.** The CLI `npm run heavy -- [--label <text>] [--max-wait <s>] [--places all|<n>|<min>-<max>] <command>`
  (`scripts/heavy/cli.ts`) runs the command at its turn (`--places` defaults to `all`); the root `npm test`,
  `npm run typecheck` (`--places 2`), `npm run shots` (`--places 3`), `npm run merge-test` and `npm run
handover-check` (`--places 2-4`), and every workspace `typecheck` and `build` script (`--places 1`) go through it. The
  GitHub merge-check workflow runs `scripts/merge-test/cli.ts` directly: its runner has no pool. It says on
  stderr who it waits for; `--max-wait` ends with exit status 75, a second run of the same command in the same
  session with 79.
  The command runs under `scripts/lib/child-guard.mjs` (PM-863) as the leader of its own process group
  (its stdin is `/dev/null`): SIGINT, SIGTERM and SIGHUP to the CLI, and the CLI's death even by SIGKILL
  (the guard's stdin is a pipe from the CLI), stop the whole group (SIGTERM, SIGKILL after 5 s), and any
  member left when the leader exits is killed. The lock is released only after the guard has gone, so
  no vitest worker outlives an interrupted run or overlaps the next one. An unusable queue folder (`heavy_lock_unavailable`) stops the
  command with exit status 78 and a four-line message; it does not run without the queue (decision 33,
  PM-346). `PROJECTMAN_HEAVY_LOCK_HELD` (set for everything the CLI runs) carries the holder's ticket: a nested
  call whose ticket is a live holder in the pool runs without asking again. A bare `1` counts only while a live
  legacy `holder/owner.json` exists, so a hand-set `1` does not bypass the pool.
  **Workspace runs (PM-1278).** A workspace vitest (`npm test -w …`, `npx vitest related …`) queues too: every
  `vitest.config.ts` lists the `machinePlaces()` plugin (`scripts/heavy/vitest-places.mjs`), which takes 2 to 4
  places at the start of the run (or none under a held ticket), sets the worker count from them, and gives back
  what the files do not use when the run starts (reporter `onTestRunStart`). It releases on close, and on
  process exit. The wait line is the CLI's.
  **Direct runs (PM-869).** A member's own `npx vitest run` / `related` is not under the guard, and an
  interrupted one used to leave its forked workers (about 4 GB each in `apps/server`). Every vitest config
  lists `scripts/lib/vitest-parent-guard.setup.mjs` in `setupFiles` (`PARENT_GUARD_SETUP`): a forked worker
  ends itself with SIGKILL (vitest replaces `process.exit` in a worker with a throwing function) when the
  IPC channel to its parent closes (`disconnect`) or its parent pid changes
  (`scripts/lib/worker-parent-guard.mjs`, polled every 2 s). Worker threads die with their process and are
  left alone. A worker stuck in a synchronous loop cannot run the handler; the heavy CLI's process-group
  kill is the only thing that reaches it.
- **The server's full test** (`createFullTestExecutor({ heavyLockDir })`) takes the lock before it prepares the
  run directory; the wait is not part of `durationMs` and `timeoutMs`, and an abort while waiting ends as
  `killed`. `fullTestEnv` sets `PROJECTMAN_HEAVY_LOCK_HELD` to the run's ticket (and `PROJECTMAN_HEAVY_LOCK_DIR`, which the sandbox's env allow list would drop), so the scripts inside do not queue again. The server's full test asks for `all` places. With an
  unusable folder it runs without the queue and logs a warning: the review must not stall on it. The merge
  check is the exception (PM-658): `FullTestSpec.requireHeavyLock` (optional; the merge always sends `true`)
  makes a missing or unusable queue end the run as `error` / `heavy_lock_unavailable` (`durationMs` 0, no
  sandbox, no `onStarted`), so the merge blocks as `check_error` and never runs one without the queue.
  A merge train (PM-660) submits one common candidate through that same executor and lock;
  its repository slot and card locks do not permit parallel heavy runs or bypass the queue.
  Dependency preparation (`FullTestSpec.npmCi`, PM-710) requires that lock too: probes, sandboxed
  `npm ci`, dependency copies, generation publication and the test share one reservation and one
  `timeoutMs` budget after waiting. `onStarted` fires once; each probe gets at most 60 seconds and
  every child gets only the remaining budget. Abort waits for the running child before cleanup and release.
- **The members' sandboxes** (`SandboxPaths.heavyLockDir`): `projectman-<uid>` is writable and
  `PROJECTMAN_HEAVY_LOCK_DIR` is set, together with `npm_config_prefer_offline` (install from the member's own
  npm cache when there is no clone). The same folder and variables go to a Codex member as
  `AgentSandbox.portable` (PM-346): `buildCodexArgs` adds the parent to `sandbox_workspace_write.writable_roots`
  (only in `workspace-write`) and sets each variable with
  `shell_environment_policy.set.<NAME>`, so every command sees them, also one run outside the sandbox after a
  question. The server makes the missing parent (0700) before the process starts.
- **Workers.** `placeWorkers(granted)` (`packages/shared/src/config/test-workers.ts`) is the only place that
  decides a worker count: `granted − 1` (one place is the main process), at most `defaultTestWorkers` (half the
  cores, at most 4, one per 4 GiB of memory), at least 1. No `vitest.config.ts` counts its own; the plugin
  and the heavy CLI (for the command it runs, when the caller set none) apply it. `VITEST_MAX_FORKS` and
  `VITEST_MAX_THREADS` set by the caller (the server's full test sets them from `reviewTest.maxWorkers`)
  still win: vitest takes `poolOptions.*.max*` before `maxWorkers`.
- **Two server test projects (PM-865).** `apps/server/vitest.config.ts` has two `test.projects`, both
  `extends: true`. `isolated` is plain vitest, a fresh module graph per file in a `forks` process. `pooled` runs
  the files `pooledTests` (`apps/server/test/isolation.ts`) picks in the `threads` pool with `isolate: false`:
  the files of a worker share its modules, process and globals, so the server's modules load once per worker,
  not once per file. The choice is a machine rule, not a list kept by hand: a file is `isolated` when it, or a
  test-side file it imports (under `test/`, `*test-helpers*`, fixtures), holds a pattern of
  `ISOLATION_REQUIRED` (module mocks, `vi.resetModules`, `process.chdir`/`on`/`exitCode`/`env` writes, globals set
  by hand, spies on `process`, fake timers nobody gives back) or is named in `ALWAYS_ISOLATED` (with a reason),
  or is a PTY test. `test/isolation.test.ts` covers each pattern. `pooled` puts `vi.stubEnv` and
  `vi.stubGlobal` back after each file (`test/setup/unstub-after-file.ts`; not after each test, which would end a
  `beforeAll` stub early). Vitest decides whether a worker is recycled from the root
  `poolOptions.<pool>.isolate`, never from a project's, so the root sets it for `threads` only. The pool's
  `minThreads` equals its `maxThreads`: with fewer, tinypool ends an idle worker thread without isolation and the run
  fails with "Terminating worker thread". The two pools would run at the same time, so `pooled` has
  `sequence.groupOrder: 1`. `VITEST_MAX_FORKS` caps the threads too (`VITEST_MAX_THREADS` first). A failed file
  is named `FAIL  |pooled| …` or `|isolated| …`; `merge-test` and `full-test/output.ts` read both.
- **The server's merge check** runs the repository's `npm run merge-test` in the full test sandbox
  before the default branch moves (PM-386, PM-490, PM-657). `reviewTest.runner` chooses where it runs per
  repository: `engine` (the default) or `github_actions`, which needs the repository's `github` owner/name and runs
  the same check as a GitHub Actions run (see [services/merges](services-merges.md)). The first-parent diff and the union of
  both git trees' import graphs select changed server modules and their transitive dependents.
  A module check runs one server typecheck and one Vitest invocation with explicit test paths:
  adjacent tests, external tests reached through helpers, uncertain test dependencies, architecture
  tests, integration tests and golden paths.
  **Server and script impact (PM-864).** Server contracts and config use their source modules;
  script code uses the server workspace. Both server and script files are read from each git tree.
  Changed tests select themselves, deleted tests have no effect, and snapshots select their owning
  test (an unmapped snapshot falls back). Changed helpers and scripts select tests reaching them in
  either tree; a script dependency also proves a source dependency. Server markdown is ignored.
  Fixtures, test setup and other non-code changes fall back to the full server workspace, as do
  nonliteral/unresolved production imports, unmapped sources, empty selection and ambiguous Vitest
  substring filters. Web changes retain full web checks; documentation-only changes skip tests.
  Files importing `child_process`, `worker_threads`, `vm`, `module` or `@lydell/node-pty` stay uncertain
  unless audited in `scripts/merge-test/runtime-entries.ts`: its `RUNTIME_ENTRIES` map adds explicit
  repository entrypoint edges, and `[]` means only external programs/packages. Unknown launchers
  and missing historical entrypoints keep every reaching test. Filesystem imports alone do not
  imply runtime code loading. The runtime-entry guard always runs alongside architecture guards
  and rejects missing keys/targets or keys without a runtime import; reviewers verify the entries
  against the launcher's code. Integration tests, golden paths and tests without a source dependency
  also always run.
  **Shared export impact (PM-843).** `packages/shared/src` changes run shared's own tests and use
  `scripts/merge-test/shared-impact.ts` to follow named exports from its barrel, relative shared
  dependencies and named consumers in both git trees, including `scripts/`. The affected server files
  and script consumers seed the server module/test graph. Web and widget consumers run their whole
  workspace. Shared changes always typecheck every workspace. A shared test or other non-source file
  selects only shared's tests.
  Unsupported exports/barrels, duplicate export names, uncertain or escaping shared dependencies,
  shared subpath imports, analysis errors or affected template consumers require all tests.
  Namespace, side-effect, dynamic or otherwise uncertain consumer imports keep that consumer.
  The architecture checker and shared export analysis share trivia recognition: regex literals at
  proven expression starts cannot create import/export tokens or hide the following real import.
  Changes to `scripts/merge-test/**`, `scripts/full-test/**`, non-code scripts, the widget, other
  packages, manifests/lockfiles, TypeScript/Vitest configuration, architecture guards or unknown
  paths require all workspaces; `--all` forces them. `--dry-run [<commit>]` prints the scope and each
  `merge-test step: npm <args>` without executing checks or checking out the commit (default `HEAD`).
  It compares against the commit's first parent; a non-merge commit retains the full-run scope.
  Scope, selected modules, test count and fallback reason are logged before and after execution. The executor holds
  the machine's lock, so the nested root scripts do not queue again.
  **Hand-over check (PM-1289).** `npm run handover-check [-- --base <rev>] [--dry-run]`
  (`scripts/merge-test/handover*.ts`) is the developer's version of the merge check: from the diff
  against `merge-base HEAD main` plus uncommitted and untracked files it selects the nearest tests
  of every workspace and runs `npm run dead-code`, the type check of the affected workspaces and
  those test files (no queue, no step cache). It reuses the merge-test's scope, shared export
  analysis and server module analysis and then follows the file-level **value** import graph
  (a statement-level `import type` carries no change into a test), so it never selects a test the
  merge check would not run (rule tests aside). **Selection rules (PM-1299).** A dependency no import
  shows (a test that reads the repository by path, such as a glob or the structure map, or one that
  reaches the code over HTTP or a domain call, such as the `operator-*` tests) is one entry of
  `SELECTION_RULES` (`scripts/merge-test/handover.ts`): `reason`, `sources` (path patterns: a
  changed file matching one selects the tests), `tests` (test file patterns that then run) and
  optionally `on: 'add-delete'` (only an added or deleted file counts). Patterns are repository
  paths: `*` stays in a folder, `**` crosses folders, a trailing `/` is the folder's subtree. A guard
  test fails when an `import.meta.glob` test is not covered by a rule or a rule names no existing
  test. The tool-definition snapshot and the `*-migration` tests need no rule: the shared export
  analysis and the import graph reach them. **Order by proximity (PM-1306).** At most
  `TARGETED_TEST_FILES_MAX` (60, `packages/shared/src/config/test-workers.ts`) files run, so the
  nearest come first and the alphabet only decides between tests of the same proximity:
  1. `direct`: the changed tests, the tests of a changed snapshot, and the tests that import a changed
     file themselves (snapshot tests first). A test that only imports a changed `packages/shared`
     export through the package is not direct: it is `graph`, however many there are;
  2. `rule`: the tests a `SELECTION_RULES` entry chose;
  3. `name`: tests (inside the merge check's scope) that use a changed name without importing the
     file: an exported name declared, or a compound identifier (`onLeave`, `TeamToolInput`) used, on a
     line that differs from the base in a changed non-test file (comments do not count). Using a
     compound name on a changed line is not enough: the code must also declare it (`name:`, a property,
     parameter or typed variable), so `localeCompare` is not a changed name. One step further, a
     `packages/shared/src` function called on a changed line (`isOnLeave(member)`) adds the compound
     names its body (up to the next export, at most 40 lines; comments left out) uses (`onLeave`); the step stops there, the functions that
     body calls are not followed. A name nearly every test uses (over a
     quarter of them, and more than 10) is ignored; the others rank the tests: those in the workspace
     the change touched most (by changed files) first, then those that set a name to a literal
     (`name: true`, `name = 'x'`) rather than only read it or stub it (`name: () => []`), then those using more and rarer changed names, then by path. Integration tests
     (`*.integration.test.*`, skipped in a sandbox) go behind the others in the `direct`, `name` and
     `graph` tiers;
  4. `graph`: the tests reached through further imports (snapshot tests first, then by distance).

  A test counts once, at its nearest proximity. Over the cap the last lines say
  `ran 60 of M (cap 60); the merge-test runs the other M-60` (exit 0) and
  `left out by proximity: <n> direct, <n> selection-rule, <n> name-usage, <n> farther import-graph`,
  and name the omitted tests of the nearer proximities, at most 20 per line and then `(+N more)`
  (run them yourself with `npx vitest run <files>`); it never falls back to a full package. Exit codes: 0 green, 1 a step failed, 2 usage or
  git error. `--dry-run` prints the steps only. A merge-test change keeps the merge-test output
  unchanged; the shared import analysis is only extended (`valueConsumers`, `typeOnly`).
  **Merge check records.** Every merge check is recorded in `merge_check_runs` (time, queue wait, the `maxWorkers`
  the hub passed, scope and step timings from the engine; `list_merge_checks`, `get_task`). Requested-to-merged
  timeline intervals include queue time and retries, so they are upper bounds, not run times.
  **Rerun and marker lines (PM-842).** `scripts/merge-test/steps.ts` runs the steps one by one (the
  full run is split by workspace: every type check, then every test, so a failed file belongs to a
  workspace). A failed `test` step reruns once, with only its failed files, when it ended with an
  exit code, 1-5 files can be read from vitest's `FAIL` lines, there is no "Unhandled Errors"
  block and the merge (`HEAD^1..HEAD`) did not change any of those files (a card's own tests are
  never rerun). A green rerun makes the step green and prints `merge-test flaky: <path>` per file; any
  other failure prints `merge-test failed: <path>`. The marker lines come last, before the closing
  `merge-test scope:` line; the rule (`mergeTestMarkerLine`, `mergeTestMarkedFiles`) is in
  `packages/shared/src/domain/merge-test.ts`. `npm run merge-test -- --files <path>...` runs only
  those test files (grouped by workspace, no type check, same rerun rule; a path absent from the
  checkout prints `merge-test skipped (absent): <path>` and is left out).
  `--files-from-env` takes the same list as a JSON array (1 to 20 files) from `MERGE_TEST_FILES`
  (empty or absent: the plain scope mode; not with `--files`, `--all` or `--dry-run`), so a CI
  workflow hands its input over through the environment and no shell reads it. `--shard <k>/<n>`
  (1 <= k <= n <= 8, with any mode, anywhere in the arguments) deals the type checks round-robin
  among the shards and runs every test step on every shard with `--shard=k/n` (every workspace's `test` script carries `--passWithNoTests` itself);
  the `merge-test timing:` line keeps the step's index in the whole list, so the shards' reports
  can be merged. The failed-file rerun (PM-842) stays inside the shard and has no shard flag.
  `.github/workflows/merge-check.yml` (PM-900) runs four shards on `macos-15` for a
  `workflow_dispatch` on a `pm-check/` branch only (no secret, read-only token, actions pinned to
  commits; `merge-check-workflow.test.ts` guards this). The executor
  (`full-test/output.ts`) reads the markers: `failedFiles` prefers the `failed` lines, and a passed
  run's `outputTail` holds the `flaky` lines. The server adds a system `task_note` to the card of a
  single merge, and to every member of a train, when its check passed with flaky files, and logs
  `merge check passed with flaky test files`; the merge goes on. The engine link is unchanged: the
  lines travel in the existing `failedFiles` and `outputTail` fields.
  **Passed-step cache (PM-845, PM-841).** Each step hashes
  `JSON.stringify({ v: 1, tree, args, node, platform, arch, maxWorkers })` with SHA-256: the complete
  `HEAD^{tree}`, npm arguments with absolute paths made repository-relative, Node version, OS,
  architecture and `VITEST_MAX_FORKS` (or an empty string). Only identical inputs reuse a step.
  The engine-owned executor reads `<app home>/cache/merge-test-steps.json`, drops entries older than
  14 days and writes a disposable `sandbox/merge-test-passed-keys` list, exposed by
  `PROJECTMAN_MERGE_TEST_PASSED_KEYS`. A hit prints `merge-test cached: <command>` and skips npm;
  `--no-cache` bypasses reads. Passed steps print `merge-test step passed: <64-hex key>` immediately
  and again before the closing scope line. Only an original invocation with exit code 0 produces a
  passed-step key; a green failed-file rerun stays flaky and is never cached, so retries retain its
  diagnostic and apply their own changed-file rerun condition. The shared `mergeTestPassedSteps`
  parser accepts at most 50 unique, line-anchored keys, after ANSI removal. After any command outcome, including timeout or
  cancellation, the executor merges those keys with fresh timestamps and the run id, retains the
  newest 500 entries and publishes the version-1 JSON by temporary file and rename. Cache failures
  are warnings and never change the test verdict. The sandbox never writes the persistent cache;
  markers have the same candidate-code trust boundary as the script and its exit code.
