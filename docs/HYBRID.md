# Hybrid mode in the cloud (PM-317)

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

- A Cloudflare account with a zone, and Zero Trust (the free plan is enough): the tunnel, and
  Access in front of it ([DEPLOY.md](DEPLOY.md), "Public entry through Cloudflare Tunnel and
  Access", steps 1 to 3, applies as is).
- A container host with a **persistent volume** and no public port needed. This guide uses Fly.io
  (`deploy/cloud/fly.toml`); any host that runs a container with one writable volume works.
- Two S3-compatible buckets (or one bucket, two prefixes), for example Cloudflare R2 or Backblaze B2.
  Prefer two buckets with two keys: the key that replicates the database should not be able to
  touch the backup repository, and the other way round.
- **Protected accounts.** Whoever controls the hosting account, the storage account or the
  Cloudflare account controls the installation (the Cloudflare account can change the Access
  policy, the host account can read the volume and the secrets, the storage account holds the
  backups). Protect all three with a **passkey or a hardware security key** (not only a password
  and an SMS code), keep the Cloudflare Access session short, and give only the owner access to
  these accounts.
- **Cost.** On Fly.io about 5 to 10 USD a month: one `shared-cpu-1x` machine with 1 GB of memory, a
  1 GB volume, and the outbound traffic of a team-sized installation. The Cloudflare free plan
  (Zero Trust up to 50 users) and a bucket of a few megabytes (R2 has a free tier) add little or
  nothing. Check the providers' current prices; the figures here are an estimate.

## The image

`deploy/cloud/Dockerfile` builds from the repository root:

```sh
docker build -f deploy/cloud/Dockerfile --build-arg PROJECTMAN_VERSION=$(git rev-parse --short HEAD) -t projectman-cloud .
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

Plain settings (in `fly.toml` `[env]`, or the host's environment):

| Variable                                                        | Meaning                                                                                                  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_REGION` | The bucket of the database replica (`projectman/db/` inside it)                                          |
| `RESTIC_REPOSITORY`                                             | The restic repository, for example `s3:https://<endpoint>/<bucket>/projectman`                           |
| `RESTIC_REGION`                                                 | The restic bucket's region (optional; `auto` for R2)                                                     |
| `BACKUP_INTERVAL_SECONDS`, `BACKUP_FIRST_DELAY_SECONDS`         | The restic backup every 6 hours (21600), the first one 5 minutes after the start (300)                   |
| `LOG_LEVEL`, other `PROJECTMAN_*`                               | Passed to the server (`PROJECTMAN_SHUTDOWN_PAUSE_MS` for example); `HOST`, `PORT` and the mode are fixed |

Secrets (the host's secret store, never a file in the repository, never a message or a task):

| Secret                                                     | Meaning                                                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TUNNEL_TOKEN`                                             | The Cloudflare tunnel's token                                                                                                                                     |
| `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY` | A storage key that can read and write the database bucket only                                                                                                    |
| `RESTIC_ACCESS_KEY_ID`, `RESTIC_SECRET_ACCESS_KEY`         | A storage key that can read and write the backup bucket only                                                                                                      |
| `RESTIC_PASSWORD`                                          | The backup repository's password: separate from the storage key, and **kept outside the cloud as well** (a password manager); without it the backup is unreadable |

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
  machine, a rehearsal started carelessly) writes a diverging history. `fly scale count 1`, and use
  the rehearsal command below, which never replicates.

## Deploy on Fly.io

```sh
fly launch --no-deploy --copy-config --config deploy/cloud/fly.toml    # sets the app name
fly volumes create projectman_data --size 1 --region <region>
fly secrets set TUNNEL_TOKEN=… LITESTREAM_ACCESS_KEY_ID=… LITESTREAM_SECRET_ACCESS_KEY=… \
  RESTIC_ACCESS_KEY_ID=… RESTIC_SECRET_ACCESS_KEY=… RESTIC_PASSWORD=…
fly deploy --config deploy/cloud/fly.toml
fly scale count 1
fly logs
```

Run these from the repository root (the build context is the working directory). Edit `app`,
`primary_region` and the plain `[env]` values in a copy of `fly.toml` first. `fly.toml` has **no
`http_service`**: the app has no public address; if you add one by hand, the tunnel and Access are
bypassed.

Another host: build the image, mount a volume at `/data`, set the same variables, run it as the
image's default command.

## The Cloudflare tunnel and Access

The image runs a **token-managed** tunnel (`cloudflared tunnel run` with `TUNNEL_TOKEN`): the
ingress is set in the Cloudflare dashboard, not in a config file as in the PM-200 guide on the Mac.

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

## First setup, remotely

A new installation has no owner. From a browser through the tunnel the server cannot tell you from
a stranger, so the first setup needs a **one-time setup code**:

1. Start the container and read the log: `fly logs`. It prints, once per start while there is no
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
3. `pbpaste | npm run engine -- init --cloud https://projectman.example.com --id eng_… --name "My Mac"`
   (the machine key from the clipboard goes in on standard input), then add
   `"linkHeadersFile": "/Users/<you>/.config/projectman/access-token.json"` to the engine's
   `engine.json` in the engine home.
4. `npm run engine -- project set <KEY> <path>`, then `npm run engine -- start`. The web app's
   engine button turns to connected.

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

| What                                                                                                                 | By         | How often                                          |
| -------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------- |
| `db.sqlite` (all boards, accounts, key hashes)                                                                       | Litestream | continuously (every second); a snapshot a day      |
| `secret` (the cookie signing key), `secrets/`, `customization/` with `.git`, `attachments/`, memory, `instance.json` | restic     | every 6 hours, 7 daily / 4 weekly / 6 monthly kept |
| `logs/`, `browsers/`                                                                                                 | nobody     | (not worth keeping)                                |

The database and the files belong together (the database holds the attachments' names, the files
their content): restore both, from the same time if you can choose.

### Restoring on a new volume

A fresh volume restores itself at the container's start: the entrypoint restores the files from
restic and then the database from the replica, and **stops the start on any error** except "there
is no replica / repository yet" (a brand new installation). An empty server beside a backup that
could not be read would replicate over it, so it refuses to start instead. To restore after losing
the host, deploy as above with the same secrets (and the `RESTIC_PASSWORD` from your password
manager), on a new volume. Logins survive (the `secret` is restored).

Never run a restored copy beside the original: one container replicates into one replica
([DEPLOY.md](DEPLOY.md), the `instance.json` paragraph). Stop the old one first.

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

Restore the database alone to a file, to look at it (point-in-time with `-timestamp`):

```sh
litestream restore -config deploy/cloud/litestream.yml -o ./restored.sqlite /data/db.sqlite
```

## Updating

Build the new image and deploy it (`fly deploy`). The platform sends SIGTERM; the entrypoint stops
the tunnel, the server (its own shutdown pause) and then Litestream, so the last writes are
shipped, and the new container comes up on the same volume. The engine reconnects by itself.
A database migration of a newer build is refused by an older one: do not roll back across a
migration, restore instead.

## Taking it down

Delete the Access applications, the tunnel and its DNS record; revoke the service tokens; destroy
the app and the volume; then delete the two buckets (or keep the restic one if you may want the
data). Revoke the machine key in Settings → Engines first, if the cloud is still reachable.

## What is not covered, and what was not verified

- The cloud runs one machine. High availability, a read replica and several regions are not
  provided.
- **No control socket client and no migration tools in the container.** The image holds the
  server only: no `scripts/control` (pause, status), no `scripts/migrate` (instance activation,
  marking a home standby or active) and no development dependencies. Pause and stop go through the
  platform (SIGTERM, the server's own shutdown pause). The changeover from the single-machine mode
  to the hybrid and back is the Mac's `npm run migrate -- hybrid …` (PM-318, the second part of
  this page); it makes and reads the data directory outside the container. Do not expect
  `npm run control` or `npm run migrate` in `fly ssh console`.
- Litestream's replica is not encrypted by Litestream; the bucket's encryption and key scoping are
  your protection.
- A restic backup every 6 hours can lose up to 6 hours of files (attachments, customization) that
  changed since; the database loses about a second.
- The image, the Litestream flags, the restic and Fly.io behaviour described here were written from
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

The tool is `npm run migrate -- …` ([MIGRATION.md](MIGRATION.md) has the general rules: the source is only
read, a package is a secret, only one copy works). The engine's own commands are `npm run engine -- …`.

## What goes where

| On the Mac (the home keeps them)                                        | In the cloud package (`hybrid package`)                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `engine.key` (the machine key), `engine.json` (the engine's config)     | `db.sqlite` (a consistent copy), `secret` (the cookie key)      |
| `providers/` (the CLIs' logins and conversation directories)            | `secrets/`, `customization/`, `attachments/`, `memory/`         |
| repositories, `workspaces/`, `worktrees/`, `member-caches/`, `browsers` | the engine's row (only the **hash** of the key) in the database |
| `github-publish/`, `spool/`, `logs/`, `instance.json`                   |                                                                 |

The package holds exactly the six entries on the right and nothing else; the list is
`HYBRID_CLOUD_ENTRIES` in `scripts/migrate/hybrid-entries.ts`, and `verify --hybrid-cloud` refuses a
package that holds anything more (`forbidden_entry`). No CLI login, no repository, no key travels.
The machine key is made on the Mac, written to `engine.key` (mode 0600) and shown nowhere; the cloud
learns only its SHA-256 hash.

## 1. The plan sheet (read-only)

```sh
npm run migrate -- hybrid plan --home ~/.projectman
```

Prints what goes to the cloud, what stays, the engine configuration it would write (projects, the
repositories inside their workspaces, their full-test commands) and the findings: a missing workspace,
a repository outside its workspace, an over-long test command (dropped with a warning) and the
blockers of the inventory (a running server, an unreadable database). It changes nothing.

## 2. Dry run on a copy

Rehearse on a **copy** of the stopped home (never on the running live instance), with the cloud
build started on the package in a disposable place:

1. Copy the stopped home to a scratch directory (`cp -R`), run `hybrid package` on the copy.
2. `npm run migrate -- verify --home <out>/home --hybrid-cloud`.
3. Start the cloud build on `<out>/home` (as in PM-317's deployment page) and sign in.
4. Connect the engine from the copy's home: `PROJECTMAN_HOME=<copy> npm run engine -- start`.

What a rehearsal proves: the package is whole, the cloud opens it, the engine connects and its
sessions are listed. **What it does not prove:** that a session which was running at the cutover
resumes. The package is made from a stopped source, so no session is running in it; the first sessions
after the cutover are new starts or resumes from the CLIs' own conversation directories on the Mac.

## 3. The cutover

1. Pause the team ([DEPLOY.md](DEPLOY.md) "Pausing the team") and stop the live instance. `hybrid
package` refuses a running server (`database_in_use`).
2. Make the package. It writes `engine.key` and `engine.json` into the Mac's home, last, and refuses to
   overwrite either:

   ```sh
   npm run migrate -- hybrid package --home ~/.projectman --out ~/hybrid-package \
     --engine-name "Mac" --cloud https://<the cloud's address>
   ```

   `--out` is a new directory outside the home and outside any git repository (mode 0700). The
   cloud address must be `https://` (`http://` only on a loopback host).

3. Check it: `npm run migrate -- verify --home ~/hybrid-package/home --hybrid-cloud` (one non-revoked
   default engine, every session on a known engine, nothing from the never-carried list).
4. Put **only** `~/hybrid-package/home/` on the cloud's data volume and start the cloud build on it.
   Never put the package in a repository, a task attachment or a message.
5. Retire the Mac's single-machine role and mark the home as the engine's:

   ```sh
   npm run migrate -- instance engine --home ~/.projectman --reason "hybrid mode"
   ```

   The home's `instance.json` now says `engine`: a single-machine or cloud server refuses to start on
   it, while the engine may (its `home_in_use` check allows the stale database of an `engine` home;
   sandboxes keep every session out of it). The engine, in turn, refuses a home that holds a database
   and is not marked `engine`.

6. Start the engine, in the foreground first: `npm run engine -- status`, `npm run engine -- start`.
   Then let launchd keep it running.

## 4. The engine as a service (launchd)

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
- After a `git pull` in that checkout, restart it: `npm run engine -- service install` again.

## 5. The way back

For when the owner wants the single-machine mode again.

1. Pause the team in the cloud and stop the cloud build, so its data is final.
2. Stop the engine: `npm run engine -- service uninstall` (and stop a foreground one).
3. Copy the cloud's data directory to the Mac (a new place, not inside the home), then:

   ```sh
   npm run migrate -- hybrid back --home ~/.projectman --from <the copy> --confirm-source-retired
   ```

   `--confirm-source-retired` is the person's statement that the cloud is stopped. The tool verifies
   the copy, stages it inside the home, revokes this engine in the copied database, makes its sessions
   local again, and **moves the former entries to `pre-hybrid-YYYY-MM-DD/`** instead of deleting them.
   It refuses while the engine runs, when a session is open on another engine, or when the copy is not
   the cloud's data.

4. `npm run migrate -- instance activate --home ~/.projectman --confirm-source-retired`, then start the
   single-machine mode as before. Activating from the `engine` role needs a database that holds the
   cloud's engine row, so that the old pre-hybrid database does not replace the cloud's later work;
   `--discard-cloud-data` states the opposite on purpose.

Sessions the cloud left open are not closed by the move (the tool reports their number); the first
start resumes or ends them as after any restart.

## Not decided here

The real cutover date, the cloud address and the rehearsal's evidence are the owner's. Nothing in this
repository has run the cutover.
