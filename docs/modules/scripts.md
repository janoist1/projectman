# scripts

## Responsibility

The repository's command-line tools (`scripts/`, `apps/server/scripts/`). This file describes the heavy-run queue
(`scripts/heavy`, with its lock in `apps/server/src/full-test`) and the merge-test runner it schedules.

## Sorted registries and generated barrels (PM-1339)

Run `npm run generate:barrels` from the repository root after adding, removing or renaming a
source file in `packages/shared/src/` or `apps/server/src/contracts/`, and commit the generated
`index.ts` files with the source change. Do not edit these barrels by hand. The generator
(`scripts/barrels/generate.ts`) recursively exports TypeScript source files, excluding tests,
declarations, snapshots and the root barrel itself. Its explicit shared-helper exclusions preserve
the existing public API. A new private helper belongs in that exclusion list.

Exports are sorted by extensionless relative module path using JavaScript's default string sort
(case-sensitive, locale-independent). `ERROR_CODES` in `packages/shared/src/api/error-codes.ts`
uses the same order by code: insert a new code at its alphabetical position, keeping any code-specific
comment with it, and add its translations to both web locales. MCP imports in
`apps/server/src/mcp/tools.ts` are sorted by module path; `TEAM_TOOL_GROUPS` is sorted by constant name.
`apps/server/test/architecture/registries.test.ts` checks all five registries and compares both
committed barrels with the generator output; handover-check selects it for changes in these folders.

## Machine places (PM-332, PM-1278)

Three full test suites at once (2026-10-04) took the load to 81–89 and the swap to 6 GB: every member's vitest
starts a worker per core, about 150 MB each. So **the machine has one pool of places** (the make-jobserver
pattern; PM-1278, replacing the one-at-a-time lock of PM-332), and every heavy run takes its places from it.
A place is one process's share of the machine: a run of `n` places has one main process and `n − 1` workers.

Only Claude Code members may run checks in the background: they receive completion
notifications. Codex, Gemini (agy) and NanoGPT members run in the foreground and follow
running command ids until completion, as their provider context instructs. Gemini's native
`command_status` follows a running command; bounded `schedule` wakeups are an optional
provider-specific path. Never end a turn while a check still runs.

- **Capacity.** `machinePlaces({ cpus, memoryBytes })` (`packages/shared/src/config/test-workers.ts`):
  `clamp(min(cpus, floor((GiB − 4) / 2)), 2, 16)`. Two GiB per place, four GiB for the machine itself.
