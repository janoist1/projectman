# Deployment and operation

The supported installation uses a cloud hub and a Mac engine; see [HYBRID.md](HYBRID.md)
and [AWS.md](AWS.md). This page covers local operation, release watchers and integrator access.

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

## The live instance on a Mac: LaunchAgents and the release watcher (PM-387, PM-493)

The owner's live instance (`~/projectman-live`, data in `~/.projectman`, port 4800) runs under two
LaunchAgents in `~/Library/LaunchAgents`, written by `npm run live`:

- `com.projectman.live` runs `node apps/server/dist/index.js` through a launcher (see "What macOS shows"; not `npm start`, so launchd's SIGTERM
  reaches the server and the stop pauses the team first). `KeepAlive`, `ThrottleInterval 10`, and an
  `ExitTimeOut` of the shutdown pause plus 30 s (90 s by default; it follows `PROJECTMAN_SHUTDOWN_PAUSE_MS`
  of the installing shell). Logs: `~/.projectman/logs/live-server.log`.
- `com.projectman.live-watcher` runs one watcher round every 60 s (`StartInterval`, no `KeepAlive`, so
  never two at once). Logs: `~/.projectman/logs/live-watcher.log`.

**What macOS shows (PM-514).** System Settings → General → Login Items & Extensions → "Allow in the
Background" names a LaunchAgent after the first element of its `ProgramArguments`. The files therefore do
not start `node` but a launcher of the checkout, which runs the command it is given:
`~/projectman-live/scripts/live/bin/projectman-live` (the server) and
`~/projectman-live/scripts/live/bin/projectman-release-watcher` (the watcher; each is `exec "$@"` and
nothing else). The list shows two items, "projectman-live" and "projectman-release-watcher", next to any other
node-based item. The items carry no developer signature, so macOS may still label them "Item from unidentified
developer": that is the label of an unsigned file, not a sign of another program. To check which item is which,
press the (i) button of an item: it shows the plist in Finder (`~/Library/LaunchAgents/com.projectman.live.plist`
or `…live-watcher.plist`); its `ProgramArguments` starts with the launcher and then names node. The launchers
are files of the checkout, so a release brings them along; `npm run live -- status` lists the launcher and
node of each file and exits 1 when one does not exist.

**The node path.** The install writes the stable path of `node`, not `process.execPath`: under Homebrew
that is `/opt/homebrew/Cellar/node/<version>/bin/node`, which a `brew upgrade node` removes, after which the
server would not start (`KeepAlive` does not help). The install takes the first `node` on the installing
shell's `PATH` that is the running binary and has no `Cellar` directory in its name (`/opt/homebrew/bin/node`),
and prints it (`node: …`, with a warning when only a versioned path exists). A file from before this change
starts node itself (it appears as "node" in macOS), and `status` says so: run `npm run live -- install` once
more. After an upgrade that moves node, `status` shows `node: … (MISSING …)` and exits 1; install again.

launchd gives a job no shell environment. The server file therefore carries an allowlist taken from the
shell that runs the install (`PATH`, `HOME`, `PORT`, `PROJECTMAN_HOME`, `PROJECTMAN_RELEASE_TARGET` and, when
set there, the names in `PASSED_VARIABLES` of `scripts/live/plist.ts`). Billing variables, the integrator key
and `PROJECTMAN_VERSION` (which would falsify the commit the watcher compares) are never written. The
install prints the variable names, never the values. Only `PROJECTMAN_MODE=single` is served: a hybrid
installation is refused.

```sh
npm run live -- install [--root ~/projectman-live] [--home ~/.projectman] [--port 4800] [--remote <github url>]
npm run live -- status      # agents, running commit, pause, journal, latest backup, remote, gh login; exit 1 if an agent is not loaded
npm run live -- uninstall   # stops both agents, removes both files; the server stays stopped
```

