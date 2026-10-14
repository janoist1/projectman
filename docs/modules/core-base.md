# core/base

## Responsibility

Domain context, synchronous units of work, domain events and the websocket event bus.

## Facade

`createDomainContext`, `DomainContext`, `isoNow`, the template registry helpers, `createDomainEvents`, `DomainEvents` and `createEventBus` currently live in separate `domain/` files. The planned entry point is `core/base/index.ts`; this preparation does not introduce it.

## Ports

`Repositories`, `EventBus`, a logger and a clock are injected into the context. Domain event listeners connect modules without adding service-to-service dependencies. Units of work publish buffered server events only after the database transaction commits.

`SessionStartCause` comes directly from `@projectman/shared`; this module has no runtime imports (PM-632).

## Current and planned files

Current paths under `apps/server/src`: `domain/context.ts`, `domain/events.ts`, `domain/event-bus.ts`.
The planned folder is `apps/server/src/core/base/`.
The authoritative descriptor is
[`core-base.ts`](../../apps/server/test/architecture/modules/core-base.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update their own descriptor and this document, removing their dependency exceptions
from the central map without changing the architecture table.

## Remote engine

The database, units of work and event bus remain on the server. No filesystem or process operation is introduced; engines receive the existing messages and RPC payloads.

PM-631 only prepares file ownership for parallel refactor slices. It changes no
shared contract, database schema, configuration or timeline event.
