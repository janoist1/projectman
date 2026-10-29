# services/releases

## Responsibility

The release of projectman's own instance on the server: the candidate, the owner's approval and the hybrid release
attempt. The deploying watcher and the release coordinator are machine-dependent parts
([MACHINE-DEPENDENT.md](../MACHINE-DEPENDENT.md)).

## Release of the instance (PM-491, part of PM-387)

The release flow of projectman's own instance, on the server; the watcher that deploys (PM-493) and the
screens (PM-492) come in their own cards.

- **Target.** `PROJECTMAN_RELEASE_TARGET=<project key>/<repository>` (read in `index.ts`, `parseReleaseTarget`;
  `DomainOptions.releaseTarget`) names the project and repository that are the instance itself. Without it
  every release operation is refused (`release_not_configured`). `appVersion` (`resolveAppVersion`) is the
  commit the server runs; the control socket tells it in every answer, so the watcher knows a restart happened.
- **Record.** `releases` (migration 51, `db/releases.ts`, contract `packages/shared/src/domain/release.ts`):
  `proposed` → `approved` → `deploying` → `live` → `published`, or `rejected` / `failed`. A partial unique
  index (`releases_open`) allows one release in `proposed`, `approved` or `deploying` for a project. A release has
  a theme card (kind `theme`); its timeline holds `release_changed` for every change, and `ReleaseService`
  (`services/releases/releases.ts`) is the only writer.
- **Contents.** Only a commit a recorded merge of a card left on the default branch can be released
  (`task_merges`, state `merged`; `release_commit_unknown` otherwise). The cards are those whose merge commit is
  an ancestor of the release commit and not of the base: the last release that went live, else the running
  version when that is a commit id. The ancestry questions go to the engine that holds the repository
  (`BranchMerger.isAncestor`, the head through `BranchMerger.prepare`).
- **Proposal.** `propose_release` (MCP) is for the holder of the `deployment` duty. It makes the theme card, the
  record and an inbox item of kind `release` for the holders of the `release_approval` duty (else the owners),
  and `preview: true` records nothing. The Devops session ends after the call.
- **Approval.** Only a person decides, in the Rád vár: AI members (`ai_approval_forbidden`) and integrator keys
  (`owner_approval_required`) cannot, and the owner bypass does not apply to a `release` item, so only its
  assignees can. A rejection ends the release card and may carry a reason (`note` of `release_changed`); a
  second decision is `inbox_item_closed`. The release card is a theme that the domain closes without a person
  (`TaskService.closeThemeBySystem`, architect's decision): on reject, on failure and on publishing alike it
  ends `cancelled`, because a theme is never `done` (reopening goes from `cancelled` only); the outcome is the
  release record and its `release_changed` events.
- **Watcher.** `release_next` returns the oldest release that is approved, deploying, or live without a tag.
  `release_claim` (approved → deploying) records `previousCommit`, where a rollback goes. `release_report` takes
  `live` (only while the server runs the release's commit), `failed` (cancels the card, alert `release_failed`
  to the approvers), `published` (tag and URL; the card is closed) or `publish_failed` (alert once). An
  operation out of order is `release_state_conflict`. The watcher's operations act on the target project only
  (PM-749: `release_get`, `release_claim` and `release_report` all check that the release's project and
  repository equal the target exactly, else `release_not_configured`; an unknown id is the usual not-found).
  `release_get` returns terminal states too, so a lost claim or report answer can be reconciled. On the cloud
  machine the target comes from the optional `releaseTarget` of the cloud configuration (`cloud.env`).
- **Hybrid release (PM-752, server side; the coordinator and the screens are PM-751).** A release goes to two
  targets: the cloud server and one remote engine. `PROJECTMAN_RELEASE_ENGINE_ID` (`eng_…`, never `local`) and
  `PROJECTMAN_RELEASE_TARGET_HASH` (SHA-256 of the credential-free target description, computed by the
  coordinator) are read together in `index.ts` (a lone value stops the start) and written into `cloud.env` by the
  optional `hybrid` of the cloud configuration (`scripts/cloud/machine.ts`, `withHybridTarget`). On such an
  instance the legacy single-target `release_claim` / `release_report` are refused
  (`release_protocol_unavailable`): a release is claimed by `release_deploy_begin` only.
  - **Attempt.** `release_deployments` (migration 75, `db/release-deployments.ts`, contract `HybridDeployment` in
    `packages/shared`) holds one document per release; its `phase`, `maintenance` and `revision` are repeated in
    their own columns, and a unique partial index keeps one active deployment on the instance. `begin` claims the
    approved release and stores the attempt with the previous image, the engine's version and the schema the
    server observed itself; every change is a compare-and-swap on `revision` and is deduplicated by its request
    id (`release_deployment_requests`: the same id with the same payload answers the stored view, another payload
    is `release_deployment_conflict`).
  - **Phases.** `preparing` → `prepared` (the artifact of the release commit is bound once;
    `release_artifact_changed`) → `quiescing` (an owned instance pause and the maintenance bit, saved with the
    pause row in one transaction) → `switching` (only when the drain check says ready, else `release_not_drained`)
    → `live` → `published`. A failure before the pause (`preparing`, `prepared`) ends the attempt as `failed`
    with no fence. From the pause on, a failure with a verified rollback is `failed` (the fence stays until the
    owned `resume`); one without it, and the coordinator's `recovery` change (from `quiescing`, `switching` or a
    still fenced `live`), is `recovery_required`: the fence stays, the release stays `deploying` (or `live`), the
    approvers get the `release_failed` alert once, and no `live`, `failed` or `resume` report of the coordinator
    moves it again (`release_recovery_required`). The release's own change and the deployment write commit in one
    transaction, and a new proposal is refused while a deployment holds the instance.
  - **Fence.** `ReleaseWorkGate` (`services/releases/work-gate.ts`) is the only admission: the merge queue, the
    document-write queue, the full-test queue and the screenshot runs ask it for a permit before they start a
    root piece of work, and are refused while the maintenance bit is set. The bit is read live from the
    database, so it holds from the first query after a restart; a continuation of work that began earlier (a
    child permit) is let through and counted. Sessions are held by the owned pause. The drain check counts the
    permits, the running rows without a permit (uncertain: an earlier process's run) and the unstopped sessions.
  - **Result gates.** `live`, a rollback (`failed` with `rolledBack`) and `resume` are accepted only when both
    recorded targets show the expected program: the cloud's `appVersion` and the engine registry's online state
    and version, plus the reported image (`release_target_mismatch`, `release_engine_mismatch`, `engine_offline`).
  - **Bootstrap.** The first hybrid release cannot be driven by a build that lacks this protocol.

Does this work on a remote engine? The records, the approval and the socket are the server's. Only
`BranchMerger.isAncestor` / `prepare` cross the server/engine boundary, as they do for the merge (PM-452); the
instance's repository is on the engine the project uses (`LOCAL_ENGINE_ID` for now). Deploying, restarting and
publishing are the watcher's (PM-493) and act on the machine the server runs on; the control socket stays local.
For the hybrid release (PM-752) the cloud server owns the attempt, the fence and the checks, and learns the
engine's program only from its registry (id, online, version), which is the engine's own report. Switching the
engine's program and moving the artifact are the coordinator's (PM-751) and cross the boundary through the
protected admin channel; nothing in the server's part assumes that the engine shares its host.
