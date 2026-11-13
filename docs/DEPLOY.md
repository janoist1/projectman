# Deployment and operation

The supported installation uses a cloud hub and a Mac engine; see [HYBRID.md](HYBRID.md)
and [AWS.md](AWS.md). This page covers operating the Mac engine, releases and the connected Claude's access.

## Live instance update and full check (PM-1342)

The owner's live instance uses a cloud hub and a Mac engine. The manual update is
`npm run cloud -- deploy --ref <commit>`, followed by rebuilding and reinstalling the
engine at the same commit. Who may update it is defined in the project plan, chapter 4
(Dokumentumok, "Projektterv"): until production use, the owner's connected Claude does;
the team's AI members do not. An update still needs approval for that exact change.
`publish_release` publishes a release through the release chain described below.
`npm run live -- install|status|uninstall` is only for single-mode disaster recovery.

The macOS operator command for a full check outside member sandboxes is:

```sh
npm run full-test -- --workers 4 --timeout 60 -- npm run merge-test -- --all
```

Developers run the targeted checks and `npm run handover-check` from CLAUDE.md instead.
The merger uses `merge_task`; the server runs `npm run merge-test` before moving main,
on the card's engine or GitHub Actions as configured
([services/merges](modules/services-merges.md)). Shared code/configuration changes get
their full suite at merge.

Development data and the dev server are described in the [README](../README.md).

## A database from before the baseline (PM-1381)

