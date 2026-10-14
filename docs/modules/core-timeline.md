# core/timeline

## Responsibility

Append-only task and project timeline recording and access.

## Facade

`TimelineService` currently lives in `domain/timeline.ts`. The planned entry point is `core/timeline/index.ts`; stored event types and rendering compatibility remain unchanged.

## Ports

The service receives `DomainContext` and uses its repositories, clock and event bus. Shared timeline schemas remain in `@projectman/shared`. Other modules record events through this service.

## Current and planned files

Current paths under `apps/server/src`: `domain/timeline.ts`.
The planned folder is `apps/server/src/core/timeline/`.
The authoritative descriptor is
[`core-timeline.ts`](../../apps/server/test/architecture/modules/core-timeline.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update only their own descriptor and this document. They do not edit the central map,
architecture table or other modules' importers.

## Remote engine

Timeline storage stays in the server database. Engines contribute data through existing contracts; this module introduces no machine-dependent operation or remote payload.

PM-631 only prepares file ownership for parallel refactor slices. It changes no
shared contract, database schema, configuration or timeline event.
