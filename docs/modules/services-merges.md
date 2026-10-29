# services/merges

## Responsibility

Merging an approved card into the default branch: readiness, the merge train, the mandatory merge test, conflict
fixes and the merger member's tools.

## Merge (PM-452)

The system requests a merge; the member selected by `cardMerger` starts it with `merge_task`,
`POST /tasks/:taskKey/merge`, or the human inbox request. An authenticated super Operator may also start
a normal merge (PM-882); conflict fix checkouts and resolution submissions remain the merger's.
`mergeReadiness` and `mergeRepoOf` in shared
configuration rules determine readiness and the forward moves that need the approved commit on the
default branch. The source is the persistent handover (`task_handovers`, migration 47), then the review
pin, then the card's clean branch head. A client reads `Task.merge` and `Task.merged` like any member (PM-79).

`services/merges/` (PM-600; `Merges` in `merges.ts` is the facade, exported by `index.ts` with `MergeCardLock`)
persists requested, queued, running, failed and blocked states in `task_merges`,
with one running merge per project/repository in FIFO order. The slot is an Effect program
(`queue.ts`, `makeMergeQueue`: a `FiberMap` keyed `projectKey:repo`; `docs/EFFECT.md`); the merge itself is
the sequential async program of `steps.ts` (`MergeSteps`), which stops at its own checkpoints when its
abort signal fires (`kernel/effect.ts` `abortable`: an interrupted slot is free only after the merge settled
and released its check worktree). `notify.ts` holds the messages to the merger, `ports.ts` the structural
interfaces to the sessions, the slot peer and the check sandbox. The tools `merge_task` and
`prioritize_merge` are `mcp/merges/`, the two routes `api/merges.ts`. The card engine's `BranchMerger` prepares
the base, validates linked PRs, builds without changing the base, checks local checkout conflicts,
runs or reuses the approved commit's full check, checks readiness again, pushes and advances locally.
The check goes through two steps (PM-489): `check_waiting` while the full test waits for the machine's
heavy-run queue (PM-332), then `checking` when the executor reports that the run holds the lock
(`FullTestExecutor.run`'s `onStarted`; on a remote engine the `full_test_started` event, sent by the
`full_test.run` handler like `screenshot_started`). An engine that does not send the event leaves the step at
`check_waiting` until the run ends; a reused passed run goes straight to `checking`. A repository with
`fullTestAtMerge` and no `reviewTest` blocks (`check_unavailable`): nothing merges unchecked.

A lost engine link is waited for up to 15 minutes per loss, at most five losses per merge
(PM-791, PM-777). The repository slot stays occupied while other repositories can proceed.
`engine_waiting` replaces the card's visible steps; train manifests retain their last durable
step. A remote check follows its run with `full_test.attach` after reconciliation, including
replayed start events. If an engine restarted or cannot attach, a new attempt recreates the
check checkout only after PM-790's cleanup invariant stops the old test. Other lost merge
calls restart from prepare and recover an already published candidate before building again;
the publication flag is retained. Shutdown aborts the wait through the merge signal and requeues
unpublished work; a merge already pushing retains its durable publication recovery for startup. A timed-out
wait or repeated losses block with `engine_offline`; no database migration is needed.

**Where the check runs (PM-900, PM-906).** `reviewTest.runner` (`MergeCheckRunner`: `engine`, the default,
or `github_actions`) chooses it per repository; the merge check only (the review test is untouched), and
changing it is an owner-only `review_test` change; the pre-review test has its own `beforeReview`
(see "Full test before review", PM-909). `github_actions` needs the repository's `github`
owner/name (`review_test_runner_github`; at run time the lack of it blocks `check_unavailable`). In that
mode the hub makes **no local check checkout, takes no heavy-run lock and prepares no dependencies**: the
one helper `prepareMergeCheck` (`services/merges/check-preparation.ts`), used by the single-card merge
(`steps.ts`) and by the train group check and lone diagnosis (`train.ts`), releases any checkout of the
merge and builds the same `full_test.run` spec with a `githubActions` descriptor (`GithubActionsCheck`:
ref, `mergeId`, `owner/name`, base branch, merge commit, the `merge-check.yml` workflow and, for a lone
diagnosis, the failed files, at most 20) instead of `requireHeavyLock`/`npmCi`; the `cwd` is only a label
(`github-actions:owner/name`). The executor of the card's engine runs the workflow and answers with the
usual `FullTestResult` plus `externalUrl`, the run's page (the engine side is PM-907; the local executor and an
older engine refuse the descriptor with `github_unavailable`, a run that stopped with no result is
`github_run_error`). Both are operational errors: the merge or train blocks, nothing is split or blamed.
`endChecksIn` also stops a descriptor run by its `mergeId`, as the merge has no checkout path to match.
A train groups only cards of the same runner (`train-selection.ts`). `merge_check_runs` records the
`runner` and the `url` (migration 95); `list_merge_checks` shows both.

