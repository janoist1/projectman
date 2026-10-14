# core/tasks

## Responsibility

Task lifecycle, labels, moves, relations, themes, board ordering, focus, involvement and card measurements.

## Facade

`TaskService` and its task helpers, `BoardService`, `ProjectFocusService`, `InvolvementService` and `CardMeasure` currently live under `domain/`. The planned entry point is `core/tasks/index.ts`; exact future exports and runtime boundary changes belong to the subsequent slice plans.

## Ports

`TaskService` receives the domain context, timeline, projects and inbox. Existing contracts include `StartWaitingReader` and `SourceHeadReader`; callbacks provide hand-on notifications, outage/fix-limit state and handoffs. This card preserves the remaining runtime dependencies and their dependency exceptions.

## Current and planned files

Current paths under `apps/server/src`: `domain/tasks/`, `domain/board.ts`, `domain/project-focus.ts`, `domain/involvements.ts`, `domain/card-measure.ts`.
The planned folder is `apps/server/src/core/tasks/`.
The authoritative descriptor is
[`core-tasks.ts`](../../apps/server/test/architecture/modules/core-tasks.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update only their own descriptor and this document. They do not edit the central map,
architecture table or other modules' importers.

## Remote engine

Task rows and lifecycle rules remain on the server. Branch head and workspace state come from the existing engine/runtime ports, on the engine holding the checkout. No engine contract, RPC method or payload changes here.

PM-631 only prepares file ownership for parallel refactor slices. It changes no
shared contract, database schema, configuration or timeline event.
