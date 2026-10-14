# core/tasks

## Responsibility

Task lifecycle, labels, moves, relations, themes, board ordering, focus, involvement, card measurements and linked pull-request snapshots and authorship.

## Facade

`TaskService` and its task helpers, `BoardService`, `ProjectFocusService`, `InvolvementService` and `CardMeasure` currently live under `domain/`. The planned entry point is `core/tasks/index.ts`; exact future exports and runtime boundary changes belong to the subsequent slice plans.

## Ports

`TaskService` receives the domain context, timeline, projects and inbox. Existing contracts include `StartWaitingReader` and `SourceHeadReader`; callbacks provide hand-on notifications, outage/fix-limit state and handoffs. `core/tasks/ports.ts` defines the consumer-owned `TaskPauseReader` for `LeftParts` and `BoardPlanUsage` / `BoardPauses` for `BoardService`. Assembly supplies the existing runtime objects without casts. Live session states come directly from shared contracts. `TaskService` owns one internal `PullRequestRecords` instance; GitHub synchronization calls the existing task methods to record snapshots and apply link updates. No runtime or GitHub service import remains in this module (PM-632).

## Current and planned files

Current paths under `apps/server/src`: `core/tasks/ports.ts`, `domain/tasks/` (including `pull-request-records.ts`), `domain/board.ts`, `domain/project-focus.ts`, `domain/involvements.ts`, `domain/card-measure.ts`.
The planned folder is `apps/server/src/core/tasks/`.
The authoritative descriptor is
[`core-tasks.ts`](../../apps/server/test/architecture/modules/core-tasks.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update their own descriptor and this document, removing their dependency exceptions
from the central map without changing the architecture table.

## Remote engine

Task rows, pull-request snapshots and lifecycle rules remain on the server. Board plan usage reads the existing server-side cache. Branch head and workspace state come from the existing engine/runtime ports, on the engine holding the checkout. The session and plan-usage machine inventory boundaries remain unchanged. No engine contract, RPC method or payload changes here.

PM-631 only prepares file ownership for parallel refactor slices. It changes no
shared contract, database schema, configuration or timeline event.