`task_merged` stands on the member who started the merge (`startedBy`, `{ kind, handle }`); a merge found
already in the default branch stays a system event.
Conflicts and failed checks notify the merger and keep the card in place; a failed check tells an AI merger
to send the card back (a fix round) if the card caused it, or to retry once and then ask a human. Operational failures notify
the AI merger or create an alert for the human merger. Calling the same tool retries under the same id.
Success records `Task.merged` with `via: tool`, then asks AutoAdvance to check the ordinary move rules.
The merger never moves the card itself. Every forward move path checks the default branch before the
transaction, including approvals and hand-on requests; manual merges discovered there are recorded
with `via: found` when a persistent handover exists.

**Queue order (PM-576).** One merge runs per repository (the full check runs on main merged with the card, so
a second one in parallel would check against a stale main), but the order of the waiting ones is a member's
decision, not the server's: by default it is the order of the requests (`task_merges.created_at`, `rowid`; a
retry keeps its place). The queue reads `ORDER BY prioritized_at IS NULL, prioritized_at DESC, created_at,
rowid` (`QUEUE_ORDER` in `db/task-merges.ts`; `prioritized_at` is a nullable column, migration 58, and
`created_at` is never rewritten). The card's merger or the Operator (in an owner's request, step `task_update`)
calls the team tool `prioritize_merge { task_key, reason }`, an owner does the same with the "Előre" button of the
queued merge box (`POST /api/projects/:key/tasks/:taskKey/merge/prioritize`, body `{ reason }`); both land in
`Merges.prioritize`: it allows the card's merger, an owner and the Operator only, takes a `queued` merge only
(`merge_not_prioritizable` otherwise), sets `prioritized_at`, writes `task_merge_prioritized` (`mergeId`, `repo`,
`reason`, `ahead`: the keys of the queued cards it went ahead of) on the card with the caller as its actor, and
pumps the queue. The mark is cleared when the merge starts running. A merge already first changes nothing (no
event). The running merge is not interrupted. Remote engine: the queue is on the server and the engine is not
involved; no new machine-dependent part.

**Durable train foundation (PM-659, part of PM-652).** `db/merge-trains.ts`, exposed as
`Repositories.mergeTrains`, stores a Zod-validated manifest in `merge_trains` (migration 60).
Its SQL identity, project, repository and state match the JSON record. A unique partial index
allows one `running` train per project/repository. The manifest keeps 2–8 unique members in
fixed order, their source commits/branches, starting members and timestamps, and the optional
priority snapshots, check, candidate commits and parent train. It starts `running` at
`merging`, landed `nowhere`; later `landed` may also be `remote` or `local`. The nullable
`task_merges.train_id` maps to internal `MergeRecord.trainId`; older rows stay null and neither
`TaskMergeState` nor `TaskMerged` exposes it. Train and member writes share the existing
`unitOfWork` transaction, so a failed reservation rolls them all back.

`services/merges/train-selection.ts` exports the pure `selectMergeTrain`: the caller supplies
queued candidates in the existing `QUEUE_ORDER`, with readiness and solo facts already evaluated.
It takes only the compatible prefix, at most eight, comparing project/repository/base/engine and
the review command, worker count and timeout. An ineligible head selects nothing; a solo head
or one without a review test selects only itself. An incompatible, ineligible or solo follower
ends the prefix. Diagnostic candidates never mix with normal candidates or another parent;
every selected diagnostic member's integer 1–8 limit bounds the group. A singleton uses the
individual merge path. Selection neither sorts nor rewrites timestamps and reads no DB or engine.
**Common train execution (PM-660).** `services/merges/train.ts` reserves the compatible
queued prefix under card locks sorted by task key, rechecking sources, gates, merger rights,
PR metadata, engine and the full review configuration. One transaction saves the manifest
and moves every member to running. The existing Effect repository slot owns the train;
the document writer retains its priority when that slot next frees. There is no collection
delay and no card lock during heavy-queue waiting or testing. Cancelling any member interrupts
the common worker and waits for checkout cleanup before the slot can be reused. Survivors
return to queued with their original priority snapshots; the invalid manifest is retired.

