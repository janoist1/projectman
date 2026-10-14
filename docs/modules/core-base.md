# core/base

## Responsibility

Domain context, synchronous units of work, domain events and the websocket event bus.

## Facade

The entry point is `apps/server/src/core/base/index.ts`. It exports `createDomainContext`,
`DomainContext`, `isoNow`, `defaultTemplateRegistry`, `createTemplateRegistry`,
`TemplateRegistry`, `createDomainEvents`, `DomainEventMap`, `DomainEvents`,
`AddedRelation` and `createEventBus`. Other modules consume this facade; implementations
import their own siblings directly.

## Ports

`Repositories` (the `db` facade), `EventBus` (the `contracts` facade), a logger and
a clock are injected into the context. There is no separate `ports.ts`. Domain event
listeners connect modules without adding service-to-service dependencies. Units of
work publish buffered server events only after the database transaction commits.

The `SessionStartCause` event payload type comes directly from `@projectman/shared`,
without a runtime dependency on the sessions module (PM-632). `ConfigChange` and
`StageChange` are type-only imports from the `core/projects` and `core/tasks` facades.

## Files and ownership

Implementation paths under `apps/server/src`: `core/base/context.ts`,
`core/base/events.ts` and `core/base/event-bus.ts`, behind `core/base/index.ts`.
The authoritative descriptor is
[`core-base.ts`](../../apps/server/test/architecture/modules/core-base.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
The module is sealed and owns only `core/base/`; its id, layer, target and pass
remain unchanged. The existing tests remain in `apps/server/test/domain-events.test.ts`,
`apps/server/test/unit-of-work.test.ts` and `apps/server/test/ws.test.ts`, using the facade.

## Remote engine

The database, units of work and event bus remain on the server. No filesystem or process operation is introduced; engines receive the existing messages and RPC payloads.

PM-637 moves the implementations to their final module folder. It changes no
shared contract, database schema, configuration, timeline event or runtime behavior.
