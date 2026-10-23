# core/tasks

## Responsibility

Task lifecycle, labels, moves, relations, themes, board ordering, focus, involvement, card measurements and linked pull-request snapshots and authorship.

## Facade

`core/tasks/index.ts` is the sealed entry point. It exports `TaskService`, `createTaskService`, `prerequisiteCards`, `startContext`, `PrerequisiteClosures`, `TaskWaits`, `approvalRequestedError`, `gateBlockedError`, `BoardService`, `ProjectFocusService`, `InvolvementService` and `CardMeasure`. Public types are `HandoffTrigger`, `TaskUpdate`, `MergeGate`, `MoveResult`, `StageChange`, `BoardPlanUsage` and `BoardPauses`. The factory dependency shape and all public signatures are unchanged from PM-636.

## Targeted scheduling reads (PM-770)

`TaskService` implements the contract `TaskSchedulingReader` (`contracts/task-scheduling.ts`): `readSchedulingTasks(projectKey, query)` returns stored rows with only their own links (unique key, ascending number, no board view, no derived fields) for the query kinds `keys`, `focus`, `pull`, `children`, `open` and `closed-worktrees`, delegating to `TaskRepository.readScheduling`. `scheduling-context.ts` exports `prerequisiteCards` and `startContext`, which add the open subtasks and prerequisite targets the shared start rules look at. `ProjectFocusService.covered` returns the focus places together with the cards they cover. The shared pure rules are not copied into SQL; the queries only narrow the rows they run over.

## Ports

`TaskService` receives the domain context, timeline, projects and inbox. Existing contracts include `StartWaitingReader` and `SourceHeadReader`; callbacks provide hand-on notifications, outage/fix-limit state and handoffs. `core/tasks/ports.ts` defines the consumer-owned `BoardPlanUsage` / `BoardPauses` for `BoardService`. Assembly supplies the existing runtime objects without casts. Live session states come directly from shared contracts. `TaskService` owns one internal `PullRequestRecords` instance; GitHub synchronization calls the existing task methods to record snapshots and apply link updates. No runtime or GitHub service import remains in this module (PM-632).

## Files

All implementations live directly under `apps/server/src/core/tasks/`: `service.ts`, `store.ts`, `moves.ts`, `labels.ts`, `relations.ts`, `themes.ts`, `developer-level.ts`, `board-order.ts`, `group-move.ts`, `prerequisites.ts`, `task-wait.ts`, `pull-request-records.ts`, `board.ts`, `project-focus.ts`, `involvements.ts`, `card-measure.ts` and `scheduling-context.ts`. `index.ts` provides the facade, `ports.ts` retains the consumer-owned ports, and `tests/merges.test.ts` retains the merge-gate tests. Internal dependencies use direct relative imports; no legacy domain shim remains. AutoAdvance and LeftParts belong to `runtime/watchers`. LeftParts moved there in PM-959; its session pause reader is local to the watcher.
The authoritative descriptor is
[`core-tasks.ts`](../../apps/server/test/architecture/modules/core-tasks.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its only path is `core/tasks/`; the module remains sealed with the same id, layer, target and pass. PM-639 changes only this descriptor and module document, leaving the central map and architecture table to the closing slice.

## Remote engine

Task rows, pull-request snapshots and lifecycle rules remain on the server. Board plan usage reads the existing server-side cache. Branch head and workspace state come from the existing engine/runtime ports, on the engine holding the checkout. The session and plan-usage machine inventory boundaries remain unchanged. No engine contract, RPC method or payload changes here.

PM-639 relocates implementations without changing behavior, shared contracts, database schemas, configuration or timeline events.
