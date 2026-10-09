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
  process gets only its own secrets: the server never sees the tunnel token, the storage keys or
  the restic password.
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
- **Cost.** The database replicates every second; the storage is the database (small) plus a daily
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
   - **The engine:** a second application for the path `projectman.example.com/engine/link`, with
     **one Service Auth policy** for the engine's own service token (Access → Service Auth →
     Service Tokens → create). Nothing else may be allowed on that path. Access picks the most
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
refuses a caller without a machine key. Without the service token variables it shows what an
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
- Litestream's replica is not encrypted by Litestream; the bucket's encryption and key scoping are
  your protection.
- A restic backup every 6 hours can lose up to 6 hours of files (attachments, customization) that
  changed since; the database loses about a second.
- The image, the Litestream flags, the restic and Fly.io behaviour described here were written from
  their documentation and could not be built or run where this was written (no container daemon).
  The first deployment is therefore also the test: run the build, the smoke test and the restore
  rehearsal, and fix this guide with what you find.
