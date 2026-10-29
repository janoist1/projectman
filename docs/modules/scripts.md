# scripts

## Responsibility

The repository's command-line tools (`scripts/`, `apps/server/scripts/`). This file describes the heavy-run queue
(`scripts/heavy`, with its lock in `apps/server/src/full-test`) and the merge-test runner it schedules.

## Heavy-run queue (PM-332)

Three full test suites at once (2026-10-04) took the load to 81–89 and the swap to 6 GB: every member's vitest
starts a worker per core, about 150 MB each. So **one heavy run goes at a time on the machine**, and a run's
workers follow the machine's size.

- **The lock** (`apps/server/src/full-test/heavy-lock.ts`, with an Effect core in
  `full-test/heavy-lock-core.ts`). The CLI imports the facade directly; `full-test/index.ts` also
  loads the sandbox runtime. macOS has no `flock` or `lockf`, so the lock is a
  directory in `/tmp/projectman-<uid>/heavy` (`defaultHeavyLockDir()`, `PROJECTMAN_HEAVY_LOCK_DIR`): its parent
  must be 0700 and ours, or the queue is `heavy_lock_unavailable`. `holder/` is the lock itself (`mkdir` is
  atomic; `owner.json` inside names the process, its label, checkout and session); `queue/<ticket>.json` is one
  file per waiter, the ticket sorting by queue time. A waiter and the holder write a heartbeat (`utimes`, every
  5 s) on their file. The head of the queue removes the tickets and the holder that are stale (heartbeat older
  than 30 s, or the pid gone) and takes the lock; breaking a holder is a `rename` away, atomic, so one waiter
  wins. A live holder is never broken, however long it runs. After a sleep a live lock can be broken for a
  moment (two runs overlap); the holder notices at its next heartbeat and logs it once. `readHeavyQueue` shows
  who holds it and who waits, for the PM-300 display.
- **The run's directory (PM-847).** Whoever holds the lock prepares its run directory
  (`full-test/sandbox.ts`, `runDirOf` on `canonicalRoot` roots): a byte-measured `pmft-*` directory with room
  for the sandbox's sockets (see "Server full test before review"), made only once the lock is held; when no
  root has room, the run ends as `sandbox_unavailable` and releases the lock.
- **Idle close (PM-569).** An idle session with a live heavy-run holder or waiter stays open,
  and gets its full idle interval after the last sweep that saw the run. Heartbeats must be at most
  30 seconds old and the PID must live. After 120 minutes since `lastActivityAt`, idle closure applies
  even with a run present. Other closure reasons and meeting sessions are unchanged. Only queued
  commands are covered; grace is in memory and does not survive a server restart.
