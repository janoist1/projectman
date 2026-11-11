# services/releases

## Responsibility

Release publication and the running version of projectman's own instance (PM-968, PM-969, PM-1113).
Deployment is an owner-requested procedure in [DEPLOY.md](../DEPLOY.md); its machine-dependent parts are in
[MACHINE-DEPENDENT.md](../MACHINE-DEPENDENT.md).

## Release publication and running version (PM-968, PM-969, PM-1113)

The supported procedure is [DEPLOY.md](../DEPLOY.md#by-hand-the-fallback-pm-1113): an owner-requested
`npm run cloud -- deploy --ref <commit>`, the Mac engine rebuilt and reinstalled at the
same commit, then `publish_release` on request after a preview.

The owner's connected Claude drives the release chain on its endpoint ([DEPLOY.md](../DEPLOY.md#the-release-chain-pm-1193),
PM-1193, PM-1238); the devops only prepares it (the preview, the non-production jobs, the status reading). Publishing
is a production step: `preview`/`publish` take the caller's `Actor`, and `publish` runs `assertReleaseAuthority` at the
entrance and again before the tag is pushed (`release_owner_only` for everyone but the owner and the owner's connected
Claude in person; `publishedBy` is that handle). A preview stays open to an AI member with the deployment duty. The
tag is pushed through the project's engine (`engines.projectEngine`). The module serves the chain with two read-only
parts (PM-1201). `ReleasePublishService.unreleased(projectKey)` lists,
per repository with a known base, the cards merged after it (`repo`, `base`, `count`, `oldestAt`, `taskKeys`) from the
recorded merges alone: no git, no write, `[]` on any error. The coordination module's board read turns an entry at
least `OPERATOR_UNRELEASED_HOURS` old into a `release_due` integrator todo (PM-1333; marker `repo@base`), which
closes by itself when `publish_release` moves the base; the unreleased signal and the devops start are retired.
`releaseStatusOf` builds the answer of the `get_release_status` tool (the hub version and each engine's connection,
version and mismatch, from the engine registry view).

`ReleasePublishService` owns GitHub publication and `runningVersion()`, exposed by
`GET /api/version`. Publication uses the repository engine for git and the GitHub engine
for GitHub calls. Version lookup reads `release_publications` and historical `releases`
tags before the build's tag reader. Old data stays readable: the release tables, the `release_changed` events and
the legacy release inbox items; old release environment settings are ignored.

Remote engines work through git/GitHub methods. Deployment runs on the deploying machine; the engine build and
launchd installation run on the engine machine ([MACHINE-DEPENDENT.md](../MACHINE-DEPENDENT.md)).
