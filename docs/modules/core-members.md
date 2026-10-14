# core/members

## Responsibility

Member access and configuration, invitations, presence, naming and temporary member retirement.

## Facade

`MemberService`, `MemberProfiles`, `InvitationService`, `PresenceService` and access/naming helpers currently live in `domain/`. The planned entry point is `core/members/index.ts`; this card leaves those implementations and exports in place.

## Ports

Services receive the domain context, projects, timeline and related core services. Invitations inject `prepareUser` from authentication. Member profiles currently read sessions and admission; those existing exceptions remain for its module slice to remove.

## Current and planned files

Current paths under `apps/server/src`: `domain/members.ts`, `domain/access.ts`, `domain/invitations.ts`, `domain/presence.ts`, `domain/naming.ts`.
The planned folder is `apps/server/src/core/members/`.
The authoritative descriptor is
[`core-members.ts`](../../apps/server/test/architecture/modules/core-members.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update only their own descriptor and this document. They do not edit the central map,
architecture table or other modules' importers.

## Remote engine

Member configuration, accounts, invitation rows and presence remain on the server. Session and retirement work use the existing runtime/engine paths. No credential or process operation is added and no engine payload changes.

PM-631 only prepares file ownership for parallel refactor slices. It changes no
shared contract, database schema, configuration or timeline event.