- **Who queues.** The CLI `npm run heavy -- [--label <text>] [--max-wait <s>] <command>`
  (`scripts/heavy/cli.ts`) runs the command at its turn; the root `npm test`, `npm run typecheck` and
  `npm run shots` go through it. It says on stderr who it waits for; `--max-wait` ends with exit status 75.
  The command runs under `scripts/lib/child-guard.mjs` (PM-863) as the leader of its own process group
  (its stdin is `/dev/null`): SIGINT, SIGTERM and SIGHUP to the CLI, and the CLI's death even by SIGKILL
  (the guard's stdin is a pipe from the CLI), stop the whole group (SIGTERM, SIGKILL after 5 s), and any
  member left when the leader exits is killed. The lock is released only after the guard has gone, so
  no vitest worker outlives an interrupted run or overlaps the next one. An unusable queue folder (`heavy_lock_unavailable`) stops the
  command with exit status 78 and a four-line message; it does not run without the queue (decision 33,
  PM-346). `PROJECTMAN_HEAVY_LOCK_HELD=1` (set for everything the CLI runs) makes a nested call run
  without queueing. Runs inside one workspace (`npm test -w …`, `npx vitest related …`) do not queue.
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
  `killed`. `fullTestEnv` sets `PROJECTMAN_HEAVY_LOCK_HELD=1`, so the scripts inside do not queue again. With an
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
- **Workers.** `defaultTestWorkers` (`packages/shared/src/config/test-workers.ts`): half the cores, at most 4,
  one per 4 GiB of memory, at least 1. Every `vitest.config.ts` sets `maxWorkers` to it and `minWorkers` to 1.
  `VITEST_MAX_FORKS` and `VITEST_MAX_THREADS` (the server's full test sets them from `reviewTest.maxWorkers`)
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
  before the default branch moves (PM-386, PM-490, PM-657). The first-parent diff and the union of
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
  **Timing measurement (PM-866, 2026-10-20, Mac, main `fab09438`).** With four workers,
  the comparable server baseline on PM-865 was 421.5–430.6 s (534 files, 12,316 tests;
  collect 272.3–275.4 s and tests 1,321.9–1,344.7 s summed across workers). The final
  run in the same Claude Code sandbox, excluding PTY files, took 306.14 s (collect
  47.00 s, tests 1,145.95 s), with 538 files and 12,427 tests. Four files failed because
  a long temporary path exceeded the macOS Unix-socket limit; all four passed when
  rerun with a short TMPDIR (75 passed, one skipped). In the replay, one host test
  uses its successful 17.9 s rather than the failed JSON's 1.68 s. This raises the
  estimated complete server wall time to about **310–322 s**, below the 600 s target.
  Registered test counts did not decrease. The corrected wall improvement over the
  426.05 s baseline average is 24–27%; collect fell about 83%.
  A fresh four-worker web run took **99.59 s** (178 files, all 2,257 tests passed).
  Forty first-parent merges ending at the cutoff replay as 15 module scopes, 20 full
  scopes, one cloud scope, one shared scope, two workspace scopes and one skipped check.
  Using the corrected server file times divided by four, the measured web time and
  shared/templates/widget allowances of 10/1/2 s gives a **393.47 s median** and
  **399.62 s nearest-rank p90**: the typical estimate misses 300 s by 93.47 s at the
  median. Module scopes retain 92–99% of the complete server file-time sum; counting
  fewer files does not remove most of the slow harness work. The full-workspace wall
  estimate is about 423–435 s (corrected server wall plus web and the three allowances),
  not an observed end-to-end full run. These estimates exclude collect/typecheck overhead
  and the 23 PTY files missing from the server JSON; their cost is not known to be zero.
  The report, top twenty files and forty replay rows are attached to PM-866 and PM-849;
  PM-876 tracks the remaining time gap and the owner's structural options.
  Historical successful merge step times and worker counts cannot be reconstructed:
  `passedOutputTail` retains flaky markers only. Merge checks did not store their duration
  before PM-876 (they call the executor directly and write no `full_test_runs` row); since then
  every one is recorded in `merge_check_runs` (migration 92: time, queue wait, the `maxWorkers`
  the hub passed, scope and step timings from the engine; `list_merge_checks`, `get_task`).
  Runs before that have no record. Requested-to-merged timeline intervals
  include queue time and retries, so they are upper bounds. The last explicit setting
  record (PM-798, owner, 2026-10-19 11:38 UTC) reduced `reviewTest.maxWorkers` to two;
  it is not a per-run worker measurement. Only one merge at this cutoff contains all
  five optimizations, so a twenty-merge after sample is not yet available.
  Repeat on the engine Mac with the same sandbox capabilities and PTY exclusion as
  the baseline, and a **short, writable TMPDIR** for Unix sockets. The earlier Codex
  sandbox run (PTY probe allowed, local listeners refused) is diagnostic only.

  ```sh
  VITEST_MAX_FORKS=4 VITEST_MAX_THREADS=4 TMPDIR=<short-tmp> npm run heavy -- npx vitest run --root apps/server --configLoader runner --reporter=default --reporter=json --outputFile.json=<tmp>/after.json
  npm run merge-test -- --dry-run <commit>
  VITEST_MAX_FORKS=4 VITEST_MAX_THREADS=4 TMPDIR=<short-tmp> npm run heavy -- npx vitest run --root apps/web --configLoader runner --reporter=default --reporter=json --outputFile.json=<tmp>/web.json
  ```

  List commits with `git log <cutoff> --first-parent --merges -40 --format=%H`; run
  the dry-run once per commit with the current selector against each historical
  first-parent diff. Match selected paths to JSON `testResults` by repository path;
  report excluded PTY files and missing timings separately. Estimate each merge as
  selected file durations / 4 plus only its selected non-server workspaces. Report
  median and p90 separately from observed wall time. Retain the default reporter's
  collect/test totals too: JSON per-file durations do not include collect time.
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