Run `install` in the checkout's shell session where `git ls-remote <remote>` and `gh auth status` work: the
watcher needs both (it fetches the release commit, pushes the tag and creates the GitHub release). The
remote is `--remote`, or the origin of the live checkout (a local-path origin is followed to its own
origin); it must be a GitHub URL. The install pauses the team, stops a server that runs now (a loaded
agent, or a process on the port that was started by hand), loads both agents, checks that the new server
answers with the checkout's commit and resumes. If it does not come up, the agents are removed and the
pause stays open: start the server by hand and run `npm run control -- resume`. The install and the
uninstall refuse while a release is in progress (a journal exists).

### What a round does

The owner approves a release in the app (PM-491, PM-492). Each round asks `release_next` on the control
socket; with nothing approved, or a pause the owners opened, it does nothing. For an approved release it:

1. claims it (`release_claim`, with the live commit as the previous one) and writes the journal;
2. **fetch** — clones the remote into `~/projectman-live-next`, checks that the commit is on `origin/main`,
   checks it out; **build** — `npm ci`, `npm run build`; **test** — `npm run release-test` through the
   heavy-run queue (`npm run heavy`, up to an hour of waiting): the test files that name
   `process.env.PROJECTMAN_FULL_TEST_SANDBOX === '1'`, which the merge sandbox leaves out, run here with
   the sandbox variables unset; **config_check** — every project in `~/.projectman/customization` loads with
   the new build's loaders. A failure here reports the release failed; the live server was not touched;
3. **pause** (`release <id>`), **stop** (`bootout`), **backup** (`sqlite3 .backup` into
   `~/.projectman/release/backups/db-<time>-<previous commit>.sqlite`, mode 0600, `integrity_check`, the
   newest ten are kept), **switch** (`~/projectman-live` becomes `~/projectman-live-prev-<commit>`, the
   next build takes its place, `bootstrap`), **verify** (up to 2 minutes: the port listens,
   `/api/setup` answers 200, the control socket reports the new commit);
4. on success: resume, `release_report live`, then the **tag** (`vYYYY.M.D`, `.N` for the second release of
   a day, annotated, pushed) and `gh release create --verify-tag`, then `release_report published`. Only the
   two newest `-prev-` and `-failed-` directories are kept (the one just replaced always stays);
5. on a failure from the pause on: the **rollback** puts back the previous build (the new one is kept as
   `~/projectman-live-failed-<commit>`), restores the database from the backup, starts the old server,
   checks its commit, resumes, and reports the release failed with `rolledBack: true`.

Publishing a live release that failed (no network, GitHub refused) is reported as `publish_failed` and
retried at most once an hour; the release stays live meanwhile.

The journal (`~/.projectman/release/journal.json`, mode 0600) records the step before it starts. A round
that was stopped (a reboot, a kill) is continued from it by the next one, and every part of the rollback can be
repeated. Everything the watcher keeps is in `~/.projectman/release/` (journal, lock, backups): the
sessions' sandboxes deny it, as the backups hold all data.

### By hand

- **Back to the previous build** (the new build is live but wrong, and the watcher is not in the middle of a
  release): `launchctl bootout gui/$(id -u)/com.projectman.live`; move `~/projectman-live` aside and
  `~/projectman-live-prev-<commit>` to `~/projectman-live`; if the new build migrated the database, restore the
  newest backup (stop first; remove `db.sqlite-wal` and `-shm`; `cp` the backup to `db.sqlite.tmp`, `chmod 600`,
  `mv` over `db.sqlite`; the older build refuses a database a newer build migrated); `launchctl bootstrap
gui/$(id -u) ~/Library/LaunchAgents/com.projectman.live.plist`; `npm run control -- resume`.
- **An unreadable or unfitting journal**: the watcher logs it every minute and touches nothing. Look at the
  release in the app and at `npm run live -- status`; if the live server runs the old commit and the release is
  `deploying`, delete the journal and the `-next` directory, and the watcher reports the release failed
  ("lost its journal"); if the new commit is live, resume the pause (`npm run control -- resume`), delete the
  journal and the watcher reports it live and publishes it. Deleting the journal is the only thing the
  watcher cannot do for itself.