The engine builds an ordered source chain, then closes it with another `build` whose first
parent is the original main. The unchanged first-parent merge-test diff therefore covers
every source. One `_merge/<trainId>` checkout uses dependencies matching the merged lockfile;
one full-test run with `requireHeavyLock: true` checks the candidate, without individual
green-result reuse. Candidate and all member merge commits are saved before testing. Every
member switches to checking on the common onStarted callback and receives the same result
and run id. The final locked checkpoint rechecks every source and authorization before one
non-force push and local compare-and-swap advance. Publication is cooperative and cannot be
cancelled once started. One transaction records every merged row and each starter's own
task_merged event, followed by each card's ordinary afterMerge/AutoAdvance.

A failed group check retires the manifest as failed and atomically requeues its members
with internal `task_merges.diagnostic_json` (PM-661): the failed parent's id and an integer
`maxCards = ceil(member count / 2)`. A conflict while building the ordered source chain uses
the same atomic requeue with `maxCards = 1` (PM-778), so every member automatically retries
individually on current main. A source that still conflicts uses the individual `conflict`
failure path; the full check and review gates remain required. Original creation times and
manifest priority snapshots are restored; candidate, check, failure, block and active
membership are cleared. Only adjacent diagnostic members of the same parent can group,
bounded by every member's limit.
**Blaming a member by a lone run (PM-844).** When the repository's `reviewTest.filesCommand` is set,
the group check failed with named files (`failedFiles`) and the train has at least two members, the
train does not halve first: for each member in turn it builds `onto + member`, checks that out
(`checkoutForCheck`, released after the run) and runs `filesCommand` with the group's failed files,
each shell-quoted (`mergeTestFilesCommand`, shared), with the train's workers, timeout and heavy lock.
A member is blamed only if its run failed **and** its failed files intersect the group's: any other
non-zero exit (a usage error, a failed install, no file named) leaves it unknown. Each blamed member
takes the individual `check_failed` path (`MergeSteps.fail`: `base` = the train's `onto`, the lone run's
id and command, the intersecting files, its output tail, the `task_merge_failed` event and
notification). The others (green or unknown) are requeued with no `diagnostic`, so they keep their
queue place and may join any train, each with a timeline note. If no member is blamed (an interaction,
or every lone run was unknown or red elsewhere), the train halves as before. Members keep the step
`checking`; a restart during the lone runs finds the stored red group check and halves. All of it runs
through the engine link's `build`, `checkoutForCheck`, `releaseCheck` and the full test executor, so
nothing machine-dependent is new.
Each smaller attempt gets a fresh candidate and check on current main; successful prefixes
therefore participate in the next half's check. Singletons use the individual path and only
their failed check identifies a blocking card. Success clears diagnostic state; operational
blocks and explicit retries preserve it. Shared `openPrerequisites` checks at reservation and
before publication leave dependent cards queued while unrelated runnable cards proceed.
The slot and heavy lock are released between attempts, giving the document writer and queue
prioritization their ordinary turn. A persisted red check resumes its atomic split after
restart; already published candidates still recover publication first. Operational failures
block with the original reason. Non-fast-forward rebuilds and rechecks once, then blocks.
Startup handles train manifests before individual rows: candidate ancestry detects a push
or local advance completed before the DB transaction, and finishes without repeating the
check, push or events. Unpublished candidates rebuild and recheck conservatively. The train
worker is the sole owner of shared checkout release, including startup recovery.
Blocked publication attempts are checked for candidate ancestry before their leader is
queued for recovery. An unpublished blocked manifest never reopens cancelled requests or
changes members that were retried individually; those requests keep their current state.
The manifest and selection run on the server with remote engines too, grouped by `engineId`;
they add no machine-dependent operation or RPC. Execution belongs to the existing
"Member initiated merge" inventory entry when enabled.

Cancellation is allowed before push; a successful remote push is recorded as `landed: remote` so a
retry only advances locally and finishes. Running rows resume from prepare on startup. Every attempt
releases its check worktree in finally; startup also releases the known queued and blocked worktrees.
Release errors only log a warning. The `_merge` directory is separate from card worktrees and is never
swept as a closed card; a failed release of a terminal row can leave a checkout for engine-side cleanup.

