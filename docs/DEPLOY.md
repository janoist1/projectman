# Deployment and operation

The supported installation uses a cloud hub and a Mac engine; see [HYBRID.md](HYBRID.md)
and [AWS.md](AWS.md). This page covers local operation, releases and integrator access.

## Engine app build (PM-1104, PM-1122)

Build on the release Mac with full Xcode, using the self-contained package produced by
`npm run engine-app -- package`. The checkout supplies the Swift sources and templates;
the package's `engine-package.json` supplies the commit and release tag. `origin` must
identify the public GitHub release repository (HTTPS or SSH).

```sh
npm run engine-app -- build --package /path/to/package --out /path/to/new-output --ad-hoc
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
and records an empty Team ID (the updater must remain disabled). Without hardened runtime,
Node can load ad-hoc native modules that have no Team ID. Signing options cannot be combined
with `--ad-hoc`. Node receives JIT and unsigned executable memory entitlements in both modes;
signed release builds keep hardened runtime and library validation enabled. Verify real Node/native module
execution and Gatekeeper on the owner's first signed release (PM-1123) before distribution.

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

To update without losing the sessions' place, pause by hand, and wait for it, before the switch:

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

## Release (PM-1113)

The supported release path is an owner-requested cloud deployment followed by publication.
There is no release watcher or administration supervisor, and no in-app proposal or approval
that waits for one. Pipeline release gates remain the project's human approval gates.

1. On the administration Mac, the owner or the integrator acting on the owner's request first
   gets the image bundle of the commit: start the general GitHub workflow by hand (the
   `gh workflow run projectman-job.yml ...` line in [AWS.md](AWS.md#prebuilt-arm-images-pm-718), or
   the line `image-fetch` prints when it finds no run), then
   `npm run cloud -- image-fetch --ref <commit> --out <new directory>`, which verifies the run and
   its attestation and needs no Docker. Then `npm run cloud -- deploy --ref <commit>`. Credentials stay
   under `~/.config/projectman/cloud/`; see [AWS.md](AWS.md) for image verification and rollback.
   The local `image-build` remains the fallback (GitHub down, or a commit before PM-1145).
2. Update the Mac engine's own checkout to the same commit, run `npm ci`, then
   `npm run build -w @projectman/server` and `npm run engine -- service install`.
   The engine runs `apps/server/dist/index.js`; installation refuses a missing bundle.
   These steps run on the engine machine, including when it is remote from the hub.
3. On request, a deployment duty holder calls `publish_release`, first with
   `preview: true`, then with the English release summary. This creates the annotated tag
   and public GitHub release; it does not deploy anything.
4. On the release Mac, run
   `npm run engine-app -- publish --tag <tag> --config <absolute-file>` to build the
   engine and signed app from that remote tag and upload zip, DMG, then manifest.

Before the first app publication, the owner needs Apple Developer Program membership,
a Developer ID Application certificate in the administration Mac's login keychain, and
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

The owner's decision is the request to deploy and publish. No unused approval item is created.
Historical releases and timeline events remain readable; migration 129 cancels open approvals
of the retired watcher. Old cloud configuration keys `releaseTarget` and `hybrid` are ignored
with a warning, and no `PROJECTMAN_RELEASE_*` settings are sent to the cloud.

## Single-mode recovery service

The [cloud cutover rollback](CLOUD-CUTOVER.md) can return to a single-mode server on a Mac.
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
installing shell's allowed environment names, never billing credentials or an integrator key.
Logs stay in `<single-home>/logs/live-server.log`. This is a recovery service, not a second
release path; there is no watcher, remote, journal or automatic tag publication.

## Keeping the Mac awake while the engine works (PM-1086)

The engine keeps the Mac from sleeping on its own while a session, a merge check or a screenshot run is
active, and lets go two minutes after the last one ended. Running `caffeinate` by hand is no longer needed.
It holds `/usr/bin/caffeinate -i -s` (idle and system sleep on mains power; the display may sleep, and a Mac
on battery with the lid closed sleeps anyway). `npm run engine -- status` shows whether it holds and what
runs. To turn it off (or on again): `npm run engine -- keep-awake off|on`; it takes effect when the engine
is restarted.

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
and `npm run engine -- logs [--lines N]` the end of the service's logs. The plist now has `ExitTimeOut` 100, so
that a stop or restart does not kill the engine while it pauses the work: **on a machine where the service is
already installed, run `npm run engine -- service install` once more** for the new setting to apply.

## Engine menu bar app (macOS 13+, PM-1088, PM-1125)

The engine's Mac gets the engine from the downloaded app (`projectman motor.app`, the engine app
package of PM-1104); nothing is built on the Mac any more. `npm run engine -- app install` is
retired (`REFUSED [app_install_retired]`).

**First launch.** Open the downloaded app. It checks the machine first: Apple Silicon and macOS 13 or
later are required (otherwise a window says so and nothing is installed), and the Xcode command line tools
must be present (the window offers `xcode-select --install` and checks again every 5 seconds). The app then
moves itself to `/Applications` (or `~/Applications` when that is not writable) and starts again from there;
if neither works, an alert says so and the app quits.

**Install.** A window lists the steps: remove the PM-1088 app (only if it is there), unpack the engine into
`~/Library/Application Support/projectman/engine/versions/<version>`, run `service install --path <PATH>`
(the PATH comes from the user's login shell, with a fallback list), register the background item and start
the engine. The layout is `engine/versions/<version>`, `engine/current` (a link to the running version) and
`engine/bin/projectman-engine` (a shim). The running and the previous version are kept; `~/.projectman` is
never touched. macOS asks for the background item to be allowed: the app opens System Settings, Login Items
and waits (checking every 2 seconds). When a step fails, the app undoes the half-done parts and shows the
`REFUSED [code]` line with a copy button; running the app again retries. When the engine is not set up yet
(no `engine.json` or key), the app waits until it is wired and then installs the service itself.

**Switching from PM-1088.** On launch the app removes the old `com.projectman.engine-menubar` agent, its
plist, its app and `menubar.json`. When the engine is already installed this happens silently; a deletion
that fails is logged and retried at the next launch. A Mac that runs the engine from a checkout (the admin
Mac) only gets the menu: the app does not install, switch or uninstall there.

**Menu.** The menu shows the engine's state, work count, keep-awake state and local details. Start, Stop
and Restart control the engine's installed service. Quit closes the menu app until the next login and leaves
the engine running. A terminal-started engine must be stopped in that terminal.

**Removing the engine.** If the service is app-managed, Details has "Motor eltávolítása…". It asks for
confirmation, then runs `service uninstall`, deletes `engine/`, unregisters the background item and shows the
result; `~/.projectman` stays. Afterwards drag the app to the Trash. Without the app:
`npm run engine -- service uninstall`.

`npm run engine -- app uninstall` still removes what PM-1088 left (app, agent, `menubar.json`, build cache)
for a Mac where the old app is still installed. Test the Swift core with
`swift test --package-path deploy/mac/menubar`; the Node fixture guard checks the CLI contract. Native
screenshots, Login Items approval and VoiceOver checks require the logged-in Mac desktop.

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

The data-preserving rollback from EC2 to the owner's Mac is in
[CLOUD-CUTOVER.md](CLOUD-CUTOVER.md) (PM-674). The single-mode service is retained for that
recovery path. Use the release procedure above to update the cloud and the Mac engine.

The cloud side of a hybrid installation (`PROJECTMAN_MODE=cloud`, no AI session of its own, the
engine on your Mac does the work) is a container: `deploy/cloud/Dockerfile`, with the Cloudflare
tunnel, Litestream (the database) and restic (the rest of the home) inside it. It has no public
port: the only way in is the outbound tunnel. The whole guide is [HYBRID.md](HYBRID.md): the image,
the storage, the first setup from a browser (a one-time setup code from the log), the backup, the
restore rehearsal and the update.

# Integrator access

Cloud installations with the separate machine entrance (PM-675) use the explicit
`cloudflare.integratorHostname` as the integrator's origin. Set the existing client's `baseUrl`
to `https://<integratorHostname>`; `/api/...` and `/mcp` and the existing key files do not change.
The host requires its own Access Service Auth token and the application's `pmi_` key. A human
cookie alone gets 401 there; the board refuses bearer authentication with 403
`integrator_host_required` and closes bare `/mcp`. Human login, key management, super audit and
owner decisions remain on the board's cookie API. Stage the server with
`PROJECTMAN_INTEGRATOR_HOSTNAME` while the board is private, verify and move the client, then
switch the board to public; see [the public board guide](AWS.md#the-public-board-pm-672-part-of-pm-664).

The host owner can create an integrator key in Settings → Operator permissions → Claude Code
on your machine, using their own login. Both `super` and `read` keys offer 1, 7, 30 or 365 days,
or **Never expires**; the default remains 7 days. A non-expiring key stays valid until revoked
or replaced. If it leaks, it can be used until revocation; the owner can revoke it at any time
in the same settings section. Non-expiring keys show no imminent-expiry warning.
The key's lifetime is separate from the Operator's machine-access grant.

**Before deploying PM-1037:** the owner must check Settings → Integrator for an active
“Régi kulcs” (legacy key). If one exists, issue a super or read key and replace the integrator's
stored credential before approving the release. Migration 114 revokes legacy keys with an audit
entry; their rows remain visible in history. Legacy credentials then receive 401 on REST, MCP
and event reads. The singular `/api/auth/integrator-key` endpoint is removed.

The secret is shown once; save it as `~/.config/projectman/integrator-key` on the integrator's
machine, with directory mode 700 and file mode 600. Never put it in a message, task, commit,
member prompt or engine payload.
Send it in the `Authorization: Bearer <key>` header on `/api/*` requests. For example:
The key works only over HTTPS or a local connection; `tailscale serve` must expose an HTTPS target when used with it.

```sh
curl -H "Authorization: Bearer $(cat ~/.config/projectman/integrator-key)" http://localhost:4800/api/projects
```

Against a cloud installation (hybrid mode, [HYBRID.md](HYBRID.md)) the request first has to pass
Cloudflare Access, so it carries a second pair of headers: a service token made for the integrator
alone (not the engine's), kept next to the key in `~/.config/projectman/` with mode 600. The key and
the service token are two separate secrets, and the service token alone gets nowhere in
projectman:

```sh
curl \
  -H "CF-Access-Client-Id: $(cat ~/.config/projectman/access-client-id)" \
  -H "CF-Access-Client-Secret: $(cat ~/.config/projectman/access-client-secret)" \
  -H "Authorization: Bearer $(cat ~/.config/projectman/integrator-key)" \
  https://projectman.example.com/api/projects
```

Bearer authentication takes precedence over a login cookie. A revoked or expired key fails with
`integrator_key_invalid`; a replacement immediately revokes the previous key of the same mode.
Read keys cannot write. Super keys act as the project's Operator under the current owner's
membership and the shared mutation policy. Owner-reserved security, deletion and cost effects
remain refused without an exact owner grant. Keys cannot manage keys or authenticate a websocket
connection. Operations retain their integrator attribution and audit after revocation.

## The integrator's MCP endpoint (PM-760)

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
- The member MCP, `/mcp/<token>`, is unchanged: for the agents on the same machine only.

Client configuration (no secret in it; the key is read from the file above when the client starts):

```json
{
  "mcpServers": {
    "projectman": {
      "type": "http",
      "url": "https://projectman.example.com/mcp",
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

Behind a proxy or the Cloudflare tunnel the entrance must pass `/mcp` and refuse `/mcp/` and `/hooks`:

```yaml
ingress:
  - hostname: projectman.example.com
    path: ^/hooks
    service: http_status:404
  - hostname: projectman.example.com
    path: ^/mcp/ # the member door; the slash keeps the bare /mcp open
    service: http_status:404
  - hostname: projectman.example.com
    service: http://127.0.0.1:4800
  - service: http_status:404
```

A reverse proxy does the same: `location = /mcp` goes to the service with `Host` kept and
`X-Forwarded-Proto: https` set; `location ^~ /mcp/` and `location ^~ /hooks` answer `404`. The check
script (`deploy/cloudflare/check.sh`) still expects `/mcp/x` and `/hooks/x` to be `404`; a
`POST /mcp` without a key must be `401` with `integrator_key_invalid`.

## The `projectman` command and the MCP proxy (PM-765)

`projectman` is a thin client of the REST API and the change journal above, and `projectman mcp-proxy` is a
stdio shim for MCP clients that cannot send an HTTP header. Both use the same key, the same rights and the
same audit as the endpoints; the command never decides anything the server does not. It runs on the
integrator's machine only (`npm run projectman -- <command>` in a checkout, or `projectman` once the
package is linked with `npm link`).

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
- `keyFile` is the file of "Integrator access" above. `accessHeadersFile` (cloud only) is the
  integrator's service-token file made by `npm run cloud -- edge` (`CF-Access-Client-Id`,
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
projectman inbox fix-limit ITEM --project PM --option replan|reassign|another_round|to_owner [--note TEXT]   # only the item addressed to the integrator
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

A further owner's client (PM-1063, Claude Desktop with `mcp-proxy`) is set up the same way on that owner's own
machine: their own `super` or `read` key (made in their own login; an owner account with a password may hold
one, and revoking the account revokes the key), their own Access header file (`accessHeadersFile`, see above)
and a `client.json` that names both by path. No secret goes into the MCP client's configuration. The key reaches
only the projects that owner holds; the administration, the machine state and the instance knowledge of the
host are refused with `host_only`, and the machine work in the owner's queue is theirs to do on their own
machine, with their approval.