The schema baseline replaces migrations 1–152. A database at version 1–151 must
first be opened once with **[v2026.11.12](https://github.com/janoist1/projectman/releases/tag/v2026.11.12)**
(commit `9508a0f45a1e37436ccf707c040d5452f25bb6c2`), or a later release from before the baseline switch. Only then start
the current release. The server refuses an older database before applying any migration
and names the required release in its error.

This includes a Litestream point-in-time restore from before schema 152, the pre-hybrid
Mac database used by `instance activate --discard-cloud-data`, and an old development
home (`~/.projectman-dev`). Keep the original backup and perform the upgrade on its
restored copy. For the cloud, start the pre-baseline release image against that copy
once, then deploy the current image. Build artifacts expire after seven days: if the
old image is unavailable, rebuild at the pre-baseline release commit using
`projectman-job.yml` or `image-build`. For Mac single mode, use that release's packaged
server for the first start.

The development home checked before this switch (`~/.projectman-dev/db.sqlite`, last
used on 2026-10-01) is still at schema 11. This build refuses it: start v2026.11.12
on it once before using the current build, or discard that disposable development
home if its data is no longer needed. Its old schema does not block the hub update.

The engine does not open the database. The regular release order remains hub first,
then engines; before deploying the baseline build the hub must already be at schema
152 or later. The baseline itself makes no schema change to an existing database at
that version; later migrations still apply normally. A rollback
to the preceding image is safe when the new release adds no further migrations.
The release notes for the switch must also name the pre-baseline release above.

## Engine app build (PM-1104, PM-1122)

Build on the release Mac with full Xcode, using the self-contained package produced by
`npm run engine-app -- package`. The checkout supplies the Swift sources and templates;
the package's `engine-package.json` supplies the commit and release tag. `origin` must
identify the public GitHub release repository (HTTPS or SSH).

`package` builds into `<out>/<commit>` and prints that exact path as its last line; pass it
as `--package` to `build`. It fetches the commit from `origin` and refuses a remote that is
not HTTPS (a checkout with an SSH `origin` needs `--repo https://github.com/<owner>/<repo>.git`).
Workspace links of packages the engine does not ship (`apps/web`, the feedback widget) are
removed from the package, so the app signature has no dangling symlink to trip on.

```sh
npm run engine-app -- package --commit <40-character-sha> --out /path/to/packages --repo https://github.com/<owner>/<repo>.git
npm run engine-app -- build --package /path/to/packages/<40-character-sha> --out /path/to/new-output --ad-hoc
npm run engine-app -- build --package /path/to/package --out /path/to/new-output --identity "Developer ID Application: Example (ABCDE12345)" --team-id ABCDE12345 --notary-profile projectman-release
```

The CLI waits for the machine's heavy-run queue. The output directory must be absent or
empty. All scratch files, tool temporary files and caches stay there.
On success it contains `projectman motor.app`, `projectman-motor.zip`,
`projectman-motor.dmg` and `projectman-motor.json`. The DMG contains the app and an
Applications link. Signed builds also keep notary submission results; a rejected
submission saves its log there. A failed build removes the app and distributable assets,
retaining diagnostics. Each notary submission has a 30-minute timeout.

The identity and profile are keychain names; provision the Developer ID certificate,
private key and notary credentials in the release machine's login keychain, with access
for the background release process. No secrets belong in command arguments or the repo.
The ad-hoc build skips hardened runtime, notarization, DMG signing and Gatekeeper assessment
and records an empty Team ID. With `--update-ref refs/heads/<branch>` (only with `--ad-hoc`; the release workflow
passes `${{ github.ref }}`) and a tagged package, the Info.plist also gets `ProjectmanUpdateTrust =
github-attestation` and `ProjectmanUpdateSourceRef = <ref>` (PM-1199): the app then updates itself on the GitHub
build attestation instead of an Apple signature (see "Engine menu bar app"). Developer ID and untagged builds get
neither key. Without hardened runtime,
Node can load ad-hoc native modules that have no Team ID. Signing options cannot be combined
with `--ad-hoc`. Node receives JIT and unsigned executable memory entitlements in both modes;
signed release builds keep hardened runtime and library validation enabled. Verify real Node/native module
execution and Gatekeeper on the owner's first signed release (PM-1123) before distribution.

### On GitHub (PM-1156)

The same two steps can run as the compute job `engine-app` (PM-1144/1147/1148, the general
`projectman-job.yml` workflow) on a GitHub `macos-15` runner, ad-hoc signed until there is a Developer ID. The
Mac then builds nothing: it downloads and verifies the result. The values are in `ENGINE_APP_JOB`
(`scripts/engine-app/job.ts`):

| Input             | Value                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `job`             | `engine-app`                                                                                                                                                                                                                                           |
| `runs_on`         | `macos-15`                                                                                                                                                                                                                                             |
| `node`            | `22`                                                                                                                                                                                                                                                   |
| `timeout_minutes` | `60`                                                                                                                                                                                                                                                   |
| `outputs`         | `app/projectman-motor.json app/projectman-motor.zip`                                                                                                                                                                                                   |
| `command`         | `npm ci && npm run engine-app -- package --commit "$PROJECTMAN_JOB_COMMIT" --out "$RUNNER_TEMP/engine-package" && npm run engine-app -- build --package "$RUNNER_TEMP/engine-package/$PROJECTMAN_JOB_COMMIT" --out "$PROJECTMAN_JOB_OUT/app" --ad-hoc` |

The engine starts a job only when the owner has registered it by hand, with exactly these values: in the
engine's `engine.json`, in the `computeJobs` of the repository entry (`repos[].computeJobs`), and on the hub with a
`repoComputeJobs` patch (`computeJobs` of the repository, which needs a `github` owner/name):

```json
"computeJobs": [
  {
    "id": "engine-app",
    "runsOn": "macos-15",
    "node": "22",
    "timeoutMinutes": 60,
    "outputs": ["app/projectman-motor.json", "app/projectman-motor.zip"],
    "command": "npm ci && npm run engine-app -- package --commit \"$PROJECTMAN_JOB_COMMIT\" --out \"$RUNNER_TEMP/engine-package\" && npm run engine-app -- build --package \"$RUNNER_TEMP/engine-package/$PROJECTMAN_JOB_COMMIT\" --out \"$PROJECTMAN_JOB_OUT/app\" --ad-hoc"
  }
]
```

A registration may also name a **dedicated workflow** with the optional `workflow` field (PM-1196): one of
`projectman-deploy.yml` or `projectman-engine-release.yml`, a fixed list in `DEDICATED_COMPUTE_JOB_WORKFLOWS`. A
dedicated workflow has its own environment and rights (an AWS OIDC role, `contents: write`), which the general
workflow, that runs any command, never gets. Without the field the general `projectman-job.yml` runs, so older
registrations stay valid. The engine starts a dedicated workflow only for a job registered with exactly that
workflow (and every other value as above): a different workflow is `command_not_allowed`, one off the list
`invalid_params`; an older engine refuses a dedicated job with `invalid_params` and the link stays up. The dedicated
workflow takes the same inputs, run title, `projectman-job output ...` lines and `projectman-job-<run_id>` artifact.

```json
{
  "id": "cloud-deploy",
  "workflow": "projectman-deploy.yml",
  "runsOn": "ubuntu-24.04",
  "timeoutMinutes": 30,
  "outputs": ["deploy/report.json"],
  "command": "cloud-deploy"
}
```

Start it for a commit of the default branch (the workflow runs only those) either with the team tool,
`run_compute_job job=engine-app commit=<SHA40>`, or by hand with the `gh workflow run` line that
`engine-app fetch` prints when it finds no run. Then, on the Mac the app goes to:

```sh
npm run engine-app -- fetch --commit <SHA40> --out /path/to/new-directory [--run <number>] [--dry-run] [--open]
```

`fetch` never starts a run. It finds or follows the newest `engine-app` run of the commit (or the given `--run`),
checks where it ran (workflow, event, default branch, result, title) and the attestation of the manifest and the zip
against the workflow's exact identity and this run, then the manifest (commit, sha256 and size of the zip),
unpacks the app with `ditto`, runs `codesign --verify --deep --strict` and compares the `engine-package.json`
inside the app with the commit. Any failure removes the output directory. On success it leaves `projectman motor.app`,
the zip and the manifest, and prints the app's path as its last line. It needs `gh` logged in with read access to the
repository's Actions (gh 2.49 or newer for `gh attestation`), `ditto` and `codesign`; the artifact lives 7 days.
`--dry-run` stops at the run's address. `fetch` downloads only the manifest and the zip, not the disk image: the
install unpacks the zip, and the image is kept for `publish`, which builds on the release machine. The registration
lists exactly the two `outputs` above, in `engine.json` and in the hub's `repoComputeJobs`; one that still lists the
`.dmg` makes the run upload the image and `fetch` download it (it discards it unused).

**Installing is opening the new app, not a bare `service switch --to`.** The menu bar app that is still installed
decides by `SwitchPolicy.candidate` only whether the packaged version and the running one differ; after a manual
`service switch --to` it would switch the idle engine back to its own version by itself. The new app, once
opened (`--open`, or `open "<out>/projectman motor.app"`), copies itself into `/Applications` and stops the old
one; its own release switch (`Installer.switchEngine`) stages the package in `engine/versions/<version>`, runs
`service switch --to`, moves `current` and cleans up. An idle engine switches at once; with work running the menu
offers "Update now…". The `gh` and `ditto` downloads carry no quarantine attribute, so the ad-hoc app starts. The
staging moves `bin/node` to `engine/runtimes/<sha256>/node` and leaves a relative link in its place (PM-1200), so
the same Node runs from the same path in every version: the LuLu firewall asks once and again only when the pinned
Node changes (`scripts/engine-app/node-pin.ts`), not for every engine version. The Team ID is empty, but the
build of GitHub Actions carries the attestation trust keys (PM-1199), so the app updates itself from the next
release on (see "Engine menu bar app"); the app installed by hand once must be one of these releases
(`engine-app fetch --open`), an older ad-hoc app (`CFBundleVersion` `0`) never updates itself.

With a Developer ID, the same job would sign and notarize and attach the files as release assets, and the
self-update would take them from there.

### On GitHub, for a release (PM-1198)

The `engine-app` job above builds a commit that has no tag, so its `bundleVersion` is `0` and the app's updater never
sees it as newer. The dedicated workflow `.github/workflows/projectman-engine-release.yml` (PM-1196) builds the
commit of a release tag instead and puts the result on that tag's GitHub release, so the app, the remote engines and
a manual install all take the same assets. It is registered like any dedicated job, in `engine.json`
(`repos[].computeJobs`) and in the hub's `repoComputeJobs`:

```json
{
  "id": "engine-release",
  "workflow": "projectman-engine-release.yml",
  "runsOn": "macos-15",
  "node": "22",
  "timeoutMinutes": 60,
  "outputs": ["app/projectman-motor.json"],
  "command": "engine-release"
}
```

`publish_release` starts this job by itself (PM-1424) on the release commit, with the same actor, right after the
GitHub release exists, and prints the build state (`started`, `reused`, `failed` or `not_configured`; a failed start
never withdraws the release). It picks the repository's job whose `workflow` is `projectman-engine-release.yml`; a
live run of the same commit is reused (never `force`). Without such a job the state is `not_configured`: register it
(one-time rollout, step 2). By hand it stays for filling a gap (an older release, a failed start): the owner's
connected Claude runs `run_compute_job job=engine-release commit=<SHA40>` (a production step: the hub refuses it to
every member, PM-1238), where the commit is the one the tag points at. The workflow runs one fixed procedure (the `command` is only a marker it
checks) and fails unless: it runs from the default branch; the inputs are exactly the registered ones; the commit is
on the default branch; exactly one tag of the `RELEASE_TAG_PATTERN` form points at it; and that tag has a GitHub
release (otherwise `app_release_missing`). Then it checks the commit out with its full history and tags, so
`engine-app package` finds the tag and the `bundleVersion` is the tag's `YYYYMMDD.N`; builds with `build --ad-hoc`;
attests the zip, the disk image and the manifest with this workflow's identity (`actions/attest-build-provenance`);
and runs `npm run engine-app -- upload --tag <tag> --dir <output>` with the run's `GITHUB_TOKEN` (`contents: write`).
The run's artifact is the manifest (`app/projectman-motor.json`), as for the other compute jobs.

`upload` is the uploading half of `publish`, shared with it (`scripts/engine-app/release-assets.ts`): it refuses a
manifest whose `tag` is not `--tag` or whose `version` is not the tag's commit, and archives that are not the ones
the manifest names (`REFUSED [app_manifest_mismatch]`); an existing asset with the same SHA-256 is skipped; a
different one is `REFUSED [app_asset_conflict]` and is never overwritten; the manifest goes up last. It accepts the
ad-hoc manifest (empty `teamId`); `publish` still requires its Team ID. Rerunning after an interruption is safe.
**A tag whose assets an ad-hoc build took cannot get a Developer ID publication later** (`app_asset_conflict`): once
there is a Developer ID, the signed release gets a new tag. The macOS runner is free for a public repository, and the
disk image (about 388 MB) goes up inside GitHub.

## GitHub attribution

Optionally set `githubLogin: acme-developer` on a human or AI member in
`$PROJECTMAN_HOME/customization/projects/<KEY>/team.yaml`, using the actual account
that opens their PRs. Restart after a manual config edit. GitHub polling matches the
login case-insensitively and persists that member as PR author for the no-self-review
rule. The login is returned in `MemberView`; editing it currently uses config only.

## Sandbox rollout prerequisite (PM-87)

The provider-neutral policy migration does not activate strict sandboxes or change the live
instance. Current policies retain legacy enforcement; strict intent fails startup instead of
falling back. Do not treat the PM-126 probe versions as certified deployment minimums: its
review, provider adapters, hook isolation (PM-49), disposable copies and the final PM-130
matrix must pass before activation. The documented local-port exception is decision 24.
Changing the owner's live instance still requires approval for that exact update.

## Pausing the team for an update (PM-219)

A stop of the service pauses the team first: every session comes to a safe point (the tool that runs is
finished, then the session is held), the server closes, and after the start the sessions go on by themselves.
The pause waits `PROJECTMAN_SHUTDOWN_PAUSE_MS` (default 60 000; 0 stops without pausing, as before) and a few
seconds more. The service manager must allow this pause to finish before terminating child sessions. A crash does not pause, and neither does a second Ctrl-C.

In the hybrid mode the pause is part of the deploy: the hub's container receives SIGTERM from `npm run cloud --
deploy` (the unit allows 75 s to stop) and pauses by itself, and the engine's service stop waits for its own
pause (see "Controlling the engine service"). The image holds no control socket client, so the manual pause below
is for a server that runs on a Mac (the single-mode recovery service, a development server).

To update such a server without losing the sessions' place, pause by hand, and wait for it, before the switch:

```sh
npm run control -- pause --wait --reason "update"   # returns when every session has stopped; exit 0
# ... build, switch, restart the service (the restart's own pause finds the pause open and leaves it) ...
npm run control -- resume                          # the sessions go on, with a nudge where they were cut
```

`--force-after <s>` is how long a session may take before it is cut with one Esc (default 300 s), `--timeout <s>`
how long `--wait` waits (default: that plus 30 s). `status` prints the pause and the sessions still working,
`force` cuts them now, and `--json` prints the answer for a script. Exit status: 0 done, 1 refused, failed or timed
out, 2 the server does not run. The command talks to `PROJECTMAN_HOME/control.sock` (`--home` or the
`PROJECTMAN_HOME` variable names the home; mode 0600, so run it as the service user): it has no login, and
whoever may open the file may pause the team. The people can pause and resume from the app too (a project's
admins, the instance's owners).

A pause made by hand survives a restart and is not lifted by the start: the team waits until someone resumes
it. Only the pause of the stop itself ends with the start.

## Release

A release has two paths: the release chain, which runs on GitHub and is the normal one, and the by-hand
procedure, the fallback for when the chain cannot run. The manual deploy of the live instance (`npm run cloud --
deploy --ref <commit>`, then the engine at the same commit) is the same under both; before live operation the
owner's connected Claude does it, and AI team members do not deploy (Projektterv, chapter 4: this page does not
repeat the rule).

### The release chain (PM-1193)

The release chain runs on GitHub and is driven by the owner's connected Claude on its endpoint (PM-1238, decision
68: before live operation the connected Claude releases and the team's AI members do not). The devops member
(the deployment duty) prepares: the preview, the non-production jobs and the status reading.

**The gate.** The hub refuses a production step to everyone but the owner in person and the owner's own connected
Claude acting on the owner's direct instruction (`isOwnerReleaseActor`, `assertReleaseAuthority`): an AI member,
the devops included, gets `release_owner_only` (403). The production steps are the `run_compute_job` jobs with a
dedicated workflow (`cloud-deploy` and `engine-release`; `isProductionComputeJob`) and `publish_release` without
`preview`. `cloud-image`, `engine-app` and the preview stay with the devops. A step the connected Claude takes on a
queue item issued by an AI member runs with that member's rights, so it is refused as well; an item the system
issued is taken in person and passes. Without a live authenticated execution there is no authority.

**When it starts.** The owner asks for a release, or the connected Claude decides to run the chain. A merge that
waits too long also asks for it: when the oldest merge on a repository's default branch since the previous release is
at least `PROJECT_MANAGER_UNRELEASED_HOURS` (24) hours old, the hub's operator sweep opens one `release_due` machine todo
for the integrator (PM-1333; payload `alert`, `repo`, `base`, `count`, `oldestAt`; marker `<repo>@<base>`, one open
todo per repository and base). It does not start the devops and raises no `unreleased` signal. The connected Claude
takes the todo in person (the system issued it, so its step passes the gate above), runs the chain or says why the
release waits. The todo closes by itself when the base moves after a release; a todo closed by hand is not reopened
within 24 hours.

**The chain**, run by the connected Claude on its endpoint (`publish_release` and `get_release_status` are
bound there since PM-1238), reporting to the owner afterwards:

1. Proposal. `publish_release` with `preview: true`. If it names no cards, stop.
2. From here on the chain runs on exactly the commit and tag of the preview, never on the current head of the
   default branch (a later merge is the next release).
3. `run_compute_job job=cloud-image commit=<SHA>` builds the image bundle.
4. `run_compute_job job=cloud-deploy commit=<SHA>` deploys it (PM-1197, see "Deploy from GitHub Actions").
5. `get_release_status`: the hub shows the new version. It is read-only and gives the hub's version and, per engine,
   `connected`, `version`, `versionMismatch` and `lastSeenAt`.
6. `publish_release commit=<SHA> tag=<the preview's tag>` tags the commit and creates the GitHub release.
7. The engine app build (PM-1198) starts by itself at the end of step 6 (`publish_release` prints its state, PM-1424).
   By hand, only to fill a gap or after a `failed`/`not_configured` state: `run_compute_job job=engine-release
commit=<SHA>`. Check that the release shows `projectman-motor.zip`, `.dmg` and `.json` once the run ends.
8. Poll `get_release_status` until every connected engine shows the new version and no `versionMismatch`, for at most
   2 hours (the menu bar apps check for an update every 30 minutes, PM-1199).
9. Cleanup runs by itself: the cloud keeps the current and the previous image (`prune-images`), each engine prunes
   its old app versions (keeps the current and the previous), and the run artifacts expire after 7 days.

**On failure** (a rollback of the deploy, a timeout, `env_missing`, `app_asset_conflict`, `compute_job_unknown`, or any
other error), the connected Claude stops, reports the error and the run link to the owner and does not retry blindly.
A chain that stopped after step 6 is finished from the failing step with the same commit and tag.

A devops session that finds a production step refused with `release_owner_only` turns to the integrator with the
error; it never works around the refusal.

**One-time rollout**, by the connected Claude and only after the owner's yes:

1. `npm run cloud -- github-deploy-setup --dry-run`, then without `--dry-run` (see "Deploy from GitHub Actions").
2. Register the `cloud-deploy` and `engine-release` jobs in the engine's `engine.json` (`repos[].computeJobs`) and in
   the hub's `repoComputeJobs`, with the values given under "Deploy from GitHub Actions" and "On GitHub, for a release".
3. Install the first attestation-mode app by hand: `npm run engine-app -- fetch --open`. Older apps verify the manifest
   only, so the first update across that boundary is the manual one.
4. The first release that contains this chain is issued by the connected Claude by hand, with the fallback below. The
   connected Claude then retires its own earlier release script, which lives outside this repository.

### By hand, the fallback (PM-1113)

This is the by-hand procedure, the fallback: the release chain above is the normal path. Use this one when the chain
cannot run (GitHub down, a job not yet registered, a commit before the chain). It is an owner-requested cloud
deployment followed by publication. No in-app proposal or approval waits for it; pipeline release gates remain the
project's human approval gates.

1. On the release machine, the owner or the connected Claude acting on the owner's request first
   gets the image bundle of the commit: start the general GitHub workflow by hand (the
   `gh workflow run projectman-job.yml ...` line in [AWS.md](AWS.md#prebuilt-arm-images-pm-718), or
   the line `image-fetch` prints when it finds no run). With `deployment.imageSource: "github"` (PM-1154),
   `npm run cloud -- deploy --ref <commit>` then has the cloud machine download and verify the run's
   artifact itself, so nothing large passes through the Mac. With the default `bundle` source, first run
   `npm run cloud -- image-fetch --ref <commit> --out <new directory>`, which verifies the run and
   its attestation and needs no Docker, and then `deploy --ref <commit>`. Credentials stay
   under `~/.config/projectman/cloud/`; see [AWS.md](AWS.md) for image verification and rollback.
   The local `image-build` remains the fallback (GitHub down, or a commit before PM-1145).
2. Update the Mac engine to the same commit through the engine app: build the app (see "Engine app build", on
   GitHub with the `engine-app` job or on the release machine) and open it; it stages the packaged engine
   and switches the service itself (see "Engine menu bar app"). The engine runs the app's packaged server, not a
   checkout build. These steps run on the engine machine, including when it is remote from the hub.
3. On request, the connected Claude calls `publish_release` (the owner's step; a member is refused, PM-1238), first with
   `preview: true`, then with the English release summary. This creates the annotated tag
   and public GitHub release; it does not deploy anything.
4. Either on GitHub (PM-1198, no Mac and no Developer ID needed): `run_compute_job job=engine-release
commit=<SHA40>` builds the app ad-hoc signed at the commit of the release tag and uploads zip, DMG, then
   manifest to that tag's release (see "On GitHub, for a release" below). Or on the release Mac, with a Developer
   ID, run `npm run engine-app -- publish --tag <tag> --config <absolute-file>` to build the
   engine and signed app from that remote tag and upload zip, DMG, then manifest. Use one of the two for a tag:
   whichever uploads first owns the assets, the other then ends in `app_asset_conflict`.

Before the first app publication, the owner needs Apple Developer Program membership,
a Developer ID Application certificate in the release machine's login keychain, and
`xcrun notarytool store-credentials <profile>`. Run the first publication from Terminal
so keychain access prompts can be answered with Always Allow. Create an absolute-path
JSON configuration file containing names only (no secrets):

```json
{
  "version": 1,
  "signingIdentity": "Developer ID Application: Example (ABCDE12345)",
  "teamId": "ABCDE12345",
  "notaryProfile": "projectman-release"
}
```

Publication uses the release user's `gh` login, the same owner account used by
`publish_release`. It requires the tag and GitHub release to exist. Both builders run
under one machine heavy lock, with a 45-minute total limit. Scratch builds are removed
after the command. A complete existing publication is downloaded and checked against
its manifest, commit and Team ID without rebuilding. Incomplete publications skip
assets whose SHA-256 matches the new build; different content under the same name
is refused, never overwritten. Signed rebuilds may differ, so a partial publication
can require owner investigation. The manifest is always uploaded last.
Exit codes: 0 complete, 1 operational failure, 2 missing configuration/release or asset
conflict (`REFUSED [app_release_not_configured|app_release_missing|app_asset_conflict]`),
64 invalid arguments. Remote engine machines only download these assets.

The owner's decision is the request to deploy and publish.

## Single-mode recovery service

[The way back](HYBRID.md#the-way-back) can return to a single-mode server on a Mac.
Its service installer is retained for this recovery path; it installs only `com.projectman.live`,
which runs the compiled server through `scripts/live/bin/projectman-live`.
It pauses a running server, stops it, verifies the installed build and resumes.
The installer refuses a missing build or a hybrid-mode environment.

```sh
npm run live -- install --root <checkout> --home <single-home> --port 4800
npm run live -- status --home <single-home>
npm run live -- uninstall --home <single-home>
```

The LaunchAgent has KeepAlive and allows the shutdown pause to finish. It records the
installing shell's allowed environment names, never billing credentials or a connected Claude's key.
Logs stay in `<single-home>/logs/live-server.log`. This is a recovery service, not a release path.

## Keeping the Mac awake while the engine works (PM-1086)

The engine keeps the Mac from sleeping on its own while a session, a merge check or a screenshot run is
active, and lets go two minutes after the last one ended. It holds `/usr/bin/caffeinate -i -s` (idle and system sleep on mains power; the display may sleep, and a Mac
on battery with the lid closed sleeps anyway). `npm run engine -- status` shows whether it holds and what
runs. To turn it off (or on again): `npm run engine -- keep-awake off|on`; it takes effect when the engine
is restarted.

## The providers an engine starts sessions for (PM-1187)

`engine.json` may list the providers the engine starts sessions for (`allowedProviders`). `npm run engine -- init`
writes `claude, codex, nanogpt` on a new engine (no Gemini: its commands run without an OS sandbox) and keeps the
previous value, a missing one too, with `--force`. Change it with
`npm run engine -- providers claude,codex|all|none`; `all` removes the list (every provider, the engine from
before this change), `none` starts no session. It takes effect when the engine is restarted, and
`npm run engine -- status` shows it. A start for another provider fails with `session_start_failed` and the
engine's message. A Codex or NanoGPT writer in the `default` mode does not start either on an engine (it needs
`acceptEdits` or `auto`). **Deploy the hub before the engine:** the hub closes the link on an error code it does
not know (`provider_not_allowed`, `permission_mode_too_low`).

## Controlling the engine service (PM-1087)

`service install [--path <PATH>]` uses the calling shell's PATH by default. The app passes
the login shell PATH explicitly. A checkout uses the installing Node; an engine package
(`engine-package.json` in its root) uses its embedded `bin/node`. Both use the same plist
and compiled server. The plist associates the background item with `com.projectman.engine-app`.

On the engine Mac, an app-managed service can switch to another complete package:

```sh
/path/to/package/bin/node /path/to/package/scripts/engine/cli.js service switch --to /path/to/new-package
```

Without `--to`, the calling CLI's package is the target. Checkout services refuse this
command; update those with a build and `service install` as before. Switch preserves the
installed PATH, saves the exact previous plist and stops the engine gracefully. Within
120 seconds the new service must report the target manifest's version and, if previously
connected, connect to the cloud. Failure restores the saved plist and verifies the previous
engine. `REFUSED [switch_rolled_back]` means recovery succeeded;
`REFUSED [switch_recovery_required]` means manual recovery is needed.

`status --json` includes `service.manager` (`app`, `checkout`, or null), `package`
(`version`, `tag`, `root`, or null), and `switch` (or null); its schema version remains 1.
The CLI alone writes `<home>/engine-switch.json`, `engine-switch.previous.plist` and the
exclusive `engine-switch.lock`. A dead owner's interrupted switch is recovered by the next
`service switch`, which returns the recovery result; repeat the command to try another target.
During `switching`, service install, uninstall,
start, stop and restart refuse with `switch_in_progress`. Another switch refuses with
`switch_busy`. After inspecting a `rolled_back` or `recovery_required` result, use
`service switch --clear` to remove its state and backup; an active/interrupted switch cannot
be cleared. Keep the previous package on disk until the switch has succeeded.
While `recovery_required` remains recorded, a new switch is refused and the saved plist is
preserved. Complete manual recovery and explicitly clear the result before trying again.
If the state file is unreadable or corrupt, status still reports the engine and exposes a
`recovery_required` switch with `switch_state_invalid` and an unknown target. This is a
report only; the damaged file is preserved and mutation commands continue to refuse it.

`npm run engine -- service start|stop|restart` controls the installed LaunchAgent. `stop` keeps the file (the
engine starts again at the next login) and waits until the engine has paused its running sessions and left,
up to 100 seconds. `npm run engine -- status --json` prints the whole state on one line for other programs
and `npm run engine -- logs [--lines N]` the end of the service's logs. The plist has `ExitTimeOut` 100, so
that a stop or restart does not kill the engine while it pauses the work.

## Engine menu bar app (macOS 13+, PM-1088, PM-1125)

The engine's Mac gets the engine from the downloaded app (`projectman motor.app`, the engine app
package of PM-1104); nothing is built on the Mac.

**First launch.** Open the downloaded app. It checks the machine first: Apple Silicon and macOS 13 or
later are required (otherwise a window says so and nothing is installed), and the Xcode command line tools
must be present (the window offers `xcode-select --install` and checks again every 5 seconds). The app then
moves itself to `/Applications` (or `~/Applications` when that is not writable) and starts again from there;
if neither works, an alert says so and the app quits.

**Install.** A window lists the steps: unpack the engine into
`~/Library/Application Support/projectman/engine/versions/<version>`, run `service install --path <PATH>`
(the PATH comes from the user's login shell, with a fallback list), register the background item and start
the engine. The layout is `engine/versions/<version>`, `engine/current` (a link to the running version) and
`engine/bin/projectman-engine` (a shim). The running and the previous version are kept; `~/.projectman` is
never touched. macOS asks for the background item to be allowed: the app opens System Settings, Login Items
and waits (checking every 2 seconds). When a step fails, the app undoes the half-done parts and shows the
`REFUSED [code]` line with a copy button; running the app again retries. When the engine is not set up yet
(no `engine.json` or key), the app waits until it is wired and then installs the service itself.

**Self-update (PM-1126, PM-1199).** At launch and every 30 minutes (when idle) the app reads the manifest of
`releases/latest` (not an API call) and installs a newer `bundleVersion`. The trust is `team` (Developer ID:
the signature must carry the app's Team ID) or, for the ad-hoc build, `attestation`: after the size and sha256
the app runs `gh attestation verify <zip> --repo <repo> --signer-workflow <repo>/.github/workflows/projectman-engine-release.yml
--source-ref <ref> --deny-self-hosted-runners` with the user's own `gh` (2.49+, logged in, found on the engine's
PATH), then checks the unpacked app's signature (valid, identifier `com.projectman.engine-app`), its
`bundleVersion` and that the bundled `engine-package.json` commit equals the manifest `version`
(`version_mismatch`). The attestation mode takes only an ad-hoc release (a manifest with a Team ID is
`team_mismatch`: install a Developer ID release by hand once). Failure codes show in the menu:
`attestation_invalid`, `gh_missing`, `signature_invalid`, `version_mismatch`, `size_mismatch`, `sha256_mismatch`.
A build without a tag (`CFBundleVersion` `0`) never updates itself. The downloaded zip has no quarantine
attribute (the app does not set `LSFileQuarantineEnabled`). The trust is the same as `engine-app fetch`: whoever
can merge to the default branch, and GitHub/Sigstore. The running engine then switches by the usual release
switch rules (idle at once, otherwise "Update now…").

**Menu.** A Mac that runs the engine from a checkout (the manual path) only gets the menu: the app does not
install, switch or uninstall there. The menu shows the engine's state, work count, keep-awake state and local details. Start, Stop
and Restart control the engine's installed service. Quit closes the menu app until the next login and leaves
the engine running. A terminal-started engine must be stopped in that terminal.

**Removing the engine.** If the service is app-managed, Details has "Motor eltávolítása…". It asks for
confirmation, then runs `service uninstall`, deletes `engine/`, unregisters the background item and shows the
result; `~/.projectman` stays. Afterwards drag the app to the Trash. Without the app:
`npm run engine -- service uninstall`.

Test the Swift core with
`swift test --package-path deploy/mac/menubar`; the Node fixture guard checks the CLI contract. Native
screenshots, Login Items approval and VoiceOver checks require the logged-in Mac desktop.

### Installing a release on another Mac (PM-1425)

The release app is signed ad hoc. A copy that a browser, AirDrop or a sandboxed AI host marked with
`com.apple.quarantine` does not open (Gatekeeper); `curl`, `gh` and `ditto` downloads are not marked. The checked
install path is `deploy/mac/install-engine-app.sh`, taken from the release tag and read before it runs (never
`curl | sh`):

```sh
curl -fsSLO https://raw.githubusercontent.com/janoist1/projectman/<tag>/deploy/mac/install-engine-app.sh
sh install-engine-app.sh --tag <tag>
# or, for a manifest and zip downloaded by hand from the release page:
sh install-engine-app.sh --tag <tag> --zip ~/Downloads/projectman-motor.zip --manifest ~/Downloads/projectman-motor.json
```

It needs Apple Silicon, macOS 13+ and the user's `gh` 2.49+ logged in (`gh auth login`, once, by the user). In
order, every failure printing `REFUSED [code]` and installing nothing: the machine (`unsupported_os`,
`unsupported_arch`, `gh_missing`, `gh_outdated`, `gh_not_logged_in`); the download into a new temporary folder
(`download_failed`); the manifest: schemaVersion 1, the requested tag, arm64 (`manifest_invalid`); the zip's size
and SHA-256 against the manifest (`size_mismatch`, `sha256_mismatch`); `gh attestation verify` of the zip and the
manifest with the updater's arguments (`--repo janoist1/projectman --signer-workflow
janoist1/projectman/.github/workflows/projectman-engine-release.yml --source-ref refs/heads/main
--deny-self-hosted-runners`, `attestation_invalid`); `ditto -x -k` into a new folder holding exactly the app
(`unpack_failed`, `unpack_invalid`); `codesign --verify --deep --strict` with the identifier
`com.projectman.engine-app` (`signature_invalid`), `CFBundleVersion` and the bundled engine's commit
(`version_mismatch`). Only then is the app copied to `~/Applications` under a temporary name, the quarantine
removed from the copy if it has one (`xattr -dr com.apple.quarantine`, printed), and the copy renamed to
`projectman motor.app` (an earlier copy there is replaced). The trust anchor is the attestation; the SHA-256 only
ties the zip to the manifest. No `sudo`; nothing is written outside the home and the temporary folder.

The last lines say how to start the app (`open ~/Applications/projectman\ motor.app`, or a double-click in Finder
when the caller may not run `open`) and what the user clicks on first launch (the command line tools, the
background item in Login Items); the app then continues as in "First launch" above. With a Developer ID release
(an owner decision, yearly fee) the quarantine step becomes unnecessary and the updater moves to `team` trust.

## Separate work volume on a Mac (PM-846)

macOS keeps a log of every file change in the `fseventsd` daemon. Task worktrees, member workspaces,
`node_modules` installs change so many files that the daemon grew to 17 GB of memory. A separate APFS volume
with an empty `.fseventsd/no_log` file is not logged. The engine puts `worktrees/` and `workspaces/` below one
**work root** on that volume.

The volume is **mounted inside the engine home** (`~/.projectman/work`), not under `/Volumes`. The sandboxes keep
the other members' work unreadable by denying the home; a root outside it would make every checkout readable to
every session, so the engine refuses to start with one (`work_root_invalid`, reason `outside_home`). Not moved:
the sessions' `$TMPDIR` (`/private/tmp/projectman-<uid>-tmp`: it holds Unix sockets with a path length limit),
the Claude temp directory, `member-caches` and the full test's `pmft-*` run directories (PM-848: the full test
sandbox denies the home for reading and allows only the run's own directory, so a run directory inside the home
would leave its parents unreadable; it stays in `os.tmpdir()`). Measure first (step 8); a follow-up card handles them if the daemon
still grows.

The owner does these steps once (the commands need `sudo`; replace `disk3` with the container `diskutil list`
shows for the Data volume, and `<user>` with the account):

1. `diskutil list`: find the APFS container that holds "Macintosh HD - Data".
2. `sudo diskutil apfs addVolume disk3 APFS projectman-work -nomount`. The volume shares the container's free
   space; no size is needed.
3. Mount it inside the home, and make the mount survive a restart:
   `mkdir -p ~/.projectman/work`, `diskutil info projectman-work` (note the Volume UUID), `sudo vifs` and add
   `UUID=<uuid> /Users/<user>/.projectman/work apfs rw,nobrowse`. Then
   `sudo diskutil mount -mountPoint ~/.projectman/work projectman-work`,
   `sudo diskutil enableOwnership ~/.projectman/work`,
   `sudo chown <user>:staff ~/.projectman/work && chmod 700 ~/.projectman/work`.
4. Switch the file log off: `sudo mkdir ~/.projectman/work/.fseventsd && sudo touch ~/.projectman/work/.fseventsd/no_log`,
   then unmount and mount the volume again so that `fseventsd` reads it.
5. Keep Spotlight and Time Machine away: `sudo mdutil -i off ~/.projectman/work`,
   `sudo tmutil addexclusion ~/.projectman/work`.
6. Mark the volume as the work root: `touch ~/.projectman/work/.projectman-work-root`. The engine starts only when
   this file is a regular file in the root, so an unmounted volume (an empty directory on the system volume) stops
   it instead of silently filling the system volume.
7. Move the existing directories. Pause the team (see "Pausing the team for an update"), stop the engine
   (`npm run engine -- service uninstall`; `move-work-root` also refuses while the status file names a live process or the
   service runs), then:

   ```sh
   npm run engine -- move-work-root ~/.projectman/work
   npm run engine -- service install        # or: npm run engine -- start
   ```

   The command copies `worktrees/` and `workspaces/` (`ditto`; it does not move, the old directories are the way
   back), runs `git worktree repair` in every copied worktree, checks with `git worktree list` in every registered
   repository that none still points at the old place, renames the old directories to `worktrees.pre-PM-846` and
   `workspaces.pre-PM-846`, and only then writes `workRoot` into `engine.json`. It refuses a root that is already
   set, a non-empty target, an engine that runs, and a volume with less than 1.1 times the data free. If it fails
   half-way, `engine.json` and the old directories are untouched; delete what it copied below the work root and
   run it again. After the start the running sessions go on in a new conversation with a summary (their files, commits
   and uncommitted changes stay). Delete `~/.projectman/{worktrees,workspaces}.pre-PM-846` when the team works.

   The first worktree on the new volume installs its dependencies in full: a `node_modules` clone
   (`cp -c`) works only inside one volume, and the repository is on another one. The next ones clone from it.

8. Measure: `ps -o rss= -p $(pgrep fseventsd)` once a day for three days. It should not grow at the earlier
   pace (about 6 GB a day).
9. Encryption is the owner's choice at step 2. Without `-passphrase` the volume is not locked at login. If client
   secrets (`.env`) may lie in the checkouts, create it with `-passphrase`: the mount then happens only after login,
   and the engine does not start (`work_root_invalid`) until the volume is mounted.

By hand, without the command (the single-mode server, or a failed run): copy with
`ditto ~/.projectman/worktrees ~/.projectman/work/worktrees` (and `workspaces`), run
`git -C <each worktree> worktree repair`, rename the old directories, and set `workRoot` in `engine.json`
(engine mode) or `PROJECTMAN_WORK_ROOT=<path>` (single mode). To go back, remove `workRoot`, rename the
`.pre-PM-846` directories back and run `git worktree repair` in each worktree.

On a remote engine the same steps run on the engine's machine and `workRoot` is in that machine's `engine.json`;
nothing new crosses the server and engine boundary.

## Cloud deployment of the hybrid mode (PM-317)

The data-preserving rollback from EC2 to the owner's Mac is [HYBRID.md, The way back](HYBRID.md#the-way-back).
The single-mode service is retained for that recovery path. Use the release procedure above to update the
cloud and the Mac engine. The AWS resources and the `npm run cloud` commands that make them are in
[AWS.md](AWS.md).

The cloud side of a hybrid installation (`PROJECTMAN_MODE=cloud`, no AI session of its own, the
engine on your Mac does the work) is a container: `deploy/cloud/Dockerfile`, with the Cloudflare
tunnel, Litestream (the database) and restic (the rest of the home) inside it. It has no public
port: the only way in is the outbound tunnel. The whole guide is [HYBRID.md](HYBRID.md): the image,
the storage, the first setup from a browser (a one-time setup code from the log), the backup, the
restore rehearsal and the update.

### Deploy from GitHub Actions (PM-1197)

The cloud can also be deployed by a GitHub Actions job, with no AWS profile or key on the Mac and no `cloud.env` on
GitHub. The devops starts it for a commit of the default branch with the team tool:

```
run_compute_job job=cloud-deploy commit=<SHA40>
```

It runs the dedicated workflow `.github/workflows/projectman-deploy.yml` (a registration with
`"workflow": "projectman-deploy.yml"`, the values of the `cloud-deploy` example above: `runsOn` `ubuntu-24.04`,
`outputs` `["deploy/report.json"]`, `command` `cloud-deploy`; the workflow refuses any other command, runner or
output). The image is the one the `cloud-image` job built for the same commit, so that job must have run first
(`run_compute_job job=cloud-image commit=<SHA40>`). The job assumes the OIDC role `projectman-cloud-deploy` for an hour
(docs/AWS.md "Deploy role for GitHub Actions"), deploys, keeps the current and the previous image on the machine
and removes the older ones, and leaves `deploy/report.json` (commit, image, previous, `healthy`, `rolledBack`, `pruned`)
as the attested artifact `projectman-job-<run_id>`. A deploy that did not become healthy rolls back as `npm run cloud --
deploy` does, reports `rolledBack: true` and fails the job.

One-off setup, by the connected Claude and only after the owner's yes: `npm run cloud -- github-deploy-setup --dry-run`, then
without `--dry-run`. It makes the IAM role, the `cloud-production` environment (default branch only) and its three
variables, and is safe to repeat. Until then the workflow stops in its guard for the missing variables.
`npm run cloud -- deploy` from the owner's computer keeps working, and is still how a new machine gets its first
`cloud.env`; the job refuses with `env_missing` when the machine has none.

# Connected Claude access

The owner's Claude Code (the "connected Claude") reaches the hub through the integrator entrance. The code names
stay: the integrator host and the integrator key (`pmi_`, modes `super` and `read`). A cloud installation uses the
explicit `cloudflare.integratorHostname` as that entrance's origin. Set the client's `baseUrl`
to `https://<integratorHostname>`; `/api/...` and `/mcp` and the key file do not change.
The host requires its own Access Service Auth token and the application's `pmi_` key. A human
cookie alone gets 401 there; the board refuses bearer authentication with 403
`integrator_host_required` and closes bare `/mcp`. Human login, key management, the key's audit and
owner decisions remain on the board's cookie API. The board is public (decision 56); the entrance's setup and
checks are in [the public board guide](AWS.md#the-public-board-pm-672-part-of-pm-664).

The host owner can create a key in Settings → Claude Code on your machine, using their own login. Both `super` and
`read` keys offer 1, 7, 30 or 365 days, or **Never expires**; the default is 7 days. A non-expiring key stays valid
until revoked or replaced. If it leaks, it can be used until revocation; the owner can revoke it at any time
in the same settings section. Non-expiring keys show no imminent-expiry warning.

The secret is shown once; save it as `~/.config/projectman/integrator-key` on the connected Claude's
machine, with directory mode 700 and file mode 600. Never put it in a message, task, commit,
member prompt or engine payload.
Send it in the `Authorization: Bearer <key>` header on `/api/*` requests. For example:
The key works only over HTTPS or a local connection; `tailscale serve` must expose an HTTPS target when used with it.

```sh
curl -H "Authorization: Bearer $(cat ~/.config/projectman/integrator-key)" http://localhost:4800/api/projects
```

Against a cloud installation (hybrid mode, [HYBRID.md](HYBRID.md)) the request first has to pass
Cloudflare Access on the integrator hostname, so it carries a second pair of headers: a service token made for the
connected Claude alone (not the engine's), kept next to the key in `~/.config/projectman/` with mode 600. The key and
the service token are two separate secrets, and the service token alone gets nowhere in
projectman:

```sh
curl \
  -H "CF-Access-Client-Id: $(cat ~/.config/projectman/access-client-id)" \
  -H "CF-Access-Client-Secret: $(cat ~/.config/projectman/access-client-secret)" \
  -H "Authorization: Bearer $(cat ~/.config/projectman/integrator-key)" \
  https://<integratorHostname>/api/projects
```

Bearer authentication takes precedence over a login cookie. A revoked or expired key fails with
`integrator_key_invalid`; a replacement immediately revokes the previous key of the same mode.
Read keys cannot write. A `super` key changes things under the current owner's
membership and the shared mutation policy. Owner-reserved security, deletion and cost effects
remain refused without an exact owner grant. Keys cannot manage keys or authenticate a websocket
connection. Operations retain their attribution (`via: 'integrator'`) and audit after revocation.

## The connected Claude's MCP endpoint (PM-760)

An MCP client (an AI tool working for the owner) can use the same keys over MCP at
`POST /mcp`, with no login, no session and no running engine:

- Every HTTP request carries `Authorization: Bearer <key>` and is checked afresh: expiry, revoke and the
  owner's membership take effect on the next request. A missing, wrong, expired or revoked key is an
  HTTP `401` with `integrator_key_invalid` (never a `404` and never a `200` with an error text); a
  connection that is neither HTTPS nor local is `integrator_https_required`. `GET` and `DELETE` are
  `405` with `Allow: POST`. There is no OAuth flow and no `Mcp-Session-Id`; the login cookie is not a
  credential here.
- Every project tool takes a required `project_key` (and a card key where it works on a card), and
  works only in projects where the key's holder is an owner right now. `list_projects` lists them.
- `tools/list` follows the key's mode. A `super` key gets the shared project tools and the super tools
  (hand-offs, `super_operate`, diagnostics, `relay_owner_answer`); a
  `read` key gets the read tools only. Legacy keys fail authentication with 401. A
  tool called directly that the mode does not allow is refused (`integrator_not_allowed`,
  `integrator_read_only`), and the member's session, decision and file tools are never offered.
  `super` and `read` keys use the same scope as over REST, and a `super` key's calls are audited as
  `mcp_<tool>`.
- The project documents (PM-1232): `list_documents`, `read_document` and `document_history` with either key;
  `write_document` (create, edit and rename, with a one-line reason and `base_version` for an edit) with a
  `super` key only, `integrator_read_only` with a `read` key. There is no delete and no restore on `/mcp`.
  The commit stands under the key holder's name; the history marks it as made through the integrator.
- The member MCP, `/mcp/<token>`, is unchanged: for the agents on the same machine only.

Client configuration (no secret in it; the key is read from the file above when the client starts):

```json
{
  "mcpServers": {
    "projectman": {
      "type": "http",
      "url": "https://integrator.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${PROJECTMAN_INTEGRATOR_KEY}",
        "CF-Access-Client-Id": "${PROJECTMAN_ACCESS_CLIENT_ID}",
        "CF-Access-Client-Secret": "${PROJECTMAN_ACCESS_CLIENT_SECRET}"
      }
    }
  }
}
```

Export the three variables from the files in `~/.config/projectman/` (mode 600) in the shell that starts
the client. Locally the URL is `http://localhost:4800/mcp` and the two `CF-Access-*` headers are left out.

Behind the Cloudflare tunnel (`npm run cloud -- edge` writes this) the integrator hostname passes only `/api/` and
the exact `/mcp`, each with the integrator application's Access audience, and answers 404 to everything else.
On the board's name the bare `/mcp` is a 404 too, and `/mcp/` and `/hooks` stay closed:

```yaml
ingress:
  - hostname: integrator.example.com
    path: ^/api/
    service: http://127.0.0.1:4700 # originRequest.access: the integrator application's audience
  - hostname: integrator.example.com
    path: ^/mcp$
    service: http://127.0.0.1:4700 # the same audience
  - hostname: integrator.example.com
    service: http_status:404
  - hostname: projectman.example.com
    path: ^/hooks
    service: http_status:404
  - hostname: projectman.example.com
    path: ^/mcp/ # the member door
    service: http_status:404
  - hostname: projectman.example.com
    path: ^/mcp$ # the bare /mcp lives only on the integrator hostname
    service: http_status:404
  # ... the board's name: /engine and the rest, see AWS.md "The public board"
  - service: http_status:404
```

A reverse proxy does the same: on the integrator host `location = /mcp` and `location ^~ /api/` go to the service
with `Host` kept and `X-Forwarded-Proto: https` set, and everything else answers `404`; `location ^~ /mcp/` and
`location ^~ /hooks` answer `404` on the board's name. The check script (`deploy/cloudflare/check.sh`) expects
`/mcp/x` and `/hooks/x` to be `404`; a `POST /mcp` without a key must be `401` with `integrator_key_invalid`.
Locally (`http://localhost:4800/mcp`) no ingress is involved.

## The `projectman` command and the MCP proxy (PM-765)

`projectman` is a thin client of the REST API and the change journal above, and `projectman mcp-proxy` is a
stdio shim for MCP clients that cannot send an HTTP header. Both use the same key, the same rights and the
same audit as the endpoints; the command never decides anything the server does not. It runs on the
connected Claude's machine only. Primary way (PM-1429): the engine app ships the client bundled and its install
and update step writes the shim `~/Library/Application Support/projectman/engine/bin/projectman` next to
`projectman-engine`; the shim follows `engine/current` and runs the app's own Node on
`scripts/projectman/cli.js`, so neither a checkout nor a Node of the machine is needed. In a checkout:
`npm run projectman -- <command>`, or `projectman` once the package is linked with `npm link`.

Setting the client up on a machine (the key comes on standard input, never as an argument or a variable):

```sh
engine=~/"Library/Application Support/projectman/engine/bin/projectman"
pbpaste | "$engine" connect --base-url https://<integrator hostname> --access-headers-file ./integrator-access-token.json
"$engine" check
```

Copy the key to the clipboard first and pipe it in as above, so no plain-text key file is left on the disk. A key
typed at a terminal would show on the screen, so `connect` refuses a terminal as standard input. If the key is in a
file (`< key.txt`), delete that file as soon as `connect` has run. `./integrator-access-token.json` holds the Access
secret in plain text as well: delete it after `connect` too (the setup keeps its own 0600 copy).

`connect` writes `~/.config/projectman/integrator-key` (0600), the copy of the Access file as
`~/.config/projectman/cloud/integrator-access-token.json` (0600) and `client.json` (version 1), in directories of
mode 0700. It follows no symbolic link, writes nothing before every target has been checked, leaves an identical
file as it is and refuses a file with other content unless `--replace` is given. `--access-headers-file` is left out
for a loopback hub. `check` asks the reader route `GET /api/projects` with the key and prints the project keys it
reaches: status 0 when the server accepts the key, 3 for a rejected key, a wrong Access file or a credential file
problem, 1 for any other failure.

The client has one configuration file, `~/.config/projectman/client.json` (`--config FILE` names another).
It holds paths and an origin, never a secret:

```json
{
  "version": 1,
  "baseUrl": "https://CHOOSE-INTEGRATOR-HOSTNAME",
  "keyFile": "~/.config/projectman/integrator-key",
  "accessHeadersFile": "~/.config/projectman/cloud/integrator-access-token.json"
}
```

- `baseUrl` is an origin: HTTPS, or HTTP to this machine (`localhost`, `127.x`, `[::1]`). No user name,
  path, query or fragment. A redirect is never followed, so the key never goes to another origin.
- `keyFile` is the file of "Connected Claude access" above. `accessHeadersFile` (cloud only) is the
  connected Claude's service-token file made by `npm run cloud -- edge` (`CF-Access-Client-Id`,
  `CF-Access-Client-Secret`). A relative path is relative to the configuration file's directory. A
  further owner's client points `accessHeadersFile` at the file `owners/<id>/integrator-access-token.json`
  that the host made for them (PM-1065) and handed over outside projectman.
- The configuration, the key file and the Access file must be regular files of your user with mode 600,
  in a directory of your user with mode 700, and none may be a symbolic link; otherwise the command
  stops with status 3 before it sends anything.
- There is no `--token` and no environment variable for a secret. The key and the Access values appear
  in no argument, no environment, no output and no log: error text and `--verbose` lines (method, path,
  status only) are redacted.
- A file given with `--file` (`-` is standard input) must be a regular file, at most 1 MiB, and never a
  credential or configuration file or anything in their directories.

Commands (`--json` prints the typed answer; every command takes `--config`, `--verbose`, `--help`):

```sh
projectman tasks create --project PM --file card.json        # CreateTaskRequest as JSON
projectman tasks start PM-12
projectman messages send --project PM --to dev --task PM-12 --file message.txt
projectman labels add PM-12 waiting-answer --note "Waiting for the reply"
projectman inbox list --project PM [--state open|all|…]
projectman inbox answer ITEM --project PM --file answer.txt   # relays the owner's words; no decision
projectman inbox fix-limit ITEM --project PM --option replan|reassign|another_round|to_owner [--note TEXT]   # only the item addressed to the connected Claude
projectman merges list --project PM --repo web
projectman merges enqueue PM-12
projectman merges prioritize PM-12 --reason "release blocker"
projectman merges reorder --project PM --repo web --expected-revision 7 --reason "…" PM-3 PM-12
projectman pause --project PM [--reason TEXT]    # or: --instance
projectman resume --project PM                   # or: --instance
projectman events follow --project PM [--cursor-file FILE]
projectman operations get OPERATION --project PM
```

Exit status: `0` done, `1` the operation failed (any server refusal other than a bad key, and a network
failure), `2` wrong arguments, `3` a bad key or Access token, or a credential file that is not private.
A `read` key reads and follows; a change is refused by the server with 403 `integrator_read_only`, as over REST.

Changes and retries. Every change carries a fresh request id (`--request-id UUID` supplies one) in the
`x-request-id` header. Only the operations (`messages send`, `merges enqueue`, `merges reorder`) are
idempotent on that id: repeating one with the same `--request-id` runs it once and answers with the same
operation. Every other change is not repeated by the server's id. When a change's outcome is unknown (the
connection broke after the request left), the command prints the request id, exits with `1` and never
repeats the change itself; read the state first (`operations get`, `inbox list`, the card) and then decide.
`inbox answer` calls the relay endpoint only; a question that needs the owner's decision stays with the
owner's own login.

`events follow` long-polls `GET /api/projects/:key/events` and prints one line per event (`--json`: one
JSON object). `--cursor-file` holds the cursor of the last event written to standard output (it is not a
secret). It is replaced atomically after each written event, so a consumer that goes away loses nothing:
the next run starts behind the last event that was written, and an event that was not written comes again.
An expired or foreign cursor is the server's `event_cursor_expired` / `invalid_event_cursor`; delete the
file to start from the current state. Ctrl-C ends the command with `0` and keeps the file. A network failure
and a gateway answer without a server error code (502, 503, 504, for example while the server restarts) are
retried with a pause of 1 s growing to 30 s; any other refusal ends the command. For a change, a gateway 502 or
504 counts as an unknown outcome (above), and a 503 as not served.

The REST and events requests carry the non-secret header `X-Projectman-Client: cli`, so the key's list
shows the use as the CLI channel. The header is a label, not a credential: it grants nothing, and the server
decides the channel by the path (`/mcp` is always the MCP channel).

MCP proxy. An MCP client that starts a local command takes this configuration; it has no secret in it, because
the proxy reads `client.json` and the files it names:

```json
{
  "mcpServers": {
    "projectman": { "command": "projectman", "args": ["mcp-proxy"] }
  }
}
```

The proxy turns each JSON line on its standard input into one `POST {baseUrl}/mcp` with the key and the Access
headers, and writes the protocol messages of the answer to its standard output, one per line (an event-stream
answer is split into its messages; a notification gets an empty answer and writes nothing). It is a transport
only: it does not read, filter or change a message, chooses no project, and logs no message body; standard
output carries protocol lines and nothing else, standard error redacted status lines. A request it cannot
serve gets a JSON-RPC error (`-32000`) so the client does not wait, and the proxy ends with `3` after a refused
key or `1` after another failure. For a client that can send its own headers, the direct configuration above
is the same thing without the proxy.

Use the absolute path of the app's shim as the command: Claude Desktop does not use the login shell's `PATH`,
and the app's Node is not on it either. The three clients:

- **Claude Desktop**, `~/Library/Application Support/Claude/claude_desktop_config.json`:

  ```json
  {
    "mcpServers": {
      "projectman": {
        "command": "/Users/<you>/Library/Application Support/projectman/engine/bin/projectman",
        "args": ["mcp-proxy"]
      }
    }
  }
  ```

- **Claude Code**:
  `claude mcp add --scope user projectman -- "$HOME/Library/Application Support/projectman/engine/bin/projectman" mcp-proxy`
- **Codex**, `~/.codex/config.toml`:

  ```toml
  [mcp_servers.projectman]
  command = "/Users/<you>/Library/Application Support/projectman/engine/bin/projectman"
  args = ["mcp-proxy"]
  ```

A further owner's client (PM-1063, Claude Desktop with `mcp-proxy`) is set up the same way on that owner's own
machine: their own `super` or `read` key (made in their own login; an owner account with a password may hold
one, and revoking the account revokes the key), their own Access header file (`accessHeadersFile`, see above)
and a `client.json` that names both by path. No secret goes into the MCP client's configuration. The key reaches
only the projects that owner holds; the instance administration, the machine state and the instance knowledge of the
host are refused with `host_only`, and the machine work in the owner's queue is theirs to do on their own
machine, with their approval.
