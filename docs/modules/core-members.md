# core/members

## Responsibility

Member access and configuration, invitations, presence, naming and temporary member retirement.

## Facade

`apps/server/src/core/members/index.ts` is the sealed entry point. It exposes the existing services and helpers through named exports:

- `MemberService`, `createMemberService` and `MemberProfiles`.
- `InvitationService` and `PresenceService`.
- `requireMemberAccess`, `requireHuman`, `requireAiMember`, `findHumanByEmail` and `projectAccessFor`; types `ProjectAccess` and `AccessRefusal`.
- `defaultMemberHandle` and `defaultMemberName`.
- Port types `InvitationUser`, `InvitationAccounts`, `MemberProfileSessions` and `MemberCapacity`.

Implementations use direct imports inside the module and the other core modules' facades. The public names, signatures, constructors, factory and dependency keys are unchanged (PM-636, PM-640).

## Ports

Services receive the domain context and related core services through their existing dependency objects.

`core/members/ports.ts` defines the consumer-owned interfaces (PM-633):

- `InvitationAccounts.prepareUser` prepares a `UserRecord` before the configuration commit. `InvitationUser` exposes only its `id`, `name` and `email` in the invitation service's caller and return types.
- `MemberProfileSessions.list` reads sessions for a project, optionally filtered by member or task.
- `MemberCapacity.holders` reads a member's capacity holders, optionally excluding a task.

Assembly passes the existing authentication, session orchestrator and admission instances directly. This module has no auth or runtime imports; its three dependency exceptions are removed. Invitation acceptance keeps one lock and the existing password preparation → configuration commit → account/invitation unit-of-work order. Profile visibility filtering stays in the core.

The internal `InvitationRecord` type is derived from `DomainContext['repos']['invitations']['insert']` through the existing `core/base` facade. It uses the repository's parameter type without a direct import from the database implementation or a new public export.

## Files

All implementations live under `apps/server/src/core/members/` (PM-640):

- `index.ts`: the named public facade.
- `members.ts`: member configuration, roster, profiles and temporary retirement.
- `access.ts`: membership and access checks.
- `invitations.ts`: invitation creation, inspection, revocation and acceptance.
- `presence.ts`: online presence from websocket connections.
- `naming.ts`: member naming helpers from `@projectman/templates`.
- `ports.ts`: consumer-owned account, session and capacity interfaces.

No forwarding files remain at the former `domain/` implementation paths. Existing member, invitation, visibility and authentication tests consume the facade; this module has no relocated internal `tests/` files.

The authoritative descriptor is
[`core-members.ts`](../../apps/server/test/architecture/modules/core-members.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its only path is `core/members/`, with `sealed: true`; id, layer, target and pass are unchanged. The preparation chain already removed this module's dependency exceptions.

## Remote engine

Member configuration, accounts, invitation rows and presence remain on the server. Session and retirement work use the existing runtime/engine paths. No credential or process operation is added and no engine payload changes.

The invitation, session and capacity ports add no machine-dependent operation. The configuration storage inventory and server/engine boundary remain unchanged (PM-633).

PM-640 changes implementation locations and import paths only. Shared contracts, database schema, configuration, timeline events, access checks and invitation persistence order are unchanged.
