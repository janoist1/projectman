# core/members

## Responsibility

Member access and configuration, invitations, presence, naming and temporary member retirement.

## Facade

`MemberService`, `MemberProfiles`, `InvitationService`, `PresenceService` and access/naming helpers currently live in `domain/`. The planned entry point is `core/members/index.ts`; this card leaves those implementations and exports in place.

## Ports

Services receive the domain context, projects, timeline and related core services.

`core/members/ports.ts` defines the consumer-owned interfaces (PM-633):

- `InvitationAccounts.prepareUser` prepares a `UserRecord` before the configuration commit. `InvitationUser` exposes only its `id`, `name` and `email` in the invitation service's caller and return types.
- `MemberProfileSessions.list` reads sessions for a project, optionally filtered by member or task.
- `MemberCapacity.holders` reads a member's capacity holders, optionally excluding a task.

Assembly passes the existing authentication, session orchestrator and admission instances directly. This module has no auth or runtime imports; its three dependency exceptions are removed. Invitation acceptance keeps one lock and the existing password preparation → configuration commit → account/invitation unit-of-work order. Profile visibility filtering stays in the core.

## Current and planned files

Current paths under `apps/server/src`: `core/members/ports.ts`, `domain/members.ts`, `domain/access.ts`, `domain/invitations.ts`, `domain/presence.ts`, `domain/naming.ts`.
The planned folder is `apps/server/src/core/members/`.
The authoritative descriptor is
[`core-members.ts`](../../apps/server/test/architecture/modules/core-members.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update their own descriptor and this document, removing their dependency exceptions
from the central map without changing the architecture table.

## Remote engine

Member configuration, accounts, invitation rows and presence remain on the server. Session and retirement work use the existing runtime/engine paths. No credential or process operation is added and no engine payload changes.

The invitation, session and capacity ports add no machine-dependent operation. The configuration storage inventory and server/engine boundary remain unchanged (PM-633).

PM-631 only prepares file ownership for parallel refactor slices. It changes no
shared contract, database schema, configuration or timeline event.
