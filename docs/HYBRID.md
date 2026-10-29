# Hybrid mode in the cloud (PM-317)

For the ARM EC2 target, [AWS.md](AWS.md#prebuilt-arm-images-pm-718) describes the
PM-718 image bundle (arm64 only since PM-1116). Build it on a separate administration/builder machine at the same
accepted full SHA as the Mac engine. EC2 imports the arm64 archive over SSH/SSM
and starts the verified immutable image ID; it never builds on the machine. AWS/registry credentials
do not cross to the engine. A deploy requires the bundle (`deployment.imageBundle`) and refuses one built
from another commit than the one being deployed.
The image revision LABEL, version ENV, archive hash and ID are recorded with each PM-675 round.
No engine protocol or repository migration changes. An older image does not reverse database
migrations; recovery approval still applies.

The hybrid mode splits projectman in two: the **cloud** keeps the board, the database, the
accounts and the secrets, and is reachable from anywhere; the **engine** on your Mac runs the AI
sessions, the git checkouts and the tests, and connects to the cloud over an outbound link
(ARCHITECTURE.md, "Machine-dependent parts": "Cloud composition" and "Cloud deployment and backup").
This guide is the cloud side: a container image with the Cloudflare tunnel inside, where the data
lives, how the first setup works from a browser, how it is backed up and restored, and how the
engine connects.

```
 browser / integrator ──► Cloudflare edge (Access) ──► tunnel ──► container ─ server (127.0.0.1:4700)
 engine (your Mac)    ──► Cloudflare edge (Access) ──► tunnel ──►           ├ Litestream ─► bucket (database)
                                                                            └ restic     ─► bucket (the rest)
```

Nothing listens on a public address. The container opens one outbound connection (the tunnel) and
two to the storage. The single-machine installation ([DEPLOY.md](DEPLOY.md)) is unchanged and is
not touched by anything here.

## What you need

When upgrading to session process scopes (PM-698), update the cloud hub before the engines.
Protocol version remains 1 and the new hub accepts engines without `processScope`, `scopeId` or
exit `cleanup`; their cleanup remains unverified and uses the existing process probe. New engines
send these additive fields and `scope_recovered`, which an older hub's strict schema rejects.
Process inspection, signals and recovery always run on the owning engine, including during a link
outage; buffered exit results are delivered after reconnect. `process_group` means best effort,
not contained execution (PM-701).

- A Cloudflare account with a zone, and Zero Trust (the free plan is enough): the tunnel, and
  Access in front of it (see [AWS.md, Cloudflare](AWS.md#cloudflare) and
  [the tunnel and Access setup below](#the-cloudflare-tunnel-and-access)).
- A container host with a **persistent volume** and no public port needed: the EC2 machine of
  [docs/AWS.md](AWS.md), or any host that runs a container with one writable volume.
- Two S3-compatible buckets (or one bucket, two prefixes), for example Cloudflare R2 or Backblaze B2.
  Prefer two buckets with two keys: the key that replicates the database should not be able to
  touch the backup repository, and the other way round.
- **Protected accounts.** Whoever controls the hosting account, the storage account or the
  Cloudflare account controls the installation (the Cloudflare account can change the Access
  policy, the host account can read the volume and the secrets, the storage account holds the
  backups). Protect all three with a **passkey or a hardware security key** (not only a password
  and an SMS code), keep the Cloudflare Access session short, and give only the owner access to
  these accounts.
- **Cost.** About 5 to 10 USD a month on a small container host: one machine with 1 GB of memory, a
  1 GB volume, and the outbound traffic of a team-sized installation. The Cloudflare free plan
  (Zero Trust up to 50 users) and a bucket of a few megabytes (R2 has a free tier) add little or
  nothing. Check the providers' current prices; the figures here are an estimate.

## The image

`deploy/cloud/Dockerfile` builds from the repository root:

```sh
docker build -f deploy/cloud/Dockerfile --build-arg PROJECTMAN_VERSION=$(git rev-parse HEAD) -t projectman-cloud .
```

- **In it:** the server and the web app (`npm run build`, production dependencies only), `git` (the
  customization repository needs it), `cloudflared`, `litestream`, `restic`, `tini`, `curl`.
- **Not in it:** the `claude`, `codex` and `gh` CLIs and any browser. The cloud runs no AI session; a
  project cannot start AI work until an engine is connected.
- **Who runs it:** the entrypoint starts as root only to hand the mounted volume to the `projectman`
  user (uid 10001) and then drops all privileges (`setpriv --no-new-privs`). The server listens on
  `127.0.0.1:4700` only.
- **Processes:** the server, Litestream, `cloudflared` (started once the server answers) and a restic
  loop. If one exits, the container stops the others and exits, and the host restarts it. Each
  process is started in a cleared environment (`env -i`) with only its own variables, so the
  server's environment holds no tunnel token, storage key or restic password. **This filters the
  environment only; it does not protect against a compromised server.** All processes run as the
  same user (uid 10001), so a server with a code-execution hole can read
  `/proc/<pid>/environ` of the tunnel, Litestream and restic processes, and so reach the tunnel
  token, the storage keys and the restic password, and could delete or read the backups. Real
  separation would need the server under its own uid; that is not done. Limit the damage with
  the bucket-scoped keys (no access to other buckets), the `RESTIC_PASSWORD` kept outside the
  host, and a restore rehearsal now and then.
- **Data:** `PROJECTMAN_HOME=/data`, the volume.

### Settings

Plain settings (in the host's environment):

| Variable                                                        | Meaning                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_REGION` | The bucket of the database replica (`projectman/db/` inside it)                                          |
| `RESTIC_REPOSITORY`                                             | The restic repository, for example `s3:https://<endpoint>/<bucket>/projectman`                           |
| `RESTIC_REGION`                                                 | The restic bucket's region (optional; `auto` for R2)                                                     |
| `BACKUP_INTERVAL_SECONDS`, `BACKUP_FIRST_DELAY_SECONDS`         | The restic backup every 6 hours (21600), the first one 5 minutes after the start (300)                   |
| `PROJECTMAN_HEAP_LIMIT_MB`                                      | The server's V8 old-space limit (below); the image sets 256; empty keeps node's default                  |
| `PROJECTMAN_MEMORY_LOG_SECONDS`                                 | A `memory` log line every n seconds (below); the image sets 600; 0 is off                                |
| `LOG_LEVEL`, other `PROJECTMAN_*`                               | Passed to the server (`PROJECTMAN_SHUTDOWN_PAUSE_MS` for example); `HOST`, `PORT` and the mode are fixed |

**Memory settings (PM-775, part of PM-772).**

- `PROJECTMAN_HEAP_LIMIT_MB` is read by the entrypoint, not by the server: a whole number from 128 to
  4096 becomes `node --max-old-space-size=<n>`; empty or unset leaves node's default, which is
  computed from the machine's memory (about 450 MB on the 904 MB machine, so garbage is collected only
  near that line). Any other value stops the container before anything starts (exit 64).
- **Crash diagnostics (PM-1105), opt-in.** With `PROJECTMAN_HEAP_SNAPSHOT=1` (read by the entrypoint; empty,
  unset or `0` is off, any other value stops the container with exit 64) the entrypoint adds
  `--report-on-fatalerror` and `--heapsnapshot-near-heap-limit=1`, writing into `<home>/diagnostics`
  (`/data/diagnostics`, on the data volume): node's JSON report of a fatal error (an out-of-memory crash
  included) and at most one heap snapshot per server process as the heap nears its limit. Each start deletes
  all but the newest earlier snapshot, so the volume holds at most two. The directory is not backed up (a
  snapshot holds board data and the process's secrets; `backup.sh` excludes it), so copy a snapshot off the
  volume only to a place you trust, read it with `deploy/cloud/heap-summary.mjs` and delete it. Writing a
  snapshot needs memory beside the heap; if the machine runs short, the snapshot is lost, not the data.
  Turn it on in `cloud.env` after an out-of-memory restart you cannot explain, and off again after.
- The cloud server starts without the local history embedding (`PROJECTMAN_HISTORY_SEMANTIC` defaults to
  `off` in `PROJECTMAN_MODE=cloud`, PM-1105): its model and backfill would take about 350 MiB of native memory
  the heap sizing does not count. Setting `on` explicitly turns it back on, as the [semantic
  profile](#history-semantic-profile) needs.
- `PROJECTMAN_MEMORY_LOG_SECONDS` is read by the server (cloud and single mode): 0 (the default) is
  off, otherwise 60 to 86400 seconds; any other value stops the start with a `projectman:` message.
  Each line is `memory` with `rssMb`, `heapUsedMb`, `heapTotalMb`, `externalMb`, `arrayBuffersMb`,
  `heapLimitMb` and `uptimeS`, in whole megabytes, in `<home>/logs/server.log` and on the terminal.
- **Sizing rule.** `ceiling = ceil32(2 × the largest live heap under load)`, rounded up to 32 MB, from a
  [memory profile](#memory-profile). If `ceiling + the fixed cost (the report's RSS outside the heap) +
about 200 MB for the other processes` is at most about 800 MB on the 904 MB machine, the image
  carries that ceiling. If it is more, do not squeeze: propose the next machine size, size the ceiling
  for it, and let the owner decide.
- **The image's value (256).** The PM-773 baseline measured a live heap of about 65 MB with no growth
  (63.9 MB at the start, 64.9 MB after an hour), without request load. The rule gives 160 MB; 256 MB
  leaves four times the idle live heap until a loaded measurement exists. The fixed cost was 640 to
  660 MB, so 160 + 650 + 200 is about 1010 MB: it does not fit the 904 MB machine (the cloud's own
  reading was RSS 342 MB plus 417 MB of swap), and the card proposes the 2 GB t4g.small instead. The
  heap limit does not shrink that native part: a lower limit ended within 12 MB of node's default.
- `MALLOC_ARENA_MAX=2` is not set: the baseline run with it ended 14 MB above the run with the lower
  heap limit (722.9 against 708.6 MB), short of the 20 MB gain that would justify it. If it is ever
  added, it also goes into the entrypoint's `load_env server_env` list, because `env -i` drops it.
- **Health check.** The image's `HEALTHCHECK` is a `curl` of `/api/setup` every 30 seconds
  (`-fsS --max-time 5`); curl is in the image, while the former `node -e fetch(...)` started a node
  process (about 35 MB and CPU time) on every check.

Secrets (the host's secret store, never a file in the repository, never a message or a task):

| Secret                                                                                              | Meaning                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TUNNEL_TOKEN`                                                                                      | The Cloudflare tunnel's token                                                                                                                                                           |
| `PROJECTMAN_SES_ACCESS_KEY_ID`, `PROJECTMAN_SES_SECRET_ACCESS_KEY` (`PROJECTMAN_SES_SESSION_TOKEN`) | The sending-only key of the e-mail login code mailer (PM-669, [AWS.md](AWS.md)); needed only with `PROJECTMAN_EMAIL_LOGIN_ENABLED=1` and `PROJECTMAN_SES_REGION`, `PROJECTMAN_SES_FROM` |
| `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`                                          | A storage key that can read and write the database bucket only                                                                                                                          |
| `RESTIC_ACCESS_KEY_ID`, `RESTIC_SECRET_ACCESS_KEY`                                                  | A storage key that can read and write the backup bucket only                                                                                                                            |
| `RESTIC_PASSWORD`                                                                                   | The backup repository's password: separate from the storage key, and **kept outside the cloud as well** (a password manager); without it the backup is unreadable                       |

Keep the `RESTIC_PASSWORD` somewhere other than the host that runs the container: a restore after
losing the host needs it.

## Storage guide

- **Create the buckets private**, with the provider's encryption at rest on. The Litestream replica
  is the SQLite database itself and Litestream does not encrypt it: it holds the password hashes,
  the machine-key hashes and every task text. The restic repository is encrypted by restic with
  `RESTIC_PASSWORD`.
- **One key per job, bucket-scoped.** On R2 and B2 an API token can be limited to a bucket; do that.
  The restic key needs list, read, write and delete (restic prunes); the Litestream key needs the
  same for its prefix.
- **Storage size.** The database replicates every second; the storage is the database (small) plus a daily
  snapshot kept for a week and the restic snapshots (daily for a week, weekly for a month, monthly
  for half a year). For a team-sized installation this is megabytes.
- **Versioning.** Do not turn on bucket versioning for the Litestream prefix: Litestream manages
  its own history and versioning only doubles the storage.
- **Only one writer.** Exactly one container replicates into a replica. A second one (a duplicate
  machine, a rehearsal started carelessly) writes a diverging history. Run exactly one container, and use
  the rehearsal command below, which never replicates.

## Deploy on another host

On EC2, `npm run cloud` does this ([AWS.md](AWS.md)). On another host: build the image, mount a volume
at `/data`, set the same variables, publish no port (the app has no public address; if you add one by
hand, the tunnel and Access are bypassed), and run it as the image's default command.

## The Cloudflare tunnel and Access

The image runs a **token-managed** tunnel (`cloudflared tunnel run` with `TUNNEL_TOKEN`): the
ingress is set in the Cloudflare dashboard or through `npm run cloud -- edge`
([AWS.md, Cloudflare](AWS.md#cloudflare)).

For SES email login, the owner runs `npm run cloud -- ses plan`, then `ses configure --dry-run`
and a separately approved `ses configure`; `ses request-production --dry-run` and its approved live request
are a separate step. Wait for `ses check` before approving deploy. These commands use the AWS profile
`ses.profile` (absent: `aws.profile`; PM-729 sets `i`, so the domain and its mail stay in one account while
the server stays in `aroom`) and the explicit `ses.region`, the existing Cloudflare DNS and a protected
sending-only key in `cloud.env`. `up` does not run them. See [AWS.md](AWS.md) for config,
previews, IAM scope and partial-failure recovery. The Mac engine receives no SES/AWS credentials, and no
engine protocol change is needed. An AI sandbox never reads `~/.aws` or runs live provisioning.

**On EC2 ([docs/AWS.md](AWS.md)) none of the steps below is done by hand:** `npm run cloud -- edge`
makes the tunnel, its ingress (with the `/hooks` and `/mcp` 404 rules and the audience check), the
Access applications, policies and service tokens, and writes `TUNNEL_TOKEN` to `cloud.env`;
`npm run cloud -- publish` makes the DNS record and `check` verifies the result. The list below is
what those commands do, for another host and for reading. With `access.boardMode: public`
(PM-672, [AWS.md](AWS.md) "The public board") the main name has no Access application login and the
board's own e-mail login is the boundary, while `/engine` keeps its own application. With an integrator
service token, public mode requires an explicit separate `cloudflare.integratorHostname` (PM-675).
Its Service Auth application and tunnel ingress accept only `/api/...` and exact `/mcp`, with their own
audience. The hub's `PROJECTMAN_INTEGRATOR_HOSTNAME` guard refuses board bearer authentication and
machine cookie-only authentication even in private staging. Move the existing client's origin after
that staged deploy and check; the Mac engine's address, token and machine key stay unchanged.
EC2 host operations use SSH
through SSM with no inbound port; `cloud.env` and hybrid data travel only through encrypted SSH
stdin/streams. The owner needs AWS CLI v2, session-manager-plugin and OpenSSH. The container,
one-writer pull guard and restore procedure are unchanged; see the EC2 live rehearsal in
[AWS.md](AWS.md#ownerintegrator-live-rehearsal). This administration link is independent of the
Mac engine's outbound connection.

The one-off `seed` (the first upload of the Mac's data) is retired (PM-1116): the cloud is already seeded.
The commit before the retirement is tagged `retired-migrate-dns`. `pull-data` stays; see
[AWS.md](AWS.md#pull-data).

1. Zero Trust → Networks → Tunnels → create a tunnel, choose Docker, and copy the **token** only
   (it becomes `TUNNEL_TOKEN`).
2. Add a public hostname, for example `projectman.example.com`, with the service
   `http://127.0.0.1:4700`. **Do not set an HTTP Host header override** ("HTTP Host Header" under
   additional settings stays empty): the server treats a loopback Host as a local request, and a
   remote request must never look local. No origin-server-name or No-TLS-verify options are needed
   for `http`.
3. Add the Access applications (Zero Trust → Access → Applications → self-hosted), same hostname:
   - **Browsers and the integrator:** the whole hostname; policy **Allow** for the owner's and the
     members' exact email addresses (and, for the integrator, a **Service Auth** policy for its own
     service token).
   - **The engine:** a second application for the path `projectman.example.com/engine` (it covers
     every `/engine/*` path: `/engine/link` and the file transfers `/engine/files/uploads/…` and
     `/engine/files/downloads/…`, which the engine calls with the same headers), with **one
     Service Auth policy** for the engine's own service token (Access → Service Auth → Service
     Tokens → create). Nothing else may be allowed on that path, and the engine's token must not
     be added to the whole-hostname application: it would reach `/api` too. Access picks the most
     specific application for a path.
4. Cloudflare sets the real client address in `cf-connecting-ip`; the image sets
   `PROJECTMAN_CLIENT_IP_HEADER=cf-connecting-ip`, which the server trusts only from the tunnel's
   loopback connection (the login limits count by that address).

Access is the first lock, projectman's login the second: the engine link also needs its own
machine key, and the integrator its bearer key. A service token alone gets nowhere in projectman.

### The marking widget's public hostname (PM-513)

The marking widget on a customer's page cannot pass Access, so it needs a hostname without it
(the security conditions: [SECURITY.md, The widget's public hostname](SECURITY.md#the-widgets-public-hostname-pm-506-pm-513)).
On AWS, `cloudflare.feedbackHostname`, `publish --feedback` and `check` configure and verify it
([AWS.md, Making the name public](AWS.md#making-the-name-public-publish),
[Verification](AWS.md#verification)). For a manually managed token tunnel, use the dashboard:

1. Add a **second public hostname**, for example `jelolo.example.com`, with the path `^/feedback/`
   and the service `http://127.0.0.1:4700`. Again **no HTTP Host header override**: the server's
   host guard reads the original `Host`. Add no rule for that hostname without the path: the
   guard answers 404 to everything outside `/feedback/widget.js` and `/feedback/api/v1/*`, and the
   tunnel answers 404 to a hostname with no matching rule.
2. Add **no Access application** for it. The application of step 3 covers `projectman.example.com`
   only, and nothing in this hostname's paths gives access to the application.
3. The server needs `PROJECTMAN_FEEDBACK_PUBLIC_URL=https://jelolo.example.com` (hostname only). The
   image does not set it: whoever installs it gives it as a variable next to the others
   (the host's environment), and a wrong value stops the server at start. Without it
   there is no host guard; do not publish the hostname before the variable is set.

## First setup, remotely

A new installation has no owner. From a browser through the tunnel the server cannot tell you from
a stranger, so the first setup needs a **one-time setup code**:

1. Start the container and read the log (`npm run cloud -- logs` on EC2). It prints, once per start while there is no
   owner: `the first setup needs the setup code XXXX-XXXX-XXXX`.
2. Open `https://projectman.example.com`, pass Access and fill in the setup form: name, email,
   password and the code.
3. The code works once. It is void after 10 wrong tries (all together) and after any restart, and
   a new code is printed at the next start while there is still no owner. Once the owner exists,
   the code is gone and the setup route refuses.

On a restored installation (an owner already exists) no code is created. A request that really is
local (a console on the same machine) needs no code.

## Connecting the engine

On the Mac, with the engine ([ARCHITECTURE.md](ARCHITECTURE.md), "Cloud composition"):

1. In the web app, Settings → Engines (Beállítások → Motorok), add an engine. The machine key
   (`pme_…`) is shown **once**; the engine id is `eng_…`.
2. Create the Access service token for the engine (above) and write its two values as a JSON
   object into a file with mode 600, outside the engine's home and workspaces, for example
   `~/.config/projectman/access-token.json`:
   `{"CF-Access-Client-Id": "<id>.access", "CF-Access-Client-Secret": "<secret>"}`.
3. `pbpaste | npm run engine -- init --cloud https://projectman.example.com --id eng_… --name "My Mac" --link-headers-file ~/.config/projectman/access-token.json`
   (the machine key from the clipboard goes in on standard input). The switch takes an existing
   regular file, resolved against the working directory, and writes its real path into the engine's
   `engine.json`; without it a file set earlier stays, so there is no need to edit `engine.json` by
   hand.
   Optional, for an engine whose owner pays for their own NanoGPT sessions (PM-1068):
   `pbpaste | npm run engine -- nanogpt-key set` (the key goes in on standard input; restart the
   engine to use it; `nanogpt-key clear` removes it). An engine with its own key always uses it and
   never asks the hub for the host owner's key; without one, only the host owner's engines get the
   hub's key, and another owner's engine waits with `nanogpt_key_missing`. An engine with a key
   file announces it in its hello, which an older hub's strict hello check refuses, so update the
   hub first.
4. `npm run engine -- project set <KEY> <path>`, then `npm run engine -- start`. The web app's
   engine button turns to connected. The hub creates a project on an engine before the engine
   holds its folder (the folder check answers `not_held` for a path outside the engine's roots), so
   `project set` can come after the project exists. The engine reports a project in its hello, so a
   running engine learns of the new `project set` only after a restart: run
   `npm run engine -- service install` (it restarts the LaunchAgent) or stop and `start` it again.
   The project's sessions wait with `engine_offline` until then.

A further owner of a multi-owner board (`access.owners`, AWS.md) does not create a token: `npm run cloud -- edge` on the host makes the owner's own engine token and writes
`owners/<id>/engine-access-token.json` in the host's secrets store. The host hands that file to the owner outside projectman, and the owner's engine uses
it as in step 2, with `--link-headers-file` pointing at the received file.

The machine key and the service token are different secrets with different jobs: revoke either
without the other (the key in Settings → Engines, the token in Cloudflare).

## Smoke test

```sh
CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… deploy/cloud/smoke.sh https://projectman.example.com
```

It checks that `/api/setup` answers projectman's JSON through the tunnel and that `/engine/link`
and the engine file routes (`/engine/files/…`) refuse a caller without a machine key. Without the service token variables it shows what an
anonymous caller meets (an Access login page is the right result then, and the first check fails).

## Backup and restore

What is backed up, and by whom:

| What                                                                                                                                                         | By         | How often                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------ |
| `db.sqlite` (all boards, accounts, key hashes)                                                                                                               | Litestream | continuously (every second); a snapshot a day                                              |
| `secret` (the cookie signing key), `secrets/`, `customization/` with `.git`, `attachments/`, `message-attachments/`, `feedback/`, `memory/`, `instance.json` | restic     | every 6 hours; `forget` on every run (7 daily / 4 weekly / 6 monthly kept), `prune` weekly |
| `logs/`, `browsers/`, provider homes, engine credentials, worktrees and transient caches/spools                                                              | nobody     | excluded from restic                                                                       |

The database and the files belong together (the database holds the attachments' names, the files
their content). **These are separate recovery points, not an atomic shared snapshot.** Litestream's
1-second sync interval is not a guaranteed 1-second recovery point. Files can be up to 6 hours
behind the database with the default interval; failed backups extend that window, and before the
first successful backup no files are protected. Retention can make an older recovery point farther apart.

Before activating recovered data, record the selected restic snapshot time and Litestream database
time. On an isolated standby copy, enumerate the database's card, message and widget file references;
check every ready attachment exists and its size matches the database's `size` field.
The production `attachments` and `message_attachments` tables do not store content hashes.
For SHA-256 verification, compare restored files against a separately recorded inventory from
the selected backup's source (for example the verified migration package for the first backup).
Also verify cookie secret, customization and memory against that inventory. If no matching
inventory exists, record that content-hash verification could not be performed; file presence
and size alone do not prove byte-for-byte equality. A newer DB can reference uploads
made after the file snapshot. List those missing files and the affected records and time period;
recover them from another verified copy if available. Otherwise select an earlier DB point using
`-timestamp` (see [AWS.md](AWS.md#restoring-the-database-to-a-point-in-time)), restore into another
empty scratch directory and repeat the checks. An earlier DB also loses later cards/messages and
may leave harmless unreferenced files. Record that loss before activation. If no consistent point
is available, recovery remains incomplete; a successful server start does not resolve missing files.

### Restoring on a new volume

A fresh volume restores itself at the container's start: the entrypoint restores the files from
restic and then the database from the replica, and **stops the start on any error** except "there
is no replica / repository yet" (a brand new installation). An empty server beside a backup that
could not be read would replicate over it, so it refuses to start instead. To restore after losing
the host, deploy as above with the same secrets (and the `RESTIC_PASSWORD` from your password
manager), on a new volume. Logins survive (the `secret` is restored).

Never run a restored copy beside the original: one container replicates into one replica
([ARCHITECTURE.md, Instance role and the move](ARCHITECTURE.md#instance-role-and-the-move-pm-143-part-of-pm-135)).
Stop the old one first.

### The restore rehearsal

A backup that has not been restored is a hope. Rehearse after the first deployment and then now and
then (say every quarter). It restores the replica and the latest restic snapshot into a scratch
directory, starts a **standby** server on the loopback (no sessions, no tunnel, **no replication**)
and runs the smoke test against it:

```sh
docker run --rm \
  -e LITESTREAM_BUCKET=… -e LITESTREAM_ENDPOINT=… -e LITESTREAM_REGION=… \
  -e LITESTREAM_ACCESS_KEY_ID=… -e LITESTREAM_SECRET_ACCESS_KEY=… \
  -e RESTIC_REPOSITORY=… -e RESTIC_PASSWORD=… -e RESTIC_ACCESS_KEY_ID=… -e RESTIC_SECRET_ACCESS_KEY=… \
  projectman-cloud rehearse
```

Use **read-only storage keys** for it if your provider allows. It ends with
`REHEARSAL PASSED` or a message saying what failed. It is the same code path as the real restore.
Use an empty scratch directory separate from the cloud home. The success line proves restore and
HTTP smoke checks only; perform the file/reference checks above before calling it a complete recovery.
The automated fake-tool fixture uses a synthetic SQLite `file_references(path, sha256)` table,
not the production attachment schema. It verifies those fixture references and known SHA-256
values for cookie secret, customization, card/message/widget files and memory, plus failure paths
and writer isolation. It does not establish that production attachment rows contain hashes.
It does not prove real S3, restic encryption, Litestream replication or Docker restore: that
operational evidence is required on PM-675, including the first complete file backup and restore.

Restore the database alone to a file, to look at it (point-in-time with `-timestamp`):

```sh
litestream restore -config deploy/cloud/litestream.yml -o ./restored.sqlite /data/db.sqlite
```

A restored database that is put in service (not only looked at) must get a new event generation first,
or the readers of the project change journal (PM-761) could continue cursors from the journal that
was lost: `UPDATE instance_meta SET value = lower(hex(randomblob(16))) WHERE key = 'project_change_generation'`
(`docs/ARCHITECTURE.md`, "Project change journal"). Their cursors are then refused with
`event_cursor_expired`, and they read again from the start.

## Updating

Build the new image and deploy it (`npm run cloud -- deploy` on EC2). The platform sends SIGTERM; the entrypoint stops
the tunnel, the server (its own shutdown pause) and then Litestream, so the last writes are
shipped, and the new container comes up on the same volume. The engine reconnects by itself. Update its checkout to the same approved commit, run
`npm ci`, `npm run build -w @projectman/server`, then `npm run engine -- service install`.
Publish the GitHub release on request with `publish_release` after its preview; see
[DEPLOY.md](DEPLOY.md#release-pm-1113).
A database migration of a newer build is refused by an older one: do not roll back across a
migration, restore instead.

## Taking it down

Delete the Access applications, the tunnel and its DNS record; revoke the service tokens; destroy
the app and the volume; then delete the two buckets (or keep the restic one if you may want the
data). Revoke the machine key in Settings → Engines first, if the cloud is still reachable.

## Memory profile

Three scripts in `deploy/cloud/` (PM-773, part of PM-772) measure what the cloud server keeps in memory
and what is garbage. They have no dependencies, change nothing in the server and touch no engine: they
run on the loopback of a **disposable copy** of a home, with no network. The image does not carry them
(PM-1116): mount `deploy/cloud/` of the repository as a read-only volume (`-v <repo>/deploy/cloud:/tool:ro`).

- `memory-probe.mjs` — a `node --import` preload. Every `PM_MEMORY_PROBE_MS` (5000) it appends one JSON
  line to `PM_MEMORY_PROBE_FILE` (never stdout): `t`, `uptimeS`, `rss`, `heapUsed`, `heapTotal`,
  `external`, `arrayBuffers`, `heapSizeLimit` (bytes) and `cpuUserMs`, `cpuSystemMs` (the process's
  totals from `process.cpuUsage()`, also good for the CPU measurement of PM-733). Its timer is unref'd.
- `memory-profile.mjs` — starts the server as a child (`node --import <probe> --heapsnapshot-signal=SIGUSR2
[--max-old-space-size=<n>] --diagnostic-dir=<out> <server>`) in a cleared environment: `PATH`, `HOME`,
  `TMPDIR`, `PROJECTMAN_HOME=<home>`, `PROJECTMAN_MODE=cloud`, `HOST=127.0.0.1`, `PORT`,
  `NODE_ENV=production`, the two probe variables and the `--env NAME=value` pairs. No tunnel, Litestream,
  restic or engine starts. Phases: `ready` (`GET /api/setup` answers 200, at most 120 s; this gives
  `startupMs`), `start` (60 s later, a heap snapshot), `load` (only with `--login-file`; the sample with
  the highest RSS while it runs), `load-end` (snapshot), then rest until `--duration-min`, with an
  `idle-<minutes>` sample every 10 minutes, and `end` (snapshot); then SIGTERM, and SIGKILL after 60 s.
  RSS, peak and swap come from `/proc/<pid>/status` (`VmRSS`, `VmHWM`, `VmSwap`) on Linux, where the
  peak is reset after each snapshot; on macOS from `ps` (peak and swap are `null`).
- `heap-summary.mjs <snapshot>` — prints `{ liveBytes, nodeCount, byType }` (the top 40 type and
  constructor-name groups by self size). It reads the snapshot as a stream and never prints string
  content. `liveHeapMb` of the report comes from it.

The load (`--login-file`, JSON `{ "email": "...", "password": "..." }`) logs in once (the cookie lives
in memory only), then `--rounds` times asks, for every project, the reads the web app makes
(`/api/me`, `/api/projects`, and per project the board, tasks, inbox, team threads and involvements) and
the 10 cards with the longest description in full, `--concurrency` requests at a time.

Options: `--home <dir> --out <dir> [--server <path>] [--port 4790] [--duration-min 60]
[--heap-limit-mb <n>] [--env NAME=value]... [--login-file <path>] [--rounds 20] [--concurrency 4]`
(`--server` defaults to `/app/apps/server/dist/index.js`). For short test runs there are also
`--start-delay-s` (60), `--idle-every-min` (10), `--ready-timeout-s` (120) and `--probe-ms` (5000).

**It refuses (exit 64, nothing started)** a home without the `<home>/.memory-profile-copy` marker
(create the marker by hand in the copy, never in a live home), an `--out` that exists and is not empty,
and a bad parameter. Never point it at a live home: the server migrates and writes the copy.

In the image (no network, the copy and the output mounted):

```sh
docker run --rm --network none -v <copy>:/data -v <out>:/out [-v <login.json>:/in/login.json:ro] \
  -v <repo>/deploy/cloud:/tool:ro --entrypoint node <image> /tool/memory-profile.mjs \
  --home /data --out /out [--login-file /in/login.json] [--duration-min 60] [--heap-limit-mb <n>] \
  [--env MALLOC_ARENA_MAX=2]
```

(The default heap limit of a machine is `node -p "v8.getHeapStatistics().heap_size_limit"` on it.)

Output under `--out`: `report.json` (shape: `sourceVersion`, `node`, `platform`, `arch`,
`heapSizeLimitMb`, `nodeArgs`, `env` (names only), `startupMs`, `phases[]`, `endpoints[]` with the route
templates), `report.md` (the same for reading, with the top live-heap groups), `probe.jsonl`, `server.log`,
`<phase>.heapsnapshot` and `<phase>.summary.json`.

**The heap snapshots hold real data** (cards, messages, session secrets). They stay on the machine that
ran the profile: not in the repository, not on a card, not in a message. Only `report.md` and the
`*.summary.json` files (types, constructor names and numbers; no keys, titles, addresses or cookies)
may go on a card. The `--out` folder and its files are owner-only; delete the folder and the copy when
done.

How to read it: `rss - liveHeapMb` at a snapshot phase is the garbage and the allocator's free
memory. A snapshot allocates a lot and the process may keep it, so the RSS of the phases after the first
snapshot can include that; `ready` and `start` are read before any snapshot, and the probe lines show
the heap during the load. Compare variants of one run (no limit, `--heap-limit-mb`, `--env MALLOC_ARENA_MAX=2`)
with each other, not with the live container.

### What the RSS is made of (PM-1116)

The RSS of the cloud server is far above its live JavaScript heap (the PM-773 profile read about 65 MB of
live heap against about 650 MB of RSS), so most of the RSS is not live JavaScript objects. What it is
made of (native allocations such as the SQLite page cache, allocator arenas, mapped code) is **not measured
yet**; those are the suspects, not findings. Before a smaller instance is considered, measure the
composition on the running machine, in this order:

1. **`/proc/<pid>/smaps_rollup`** of the server process (`docker exec projectman-cloud sh -c 'cat
/proc/$(pidof node)/smaps_rollup'`): `Rss` is the total, `Pss` the proportional share, `Anonymous` the
   heap and native allocations (the part a smaller instance must hold), `Private_Dirty` what was
   written and cannot be dropped. File-backed `Rss` minus `Anonymous` is the code and mapped files, which
   the kernel can drop under pressure.
2. **The memory log.** Set `PROJECTMAN_MEMORY_LOG_SECONDS=600` in `cloud.env` and read the `memory` lines
   of `npm run cloud -- logs` (`rssMb`, `heapUsedMb`, `heapTotalMb`, `externalMb`, `arrayBuffersMb`,
   `heapLimitMb`, `uptimeS`, every 10 minutes). `rssMb - heapTotalMb - externalMb` is the native remainder;
   its growth over the uptime tells a leak from a plateau.
3. **The profile above**, on a disposable copy, to compare variants (`--heap-limit-mb`,
   `MALLOC_ARENA_MAX=2`).

A smaller instance than the current one is decided only after these readings, together with the owner.

## History semantic profile

`deploy/cloud/history-semantic-profile.mjs` (PM-910, the release check of PM-767) proves, before the cloud
turns the local embedding of `search_history` on, that the server with the embedding fits a 2 GiB ARM64
machine. It reuses the PM-773 tools (`memory-probe.mjs` as the preload, and `buildServerEnv` / `buildNodeArgs`
of `memory-profile.mjs`) and changes nothing in the server's runtime or in any contract. **The cloud stays
`PROJECTMAN_HISTORY_SEMANTIC=off` until a report of this tool passes; turning it on is a separate decision of the
owner.** This tool and its tests set no live environment variable.

```sh
docker run --rm --network none --memory 2g --memory-swap 2g -v <out>:/out -v <fixture.json>:/in/fixture.json:ro \
  -v <repo>/deploy/cloud:/tool:ro --entrypoint node <image> /tool/history-semantic-profile.mjs \
  --server /app/apps/server/dist/history-semantic-profile.js --model-dir /app/apps/server/dist/models/history \
  --fixture /in/fixture.json --out /out/profile [--mixed-seconds 600] [--max-seconds 9000]
```

(`--memory-swap` equal to `--memory` means no swap; the tool refuses a machine where `memory.swap.max` is not 0.
The image runs as uid 10001, so `<out>` must be writable by it.
Set `PROJECTMAN_IMAGE_DIGEST=sha256:<digest>` for the report; `PROJECTMAN_VERSION` is the image's own.)

**What it runs.** The built server, in fresh processes, over a disposable home under `--out` (owner-only) with a
synthetic login. The bundle `dist/history-semantic-profile.js` is the normal server plus one loopback listener with
a one-time secret that calls the same `HistoryService.search` the MCP tool calls (the search has no other entry
without a member's CLI session); `dist/index.js` never loads it. No real member CLI, live token or live instance
is used, and the tool counts any connection to a peer that is not this machine as a failure. A preparation
server in the single-machine mode (a cloud server makes a project only through a connected engine) makes the
owner and project and seeds the fixture, and its text index is built before the copy of the home every run starts
from, so the baseline and the semantic run begin from the same database. Then:

| phase       | what it is                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `off`       | server with `PROJECTMAN_HISTORY_SEMANTIC=off`, at least 60 s of the load below (the baseline)       |
| `cold_load` | server with `on`: process start until the worker's "semantic history search is ready" line          |
| `backfill`  | until the embedding index is complete                                                               |
| `warm`      | three passes of the fixture's questions and negative controls (the recall is read from the first)   |
| `mixed`     | at least 10 minutes (`--mixed-seconds`) of the load, searches and new cards for background indexing |
| `restart`   | a burst of new cards, a SIGKILL while indexing, a restart, the index completes, a question pass     |
| `off_again` | `off` again over the same home, to see what the embedding left behind                               |

The load is the web app's reads in three parallel loops (`/api/me`, projects, board, tasks, inbox, team
threads, involvements), one search every 2 s and three new cards every 10 s; the `off`, `mixed` and `off_again`
phases run the same load. Every phase also takes the process's and the cgroup's memory every 250 ms
(`/proc/<pid>/status`, cgroup v2 `memory.current`, `memory.peak`, `memory.events` `oom_kill`, `memory.swap.current`)
and the event-loop delay from the probe.

**The frame** (outside it the outcome is `fail`, exit 1): the embedding's extra RSS (the highest RSS of the
of `cold_load` to `restart`, minus the baseline's) at most 350 MiB; the server's RSS peak at most 1200 MiB in every
phase; the cgroup peak at most 1536 MiB; no OOM kill and no swap; every question of the `warm` phase
at most 2 s; the control HTTP p95 of the `mixed` phase
at most the baseline's plus max(20 %, 50 ms) (the searches of the `mixed` phase stay in the report, but only the
control HTTP excess judges that phase); at least 15 of 20 questions (in proportion when the fixture has more) with
the target in the top 10 and the
negative controls unchanged; a restart that did not follow an interrupted indexing is `missing_phase`; a fallback to the word search is not a semantic success (`semanticUsed` counts the
searches whose status was `used`). Without the machine (not Linux ARM64, not cgroup v2 with `memory.max` up to
2 GiB and no swap, or no `manifest.json` in the model folder) the tool writes an `unsupported` report and exits 78.
A bad parameter, an unsafe or non-empty `--out` or a bad fixture exits 64 before anything starts.

**A run that fails still reports (PM-931).** Every phase is kept as soon as it is closed, so a failed run lists the
phases it measured. `--max-seconds` (the workflow passes 9000) is the run's own deadline: it ends the server in hand,
adds `deadline_exceeded` and writes the report before the job's limit cuts the container off. A failed report carries
a `failure` block (also a section of `report.md`): the server run it stopped in, how that server ended (`code N`,
`signal S`), the container's cumulative OOM kills and memory, the index progress (chunks, text and semantic dirty
rows), what the open phase had measured, and the warnings the server's log gave for turning the semantic search off
(cause, error code and a short message cut to technical characters). A wait ends at once when the log says the
semantic search turned itself off (it only comes back on a search, and nobody searches during a wait). Long waits
print a line every 30 s with the server's RSS, the container's memory and the index progress.

**The fixture** is a JSON file the owner of the check provides, and its origin is stated in it:
`{ schemaVersion: 1, origin, project: { key }, sources: [{ id, type, title, body, path? }], questions:
[{ question, targetId }] (at least 20, reworded so the words alone do not find the target), negatives:
[{ question }] }`, with source types `task`, `note`, `question`, `message` and `document` (the path is one of
`docs/DECISIONS.md`, `docs/LESSONS.md`). Use a synthetic corpus of about the size of the real history (a copy of
the cloud's history is the better one and stays on the machine, never in a card). Interpretations the tool makes:
_unchanged negative controls_ means no hit of a control got on the list by meaning alone (`matchType` `semantic`);
`eventLoopP95Ms` of a phase is the highest p95 of one probe interval in it; where the kernel cannot reset
`VmHWM` or `memory.peak` (before 6.12) a phase's peak is the highest sample instead, and the report's markdown
says which; the SIGKILL of the `restart` phase waits (up to 300 s) for the embedding to be under way with the text
index done, and when it never gets there the run cannot pass. The network is shut by the network namespace
(`--network none`) and the offline environment of the server; the tool's own count of foreign peers is a second
net that stays almost silent there (a connection fails at once with ENETUNREACH).

**The report** is `report.json` (exactly: `schemaVersion`, `sourceVersion`, `imageDigest`, `platform`, `arch`,
`nodeVersion`, `modelIndexKey`, `memoryLimitBytes`, `swapLimitBytes`, `corpus` (`sources`, `chunks`,
`inputBytes`, `origin`), `phases[]` (`name`, `durationMs`, `rssPeakBytes`, `cgroupPeakBytes`, `swapPeakBytes`,
`oomKills`, `semanticUsed`, `searchP50Ms`, `searchP95Ms`, `searchMaxMs`, `httpP95Ms`, `eventLoopP95Ms`),
`extraRssBytes`, `outcome`, `reasonCodes[]`) and `report.md`. Reason codes: `unsupported_platform`,
`cgroup_unavailable`, `model_unavailable`, `invalid_fixture`, `server_failed`, `missing_phase`,
`memory_budget_exceeded`, `latency_budget_exceeded`, `recall_failed`, `network_attempt`, `oom_detected`. **Only these
two files may go on a card.** `--out` also holds the server logs, the databases and the login, and stays on the
machine; delete it when done. Neither report holds history text, questions, hits, titles, a password, a cookie or a
heap snapshot.

**If a number is out of the frame**, look at the components first (the probe's `rss`, `external` and
`arrayBuffers` per phase; a second tokenizer beside the pipeline's, transient copies at the cold load). A small
fix that keeps the behaviour is allowed, followed by a new measurement. A different model, a new service or a higher
frame is a question for the architect and the owner.

**What the image must have, and what this does not check by itself.** The model is a release asset: the
Dockerfile runs `npm run prepare:history-model` before `npm run build`, which copies it to
`dist/models/history` and the native ONNX Runtime and `sharp` binaries come from the image's own `npm ci` on the
ARM64 build. The single-machine recovery build does not prepare the model, so a build made there
searches by text only. Before the run, confirm that the ARM64 image has `dist/models/history/manifest.json`, that
`node -e "require('onnxruntime-node')"` and the `sqlite-vec` extension load on it, and write the image digest in
`PROJECTMAN_IMAGE_DIGEST`. A model folder without a manifest is `model_unavailable`, not a pass.

**The release run (PM-913).** The GitHub Actions workflow `.github/workflows/history-semantic-profile.yml` does all
of the above on a GitHub-hosted Linux ARM64 runner (`ubuntu-24.04-arm`, free for the public repository); start it
with `gh workflow run history-semantic-profile.yml [-f mixed_seconds=600]`. In order it:

1. builds the cloud release image (`deploy/cloud/Dockerfile`, with `npm run prepare:history-model`) and records the
   image id as `PROJECTMAN_IMAGE_DIGEST` (the image is not pushed, so there is no registry digest) with the commit;
2. runs `deploy/cloud/history-semantic-image-check.mjs` inside the image (`--network none`): the model folder's
   `manifest.json` is valid and every file has its pinned size and SHA-256; the native files of `onnxruntime-node`,
   `sharp`, `sqlite-vec` and `better-sqlite3` for `linux/arm64` are present and are ELF AArch64 (`e_machine` 183);
   all of them load, and `vec_version()` answers. It prints facts only and exits 1 on any failure;
3. makes the synthetic fixture with `deploy/cloud/history-semantic-fixture.mjs` (below);
4. runs the profile with exactly the command above (`--user 10001:10001`, `--network none --memory 2g --memory-swap 2g`);
5. puts `report.md` in the job summary and uploads `report.json` and `report.md` (only these) as the artifact
   `history-semantic-profile-report`; the job fails unless the exit status is 0 (`outcome: pass`).

**The synthetic fixture.** No live history text leaves the owner's machine, so the run uses a seeded synthetic one
(seed 913, the same file every time). Its base is the live history counted on 2026-10-21: 17 955 sources of
about 1 000 characters (1 000 cards, 9 200 team messages, 7 000 task notes, 753 answered questions, the two project
documents) of mixed Hungarian and English filler about everyday product work. The workflow multiplies those counts
(`fixture_scale`, default 2) so the corpus has at least 50 717 chunks, the detailed size of the PM-767 test; the job
fails when the report's `corpus.chunks` is lower, and then the scale is raised. The ~48 000 timeline events of the live
database are mostly not history sources and are not made. The 20 questions are the PM-767 recall set; each target is
a note holding the text of one decision of the public `docs/DECISIONS.md`, and the 5 negative controls are
off-topic. The fixture's `origin` says all this, and it is copied to the report. It tests the memory and the time of
the search at the live size and the recall on the real decisions; it is not a recall measurement on real history
text, which only a copy of the cloud's history on the owner's machine could be.

## What is not covered, and what was not verified

- The cloud runs one machine. High availability, a read replica and several regions are not
  provided.
- **No control socket client and no migration tools in the container.** The image holds the
  server only: no `scripts/control` (pause, status), no `scripts/migrate` (instance activation,
  marking a home standby or active) and no development dependencies. Pause and stop go through the
  platform (SIGTERM, the server's own shutdown pause). The changeover from the single-machine mode
  to the hybrid and back is the Mac's `npm run migrate -- hybrid …` (PM-318, the second part of
  this page); it makes and reads the data directory outside the container. Do not expect
  `npm run control` or `npm run migrate` in a shell on the host.
- Litestream's replica is not encrypted by Litestream; the bucket's encryption and key scoping are
  your protection.
- A restic backup every 6 hours can lose up to 6 hours of files (attachments, customization) that
  changed since; the database loses about a second.
- The image, the Litestream flags, and the restic behaviour described here were written from
  their documentation and could not be built or run where this was written (no container daemon).
  The first deployment is therefore also the test: run the build, the smoke test and the restore
  rehearsal, and fix this guide with what you find.

# Moving between the single-machine mode and the hybrid mode (PM-318, part 8 of 8 of PM-286)

The board runs in the cloud (`PROJECTMAN_MODE=cloud`); the AI work runs on the Mac as an **engine**
(`PROJECTMAN_MODE=engine`), connected outward to the cloud with a machine key
([ARCHITECTURE.md](ARCHITECTURE.md) "Machine-dependent parts"). This page is how the owner's Mac
gets there from the single-machine mode, how it comes back, and what stays where.
**This page is not a permission to move.** The live instance is never stopped, changed or updated by
anything here until the owner has said so for the concrete move.

The tool is `npm run migrate -- …`. The engine's own commands are `npm run engine -- …`.

**The one-off move to the hybrid mode is done and its commands are retired (PM-1116):** `inventory`,
`hybrid plan`, `hybrid package` and the cloud `seed` and `dns plan|import|verify|switch`. What stays is
`verify`, `instance`, `hybrid back`, the cloud's `pull-data` and `dns status`. The last commit that still
has the retired commands is tagged `retired-migrate-dns`; check it out in a separate worktree if a
move has to be done again. The sections below keep what the remaining commands rely on.

For the data-preserving return from EC2 to Mac single,
use [CLOUD-CUTOVER.md](CLOUD-CUTOVER.md) (PM-674).

## What goes where

| On the Mac (the home keeps them)                                        | In the cloud's data                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `engine.key` (the machine key), `engine.json` (the engine's config)     | `db.sqlite` (a consistent copy), `secret` (the cookie key)      |
| `providers/` (the CLIs' logins and conversation directories)            | `secrets/`, `customization/`, `attachments/`, `memory/`         |
|                                                                         | `message-attachments/`, `feedback/` (when the home has them)    |
| repositories, `workspaces/`, `worktrees/`, `member-caches/`, `browsers` | the engine's row (only the **hash** of the key) in the database |
| `github-publish/`, `spool/`, `logs/`, `instance.json`                   |                                                                 |

The cloud's data holds exactly the entries on the right and nothing else (`db.sqlite`, `secret`, `secrets`,
`customization`, `attachments`, `message-attachments`, `feedback`, `memory`; an entry the home does not have
is left out). The way back
(`hybrid back`) moves the Mac's own `message-attachments/` into `pre-hybrid/<date>/` with the other replaced
entries and puts the cloud's in its place, and a failed replacement puts all of them back. The list is
`HYBRID_CLOUD_ENTRIES` in `scripts/migrate/hybrid-entries.ts`, and `verify --hybrid-cloud` refuses a
package that holds anything more (`forbidden_entry`). No CLI login, no repository, no key travels.
The machine key is made on the Mac, written to `engine.key` (mode 0600) and shown nowhere; the cloud
learns only its SHA-256 hash.

## 1. Marking the Mac as the engine

The plan sheet, the dry run on a copy and the package of the cutover are retired (see above). The step
that remains is the role of the Mac's home:

```sh
npm run migrate -- instance engine --home ~/.projectman --reason "hybrid mode"
```

The home's `instance.json` now says `engine`: a single-machine or cloud server refuses to start on
it, while the engine may (its `home_in_use` check allows the stale database of an `engine` home;
sandboxes keep every session out of it). The engine, in turn, refuses a home that holds a database
and is not marked `engine`. Then start the engine, in the foreground first: `npm run engine -- status`,
build with `npm run build -w @projectman/server`, run `npm run engine -- start`,
and let launchd keep it running. Both foreground and service starts run the compiled server.

The cloud's data never travels in a package that sits on the Mac: it holds the cookie key, the secrets
and the whole database, and a session's sandbox only _denies_ named places (the home's own entries,
`~/.ssh` …): any other folder under your user is readable by every AI session on the Mac.

## 2. The engine as a service (launchd)

Run from **the checkout that should run the engine** (the plist names it), on the Mac, as the user who
owns the CLI logins:

```sh
npm run engine -- service install     # writes ~/Library/LaunchAgents/com.projectman.engine.plist, loads it
npm run engine -- service status      # launchd's state and pid; exit 0 only when it runs
npm run engine -- service uninstall   # unloads it and removes the file; the logs stay
```

- It is a LaunchAgent (user `gui` domain), not a daemon: the CLIs need the login keychain.
- The job's environment is only `PATH`, `PROJECTMAN_MODE=engine` and `PROJECTMAN_HOME`. No API key
  and no integrator key is written to the file or passed on.
- `install` checks what `start` checks (configuration, key file, home role) and refuses another
  home's installed agent. The engine restarts after an exit, 30 s apart. Logs:
  `<home>/logs/engine-service.{out,err}.log`.
- The service runs `apps/server/dist/index.js` under Node. Build the checkout with
  `npm run build -w @projectman/server` before installing it. After updating the checkout,
  rebuild it and run `npm run engine -- service install` again.
- `PATH` in the file is the installing shell's, without the `node_modules/.bin` folders that `npm run`
  puts in front of it. If a CLI of the sessions lives elsewhere, start `install` from a shell that
  finds it. A `bootstrap` that fails with "5: Input/output error" while launchd is still tearing the
  old job down is retried a few times.

## 3. The way back

For when the owner wants the single-machine mode again.

1. Pause the team in the cloud and stop the cloud build, so its data is final.
2. Stop the engine and **uninstall its service first**: `npm run engine -- service uninstall` (and stop
   a foreground one). A LaunchAgent that is still installed restarts the engine 30 s after every exit,
   so both `hybrid back` and `instance activate` refuse while its file is in `~/Library/LaunchAgents`.
3. Copy the cloud's data directory to the Mac (a new place, not inside the home), then:

   ```sh
   npm run migrate -- hybrid back --home ~/.projectman --from <the copy> --confirm-source-retired
   ```

   `--confirm-source-retired` is the person's statement that the cloud is stopped. The tool verifies
   the copy, stages it inside the home (`.hybrid-back/`), revokes this engine in the copied database,
   makes its sessions local again, and **moves the former entries to `pre-hybrid/YYYY-MM-DD/`** instead
   of deleting them. It refuses while the engine runs, when a session is open on another engine, or
   when the copy is not the cloud's data.

   The copy may hold what the running cloud writes itself: `logs/` (its server log), Litestream's
   metadata folder next to the database (`.db.sqlite-litestream`), `engine-spool/`, `spool/`, empty
   `worktrees/` and `workspaces/`, and the `instance.json` of a restored copy. None of them is carried
   back. Anything that belongs to the Mac (`providers/`, `engine.key` …) still stops the move.

4. `npm run migrate -- instance activate --home ~/.projectman --confirm-source-retired`, then start the
   single-machine mode as before. Activating from the `engine` role needs a database that holds the
   cloud's engine row, so that the old pre-hybrid database does not replace the cloud's later work;
   `--discard-cloud-data` states the opposite on purpose.
5. **Clean up the secrets after verifying the rollback.** Once the single-machine mode and watcher
   have run well, the owner separately decides when to delete or archive the downloaded copy (`--from`): it holds the
   live cookie key, the secrets and the database, in a folder the sessions' sandboxes do not deny.
   `pre-hybrid/` and `.hybrid-back/` inside the home are denied to every session (they hold the old
   database, the old keys and the former machine key). The owner also decides when to delete
   `pre-hybrid/`; the former machine key in it is revoked in the database already.

Sessions the cloud left open are not closed by the move (the tool reports their number); the first
start resumes or ends them as after any restart.

## Not decided here

The real cutover date, the cloud address and the rehearsal's evidence are the owner's. Nothing in this
repository has run the cutover.