- **Requests.** A run asks for `{ min, max }` places or `'all'`. The root `npm test` and the server's ordinary
  full test ask for `all`. Merge checks use `mergeTestPlaces(host, maxWorkers)` (PM-1338): main + usable
  workers, capped at `max(2, capacity - 2)` places; the server also respects its configured worker limit.
  On a six-place machine the merge holds four places with three workers, leaving two for developers.
  `npm run merge-test` selects this policy through `--places merge-test`; the server's merge check runs it
  under its ticket and takes none again. The root `npm run typecheck` asks for 2, `npm run shots` and `take_screenshots`
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
- **Memory pressure (PM-1278 B1 / PM-1314).** The places count only what goes through the pool. The engine
  (and single mode) measures the machine's memory pressure every 10 s (`full-test/machine-pressure.ts`:
  macOS `sysctl kern.memorystatus_vm_pressure_level`, Linux `/proc/pressure/memory`) and writes it atomically
  to `pressure.json` in the pool's folder, since the sandboxes may not run `sysctl`. While a reading at most
  30 s old is `critical`, the head hands out nothing and the wait line says so; a stale or missing file
  holds nothing back, so without an engine only the places count.
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
- **Who queues.** The CLI `npm run heavy -- [--label <text>] [--max-wait <s>] [--places all|merge-test|<n>|<min>-<max>] <command>`
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
  These required-lock runs reserve `mergeTestPlaces` instead of `all`, and cap their workers to the grant.
  Merge dependency writers and workspace readers additionally hold the per-repository store lock
  (`_merge-deps/<repoKey>.lock`, capacity 1; PM-1338) while using a generation. Machine places come first;
  store holders never request places. This lock is separate from the machine pool and pressure meter.
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
  test (an unmapped snapshot falls back). Per-tool JSON snapshots in
  `apps/server/src/mcp/__snapshots__/tools/` select `apps/server/src/mcp/tools.test.ts` in both
  merge and hand-over checks. That test compares one JSON file per tool and checks the directory
  against the registered tool names, so missing and orphaned files fail. Update with
  `npx vitest run src/mcp/tools.test.ts --configLoader runner -u` in `apps/server`, remove files
  for retired tools, then rerun without `-u` to verify the complete file set.
  Changed helpers and scripts select tests reaching them in
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
  Paths only a few server tests read by path run those tests (PM-1354): `deploy/mac/**` and
  `.github/workflows/*.yml`, `projectman.structure.yaml` and `apps/server/test/architecture/**`, and
  `scripts/merge-test/**` each have an `OWNED_PATH_RULES` entry (`scripts/merge-test/scope.ts`) with its
  test list; a diff made only of such paths (and the rules' own tests) gets the `owned` scope: server
  type check and those tests. A guard test fails when a server test that reads one of these paths is
  not named by a rule. A `packages/templates/**` change runs the templates workspace and the
  workspaces that import `@projectman/templates` (the server through the module/test graph seeded by
  its importers); next to a shared source change it requires all workspaces.
  Changes to `scripts/full-test/**`, non-code scripts, the widget, other
  packages, manifests/lockfiles, TypeScript/Vitest configuration, such paths next to other code or
  unknown paths require all workspaces; `--all` forces them. `--dry-run [<commit>]` prints the scope and each
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
  test fails when a server or web test that reads a repository file by path (an
  `import.meta.glob`, or a path from `import.meta.url` read with `readFileSync`, `readdirSync`,
  `existsSync`) is not named by a rule, or a rule names no existing test. The former conditional
  `CLAUDE.md` test commands are now rules (`i18n`, `web-get-contracts`, the merge-test watchdog,
  `start-offer` and `golden-path-*`). App-harness consumers are selected as direct importers;
  `merge-test-handover.test.ts` guards this, and the cap never cuts direct tests (PM-1337).
  The tool-definition snapshot and the
  migration folder (`apps/server/src/db/migrations/`) has a `SELECTION_RULES` path rule selecting
  loader, baseline, database, journal, handle, history and retained migration tests: SQL and metadata
  have no import edge. Merge impact treats these data files as changes to the `db` module. A rule
  with `broad: true` has sources so wide that matching one does not make a file "mapped" (the
  not-mapped list). **Documents a test reads (PM-1337).** `TEST_READ_DOCS`
  (`scripts/merge-test/scope.ts`) maps the documents tests read by path (`docs/HYBRID.md`,
  `docs/MACHINE-DEPENDENT.md`, `docs/ARCHITECTURE.md`, `docs/EFFECT.md`) to those tests. Such a document is
  no documentation-only file: the merge check runs the server tests with the tests that read it added
  (`refine.ts`), and the hand-over check chooses them by the rule built from the same map. A test
  that reads another document by path adds it there; the tests check documents' machine-readable
  facts, never their wording. **Order by proximity (PM-1306).** The tests come
  nearest first and the alphabet only decides between tests of the same proximity. **The cap
  (PM-1337).** The cap, `TARGETED_TEST_FILES_MAX` (60, `packages/shared/src/config/test-workers.ts`),
  cuts only the farther tests: every `direct` and `rule` test, the first `MODULE_TESTS_ALWAYS` (10)
  `module` tests and the first `NAME_TESTS_ALWAYS` (10)
  `name` tests always run, and the remaining room under the cap goes to the rest of the `module` and `name` tests
  and the `graph` tests in order. A run can therefore be larger than 60 files (the nearest tests decide
  the merge); the last lines say how many tests the cap cut:
  1. `direct`: the changed tests, the tests of a changed snapshot, and the tests that import a changed
     file themselves (snapshot tests first). A test that only imports a changed `packages/shared`
     export through the package is not direct: it is `graph`, however many there are;
  2. `rule`: the tests a `SELECTION_RULES` entry chose;
  3. `module` (PM-1402): tests (inside the merge check's scope) whose file name holds, as whole
     hyphen-separated words, the name of a changed module: the folder (`admission`), the file name
     (`task-starts`) and the last word of a hyphenated file name (`starts`) of a changed
     non-test file outside the central files (`packages/shared`, `contracts`, `kernel`, `db`,
     `assembly.ts`, the test helpers, the web `i18n` and `mocks`; generic names such as `index` and
     names under 5 characters left out). They rank ahead of the tests that the central files' imports
     reach, so a changed `runtime/admission` keeps `*session-starts*`, `*admission*` and
     `*deferred-starts*` inside the 60. The tests of the workspace the change touched most come first,
     then the tests with more matching names, integration tests last. `--dry-run` names them in a
     `module-name test(s) ... run ahead of the import graph` line;
  4. `name`: tests (inside the merge check's scope) that use a changed name without importing the
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
  5. `graph`: the tests reached through further imports (snapshot tests first, then by distance).

  A test counts once, at its nearest proximity. Over the cap the last lines say
  `ran R of M (cap 60 cuts only the farther tests, the N nearest always run); the merge-test runs the other C`
  (exit 0), `the cap cut C test(s)` and
  `left out by proximity: 0 direct, 0 selection-rule, <n> module-name, <n> name-usage, <n> farther import-graph`
  (the first two are always 0), and name the omitted tests of the `name` tier, at most 20 per line and then `(+N more)`
  (run them yourself with `npx vitest run <files>`); it never falls back to a full package. Exit codes: 0 green, 1 a step failed, 2 usage or
  git error. `--dry-run` prints the steps only. A merge-test change keeps the merge-test output
  unchanged; the shared import analysis is only extended (`valueConsumers`, `typeOnly`).
  New `dead-code` findings are fixed, not added to the baseline. A test that no import reaches gets a rule in
  `SELECTION_RULES` and a file that starts programs an entry in `RUNTIME_ENTRIES`, not a new line in
  `CLAUDE.md`. The command takes two to four machine places once; its steps run under that ticket.
  **Result record (PM-1380).** A real (not `--dry-run`) run writes `projectman/handover-check.json` under
  the workspace's git directory (`git rev-parse --git-path`, so a clone and a linked worktree resolve it
  alike), atomically (temp file + rename): `{version: 1, commit, clean, outcome, exitCode, startedAt,
finishedAt, summary?}` (`HandoverCheckRecord`, `packages/shared/src/domain/handover-check.ts`). The commit
  and the cleanliness are read before the steps and again after them; `clean` is true only when both reads
  saw the same commit and no uncommitted or untracked file. A failed write is a warning and leaves the exit
  code as it was. The record is what the gate of the move into review reads when the repository's
  `handoverCheck.command` is set (`docs/modules/core-tasks.md`); a repository that sets another command
  must write the same record, or its developers can only hand over with a recorded reason.
  **Boundary tests the sandbox cannot run (PM-1406).** In the members' sandbox a test that binds a port
  or reads a refused path fails with EPERM although the change is fine. The hand-over check lists such a
  file as `not run (sandbox)` and does not fail on it, when all three hold: (1) `PROJECTMAN_SKIP_PTY_TESTS=1`
  (the members' sandbox signal, which the merge-test reads too; without it nothing is classified);
  (2) its own probe (`net.createServer().listen(0, '127.0.0.1')` in the hand-over process, `probeSandbox`)
  was refused with EPERM or EACCES for a listen failure (the Claude sandbox allows loopback binding, so
  there a listen failure stays a failure); (3) every failed test, suite and module error of the file
  carries a sandbox signature in the vitest reporter's structured facts (`code`, `syscall`, `address`,
  `path`; no output text is parsed): `listen`/`bind` with EPERM/EACCES after the probe, or an EPERM from a
  file-system read call that the hand-over process confirms (`lstat` of the path is refused too; EACCES
  and writes never count). One assertion failure in a file, an unhandled error, an interrupted run or an
  unreadable facts line keeps the run a failure. The reporter prints the facts line
  (`merge-test run facts: <json>`) only when `PROJECTMAN_TEST_RUN_FACTS=1`, which only the hand-over run
  sets, so the merge-test output and selection are unchanged and the merge-test still runs every file.
  The last lines name the files (`not run (sandbox): <file>: <reason> (<n> tests)`); name them in the
  hand-over note. The exit code stays 0 and the result record's `summary` carries the not-run count.
  A platform whose sandbox reports other error codes has no classification: the failure stays a failure.
  `listenLoopback` (`apps/server/test/helpers/loopback.ts`) makes a test's server start reject at once on
  a listen error instead of running into the hook timeout.
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