**Does this work on a remote engine?** Yes: the server owns the durable queue, gates and inbox;
all git operations, check checkouts, dependency copies and sandbox checks run on the card's engine
through the existing `merge.*` and `full_test.*` contracts. PR metadata uses the existing application
GitHub service (the default engine's `github.*` calls in cloud mode); it is independent of local git.
Source-head reads are strict for merging: an unavailable engine or failed read cannot pass the gate
as a code-free card. See the machine inventory entry below.

Check dependencies match the merged `package-lock.json` (PM-580). The engine tries the preferred
source, its repository checkout, then that repository's non-prunable worktrees under `worktreesRoot`
outside `_merge`, using canonical paths and excluding overlapping checkouts. The first byte-identical
lockfile with an installation at least as recent as that lockfile supplies `node_modules`; the source
is checked again after copying. Without a matching installed source the merge asks for the preparation
(PM-681, PM-711, PM-897): standalone merges, train checks and lone-member diagnoses call
`checkoutForCheck` with `allowDependencyInstall: true` through `services/merges/check-preparation.ts`, and the
engine then answers `dependencyInstallRequired: true` with a check checkout that has no `node_modules`
(old packages are never copied in their place). The shared preparation adds
`npmCi: { ref, mergeId }` to the check's `FullTestSpec` only for that answer, always with
`requireHeavyLock: true`; the executor then restores the exact merged lockfile's installation from its
store or installs it in its sandbox, under the same machine reservation as the test (see "Server full
test before review"). A missing or false answer sends no `npmCi`, and a switch that is false or absent
keeps the older `git_failed` / `check_error` with installation instructions. A merged tree without a
regular root lockfile keeps the preferred-source copy behavior, and a symlinked lockfile never starts an
installation. Preparation errors (`dependency_install_failed`, `timeout`, `killed`, an unusable queue)
are `error` results: the merge blocks with `check_error` (no developer fix round, no owner question, no
test, no push) and the check checkout is released after the executor has ended; only a test that runs
and fails is `check_failed`. On a remote engine this holds for an RPC timeout too: the cloud sends
`full_test.cancel`, and the engine answers it only when the run has ended and cleaned up (the
installation stopped, the lock freed), so the checkout is removed after that; an engine that stays
unreachable is `engine_offline`.

`BranchMerger.readFile` and `BranchMerger.commitFiles` are for project document writing
(PM-388, PM-494, PM-1044): the card merge never calls them. `RepoConfig.docs` (`project-docs.ts`) says where
the decision log, roadmap and lessons are (PM-1004); absent, the feature is off, and `projectDocsOf` takes the first
repository that has a path. `PATCH /config` sets it with `repoDocs` (`docs: null` clears it).

**The slot is shared with project document writes (PM-495, PM-1044).** `DocWrites` (`services/project-docs/doc-writes.ts`)
writes a row of `doc_writes` and runs it in the same repository slot as a merge: `Merges.pump` skips a
repository while `DocWrites.busy` says a write runs there, and a merge fiber's observer calls `docWrites.pump()`
before its own `pump()`, so a waiting write goes first when the slot frees (`DocWrites.pump` skips a repository
for which `Merges.busy`, and calls `merges.pump()` when it ends). `Merges.registerSlotPeer` ties the two (the peer
is the `MergeSlotPeer` port: `busy` and `pump`; the writes use `DocWriteSlotPeer`: `busy`, `holder` and `pump`). Neither module imports the other; domain assembly connects them. At most one write is open (`queued` or `running`) per project (unique index
`doc_writes_open`). Its git work is the engine's (`prepare`, `readFile`, `commitFiles`, `checkoutConflicts`,
`push`, `advance`), run in the order of the card's merge: a `non_fast_forward` push is built again once, on the
new head. The built commit is saved (`commit_sha`) before the push; a `running` row from before a restart is
`published` when the remote already has that commit (the local branch is advanced), otherwise `queued` again.
A write made through the bearer MCP (PM-784, `requestExternal`) has no Operator request or step: its row carries
the key's origin (`external_origin`), its commit has the key's trailers, and it answers after about five seconds
(`EXTERNAL_DOC_WRITE_WAIT_MS`) with `published`, `queued` or `running`; `get_project_doc_write` reads it on. A row
without a request and without an origin never runs (`authorization_revoked`), except one explicitly marked
`autonomous_lessons` by `requestLessons` (PM-1004). That write has no owner request or step. The hub verifies
the selected project manager or transitional Operator, repository/default branch and current lessons path at start, recovery and before publication;
conflicting provenance or revoked configuration ends it as `authorization_revoked`. Its result still reaches
the author through the existing system-message path.
