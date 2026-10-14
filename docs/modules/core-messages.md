# core/messages

## Responsibility

Stored team messages, routing, recipient/card-role rules, stale-message checks and relation notices.

## Facade

`domain/messaging/index.ts` currently exports `MessageService`, `Messaging`, `RelationNotices` and staleness helpers, and still re-exports `MessageDelivery` from runtime. The planned entry point is `core/messages/index.ts`; removing that runtime re-export belongs to the messages slice.

## Ports

`Messaging` receives the domain context, core services, sessions, delivery and refinement. Existing `MessageWaker`, `MessageSignals` and `CardHold` interfaces connect starts, Operator signal recording and card holds. Message attachment validation/binding and optional engine availability are injected. Existing runtime/service dependency exceptions remain unchanged.

## Current and planned files

Current paths under `apps/server/src`: `domain/messaging/`.
The planned folder is `apps/server/src/core/messages/`.
The authoritative descriptor is
[`core-messages.ts`](../../apps/server/test/architecture/modules/core-messages.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update only their own descriptor and this document. They do not edit the central map,
architecture table or other modules' importers.

## Remote engine

Message records and routing rules stay on the server. Runtime delivery and engine availability use the existing transport to the recipient's engine. Session-folder message files remain covered by the machine-dependent inventory; no new delivery payload is introduced.

PM-631 only prepares file ownership for parallel refactor slices. It changes no
shared contract, database schema, configuration or timeline event.
