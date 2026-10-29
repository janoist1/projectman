# services/releases

## Responsibility

Release publication and the running version of projectman's own instance (PM-968, PM-969, PM-1113).
Deployment is an owner-requested procedure in [DEPLOY.md](../DEPLOY.md); its machine-dependent parts are in
[MACHINE-DEPENDENT.md](../MACHINE-DEPENDENT.md).

## Release publication and running version (PM-968, PM-969, PM-1113)

The supported procedure is [DEPLOY.md](../DEPLOY.md#release-pm-1113): an owner-requested
`npm run cloud -- deploy --ref <commit>`, the Mac engine rebuilt and reinstalled at the
same commit, then `publish_release` on request after a preview. There is no watcher,
proposal/approval chain, control relay or administration supervisor.

`ReleasePublishService` owns GitHub publication and `runningVersion()`, exposed by
`GET /api/version`. Publication uses the repository engine for git and the GitHub engine
for GitHub calls. Version lookup reads `release_publications` and historical `releases`
tags before the build's tag reader. The old release tables and `release_changed` events
remain readable; migration 129 cancels open legacy release inbox items. Project pipeline
release gates and duties are unchanged. Old release environment settings are ignored.

Remote engines work through existing git/GitHub methods. Deployment runs on the
administration Mac; the engine build and launchd installation run on the engine machine.
No new machine operation crosses engine RPC.