- **A pause that was left open** (`release <id>` is the watcher's, anything else a person's):
  `npm run control -- resume`.

`switch-live.sh` and `config-dry-run.ts` of the integrator's folder are retired by this: the watcher does
the switch, the backup, the rollback and the configuration check.

## The hybrid release watcher (PM-751, part of PM-735)

In hybrid mode (the board on the EC2 machine, the engine on the Mac) the release is not the watcher above but
`npm run release`, the **hybrid release coordinator**. One release that the owner approved in the app is built and
checked once, then moved to the cloud and to the Mac engine so that both run the same commit, or it ends in a
program rollback that is verified, or in a recovery state that waits for a person. There is no command chain to
run by hand. The owner's approval covers the whole chain and the program rollback; **restoring data is a separate
decision** and the coordinator never does it. It runs only on the administration Mac, from a stable checkout
that is not a member workspace; the cloud and AWS credentials stay in `~/.config/projectman/cloud/`, which no
member session can read.

```
npm run release -- plan      --config <abs-file>   # read-only: what the next round would do
npm run release -- watch     --config <abs-file>   # one round in the foreground
npm run release -- install   --config <abs-file>   # the LaunchAgent: one round a minute
npm run release -- status    --config <abs-file>   # one JSON line, no secrets
npm run release -- uninstall --config <abs-file>   # removes the job, keeps the state
```

The configuration (version 1, mode 0600, under the protected cloud folder) names the controller id (a UUID that
the cloud keeps as the owner of the deployment), the cloud configuration file, the state directory, the expected
AWS account and EC2 instance, the board's https origin, the engine's id (a remote one, never `local`), the engine
home and the folder of the prepared engine releases. A configuration that does not load arms nothing (exit 2).
The AWS account and the instance are checked before every round, and the cloud's own `hybrid` target (PM-752)
must carry the hash of this configuration's target.

### What a round does

1. **claim and prepare.** The next approved release is claimed through the cloud's deployment protocol
   (`release_deploy_begin`, the one place that holds the attempt). The commit is built into one verified image
   and engine package (the preparation check of PM-750); nothing is changed yet, and a failure here ends the
   attempt with the live system untouched.
2. **quiesce and drain.** The cloud pauses the work and the maintenance fence closes; the coordinator takes the
   heavy-run queue lock and waits (up to the drain limit) until the cloud reports no running work. A timeout goes
   back to the previous version.
3. **import and cloud start.** The image reaches the machine over the verified SSH session and the cloud starts
   it; `deploy` stops on the machine's own checks.
4. **verify the cloud.** The cloud must report the new commit and its database schema must be one the engine can
   use; an incompatible schema is `database_incompatible` and a recovery state, never an automatic restore.
5. **the engine.** The engine's service is stopped (`bootout`, then proof that the process is gone: it is
   **never killed**), its plist is saved first, the engine service is installed for the prepared checkout and
   started, and the cloud must see the engine online with the new version. A job that is out of launchd proves
   nothing about its process: after an interrupted stop, the recorded pid and the pid of the status file must be
   gone too (waited for up to 2 minutes), or the attempt stops in `recovery_required` rather than start a second
   engine on the same home. The same holds before the previous engine is loaded again.
6. **live.** The coordinator reports the deployment live, resumes the work, and publishes the tag and the GitHub
   release (`vYYYY.M.D[.N]`, annotated, pushed, `--verify-tag`). A publish that fails is retried by the next
   rounds; the release stays live meanwhile.
7. **rollback.** From the pause on, a refusal, a failed verification or a timeout puts the engine back (the saved
   plist, byte for byte, with its hash checked) and then the cloud (its previous image), verifies both, resumes
   and reports the release failed. If a step cannot be proved, the state is `recovery_required`.

