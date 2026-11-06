# core/tasks

## Responsibility

Task lifecycle, labels, moves, relations, themes, board ordering, involvement, card measurements and linked pull-request snapshots and authorship.

## Facade

`core/tasks/index.ts` is the sealed entry point. It exports `TaskService`, `createTaskService`, `prerequisiteCards`, `startContext`, `PrerequisiteClosures`, `TaskWaits`, `approvalRequestedError`, `gateBlockedError`, `BoardService`, `InvolvementService` and `CardMeasure`. Public types are `HandoffTrigger`, `TaskUpdate`, `MergeGate`, `MoveResult`, `StageChange`, `BoardPlanUsage` and `BoardPauses`.

## Targeted scheduling reads

`TaskService` implements the contract `TaskSchedulingReader` (`contracts/task-scheduling.ts`): `readSchedulingTasks(projectKey, query)` returns stored rows with only their own links (unique key, ascending number, no board view, no derived fields) for the query kinds `keys`, `pull`, `queue`, `children`, `open` and `closed-worktrees`, delegating to `TaskRepository.readScheduling`. `scheduling-context.ts` exports `prerequisiteCards` and `startContext`, which add the open subtasks and prerequisite targets the shared start rules look at. The shared pure rules are not copied into SQL; the queries only narrow the rows they run over.

## Ports

`TaskService` receives the domain context, timeline, projects and inbox. Existing contracts include `StartWaitingReader` and `SourceHeadReader`; callbacks provide hand-on notifications, outage/fix-limit state and handoffs. `core/tasks/ports.ts` defines the consumer-owned `BoardPlanUsage` / `BoardPauses` for `BoardService`. Assembly supplies the existing runtime objects without casts. Live session states come directly from shared contracts. `TaskService` owns one internal `PullRequestRecords` instance; GitHub synchronization calls the existing task methods to record snapshots and apply link updates. This module has no runtime or GitHub service import.

## Files

All implementations live directly under `apps/server/src/core/tasks/`: `service.ts`, `store.ts`, `moves.ts`, `labels.ts`, `relations.ts`, `themes.ts`, `developer-level.ts`, `board-order.ts`, `group-move.ts`, `prerequisites.ts`, `task-wait.ts`, `pull-request-records.ts`, `board.ts`, `involvements.ts`, `card-measure.ts` and `scheduling-context.ts`. `index.ts` provides the facade, `ports.ts` retains the consumer-owned ports, and `tests/merges.test.ts` retains the merge-gate tests. Internal dependencies use direct relative imports. AutoAdvance and LeftParts belong to `runtime/watchers`; LeftParts' session pause reader is local to the watcher. LeftParts is a fast path only: when the turn of the member who created the parts of a card ends with parts still in the first stage, it sends that member one reminder and writes a `task_parts_left` `told` event. The owners' `parts_left` alert after the next turn is gone: the `next_step` obligation ladder (`cardDuty`, `ARCHITECTURE.md` "Obligation tracking") follows such a part. The old `parts_left` items and `alerted` events keep rendering, and an open old alert still closes when its parts are in order.
The authoritative descriptor is
[`core-tasks.ts`](../../apps/server/test/architecture/modules/core-tasks.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its only path is `core/tasks/`; the module is sealed.

## Remote engine

Task rows, pull-request snapshots and lifecycle rules stay on the server. Board plan usage reads the server-side
cache. Branch head and workspace state come from the engine/runtime ports, on the engine holding the checkout
(the session and plan-usage entries of [MACHINE-DEPENDENT.md](../MACHINE-DEPENDENT.md)).
