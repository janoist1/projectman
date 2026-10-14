# core/projects

## Responsibility

Project configuration, templates, role management, stage reviewers and visibility filtering.

## Facade

`ProjectService`, `RoleService` and the visibility/stage-reviewer helpers currently live in `domain/` files. The planned entry point is `core/projects/index.ts`; current exports and behavior remain unchanged here.

## Ports

`ProjectService` receives the domain context, `ConfigStore`, `TemplateRegistry`, timeline service and an `isDirectory(projectKey, path)` callback. The callback validates a directory on the project's engine; it must not become a local server filesystem assumption.

`core/projects/ports.ts` defines the consumer-owned `StageReviewerSessions` interface (`list`, `isRunning`, `stop`) used by `stopStageReviewers`. Assembly passes the existing session orchestrator. Live session states come directly from shared contracts; this module has no runtime imports (PM-632).

## Current and planned files

Current paths under `apps/server/src`: `core/projects/ports.ts`, `domain/projects.ts`, `domain/roles.ts`, `domain/stage-reviewers.ts`, `domain/visibility.ts`.
The planned folder is `apps/server/src/core/projects/`.
The authoritative descriptor is
[`core-projects.ts`](../../apps/server/test/architecture/modules/core-projects.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update their own descriptor and this document, removing their dependency exceptions
from the central map without changing the architecture table.

## Remote engine

Configuration and access rules stay on the server. Directory validation executes on the project's engine through the existing injected callback. Existing inventory entries for project paths and configuration continue to apply; no new payload is introduced.

Reviewer stopping uses the existing runtime to stop sessions on the appropriate engine; the session machine inventory boundary is unchanged (PM-632).

PM-631 only prepares file ownership for parallel refactor slices. It changes no
shared contract, database schema, configuration or timeline event.