Every step is written in the journal (`<stateDir>/journal.json`, 0600) before it starts, and a round that was
stopped (a reboot, a kill) continues from it; every part of the rollback can be repeated. Only one round runs at
a time (`watch.lock`); a second one exits 2 and changes nothing. A corrupt or unreadable journal counts as an
unfinished release: `install` and `uninstall` refuse, and the watcher touches nothing.

### Exit codes and status

`0` success, or no work (also a live release whose publish is still pending); `1` an operational failure or a
verified rollback; `2` a safety, precondition or recovery refusal (also a bad configuration or another watcher);
`64` a wrong command line. `status` prints `{installed, loaded, running, releaseId, phase, lastError}`;
`lastError` is `{code, message}` with a fixed text from the coordinator's vocabulary, never a raw error, a path or
an answer of the cloud. The same file (`last-error.json`) is cleared by the next successful round.

### The LaunchAgent

`install` writes `~/Library/LaunchAgents/com.projectman.hybrid-release-watcher.plist` for the stable checkout it
runs from (it refuses a member workspace), with this node and `tsx`, the configuration argument and
`StartInterval` 60. The job's environment is `HOME`, `PATH`, `LANG` and `TZ` only: no provider key and no AWS
variable (the AWS profile comes from the cloud configuration). A job that is loaded and the same is `unchanged`; a
different one is booted out first, and nothing is replaced while a round or a journal is active. It is **not** run
by any card: the owner installs it, after the first hybrid release has been rehearsed.

### When it stops

- **`recovery_required`**: the coordinator proved nothing more it may do. Read `npm run release -- status`, the
  release in the app (its deployment shows the phase) and the cloud with `npm run cloud -- release-control`
  (`release_deploy_get`). Decide, as a person, whether the data must be restored (a separate decision with its
  own approval). The coordinator never leaves `recovery_required` by itself and never deletes the journal: while
  it stays, new releases are refused (`release_recovery_required`).
- **A pause that was left open** after an interrupted round belongs to the deployment (`release <id>`); the
  coordinator resumes it when it finishes the attempt. Do not resume it by hand while the journal is active.
- **An engine that does not stop**: the coordinator waits 60 seconds and stops with a fixed code. It does not kill
  the process; find out why it does not exit.

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
[CLOUD-CUTOVER.md](CLOUD-CUTOVER.md) (PM-674). The live watcher above continues to support
single mode only; a hybrid installation is updated by the hybrid release watcher (PM-751, the
section above).

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

The secret is shown once; save it as `~/.config/projectman/integrator-key` on the integrator's
machine, with directory mode 700 and file mode 600. Never put it in a message, task, commit,
member prompt or engine payload.
Send it in the `Authorization: Bearer <key>` header on `/api/*` requests. For example:
The key works only over HTTPS or a local connection; `tailscale serve` must expose an HTTPS target when used with it.

```sh
curl -H "Authorization: Bearer $(cat ~/.config/projectman/integrator-key)" http://localhost:4800/api/me
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
  https://projectman.example.com/api/me
```

Bearer authentication takes precedence over a login cookie. A revoked or expired key fails with
`integrator_key_invalid`; a replacement immediately revokes the previous key. Keys cannot approve
human decisions or approval labels, and cannot manage keys or authenticate a websocket connection.
The owner must give approvals using their own login. Keys also cannot change the rules of
approval labels and gates (including the order, ids and kinds of the stages), owner-only
settings or `maxFixRounds`, manage members (except sending them on leave and calling them back),
set temporary workers, or create or accept invitations; listing and revoking invitations is
allowed. Such a request fails with 403 `owner_login_required` and `details.category`
(`approval_rules`, `owner_settings`, `members`, `invitations`), and nothing is written. Every key operation remains attributed to
the integrator (`via: integrator`), even after revocation.

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
  (hand-offs, `super_operate`, diagnostics, administration status and logs, `relay_owner_answer`); a
  `read` key gets the read tools only; a `legacy` key gets the shared project tools and no super tool. A
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
  `CF-Access-Client-Secret`). A relative path is relative to the configuration file's directory.
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
