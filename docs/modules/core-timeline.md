# core/timeline

## Responsibility

Append-only task and project timeline recording and access.

## Facade

The sealed entry point is `core/timeline/index.ts`. It exports `TimelineService`, `createTimelineService` and the `AppendTimelineInput` type; the implementation is `core/timeline/timeline.ts`. Stored event types and rendering compatibility remain unchanged.

## Ports

The service receives `DomainContext` and uses its repositories, clock and event bus. Shared timeline schemas remain in `@projectman/shared`. Other modules record events through this service.

## Files

Final paths under `apps/server/src/core/timeline/`: `index.ts` (facade) and `timeline.ts` (implementation).
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
