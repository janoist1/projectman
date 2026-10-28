# core/projects

## Responsibility

Project configuration, templates, role management, stage reviewers and visibility filtering.

## Facade

`core/projects/index.ts` is the sealed entry point. It exports `ProjectService`,
`createProjectService`, `OWNER_HANDLE`, `configInvalid`, `RoleService`, `roleUsage`,
`roleViews`, the stage-reviewer and visibility helpers, and their public types.
Implementations live beside the facade; public names, signatures and behavior are unchanged.

## Ports

`ProjectService` receives the domain context, `ConfigStore`, `TemplateRegistry`, timeline service and a `workspaceState(engineId, path)` callback (PM-1077). The callback reports `directory`, `missing` or `not_held` for the path on the project's engine; `missing` refuses the project, `not_held` (a remote engine does not hold the folder yet) does not. It must not become a local server filesystem assumption.

`core/projects/ports.ts` defines the consumer-owned `StageReviewerSessions` interface (`list`, `isRunning`, `stop`) used by `stopStageReviewers`. Assembly passes the existing session orchestrator. Live session states come directly from shared contracts; this module has no runtime imports (PM-632).

## Files

Paths under `apps/server/src/core/projects/`: `index.ts`, `ports.ts`, `projects.ts`,
`roles.ts`, `stage-reviewers.ts` and `visibility.ts`. There are no forwarding files
at the former implementation paths in `domain/`.
The authoritative descriptor is
[`core-projects.ts`](../../apps/server/test/architecture/modules/core-projects.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its only path is `core/projects/`, and it is sealed. Its id, layer, target and pass
remain unchanged (PM-638). Existing tests live under `apps/server/test/` and consume
the facade.

## Remote engine

Configuration and access rules stay on the server. Directory validation executes on the project's engine through the existing injected callback. Existing inventory entries for project paths and configuration continue to apply; no new payload is introduced.

Reviewer stopping uses the existing runtime to stop sessions on the appropriate engine; the session machine inventory boundary is unchanged (PM-632).

PM-638 moves the four implementations behind the facade. It changes no shared
contract, database schema, configuration or timeline event.
