# The cloud board on AWS Lightsail (PM-532)

This guide sets up the board in the cloud so that it is reachable when your Mac is off: one AWS
Lightsail machine that runs the container of [HYBRID.md](HYBRID.md) (`deploy/cloud/Dockerfile`), two
S3 buckets for the backups, and Cloudflare (tunnel and Access) in front. You run everything from
your own Mac with one command, `npm run cloud -- <command>`, with your own logins. No member of the
team, human or AI, gets an AWS or Cloudflare secret: the commands are yours to run.

The guide grows with the cards of the plan (PM-534 to PM-537). A chapter marked **(planned)** is
written by the card named there; this file holds its heading so the order stays.

## Overview and cost

```
 browser / engine ──► Cloudflare (Access) ──► tunnel ──► Lightsail machine ─ container ─ server
                                                         (no open port)       ├ Litestream ─► S3 bucket (database)
                                                                              └ restic     ─► S3 bucket (the rest)
```

| Part                             | Cost (about, per month)                                     |
| -------------------------------- | ----------------------------------------------------------- |
| Lightsail machine `small_3_0`    | 12 USD (2 GB memory, 2 vCPU, 60 GB disk, transfer included) |
| S3 buckets (database, backups)   | a few cents (a small database, deduplicated backups)        |
| Cloudflare Free (tunnel, Access) | 0 USD (Access is free up to 50 users)                       |
| Route 53 hosted zone (kept)      | 0.50 USD, only while the zone is kept as a fallback         |

Nothing listens on a public address: the machine's firewall opens only `22/tcp`, and only for
Lightsail's own browser client (`lightsail-connect`); the tunnel connects outwards. One machine
runs one writer to the database, which Litestream needs.

## The owner's manual steps

Short and in order. Every step that can be done by a command is done by one; these cannot.

1. **AWS CLI v2 and the login.** Install the CLI (`brew install awscli`) and sign in with the profile
   `i` (`aws configure --profile i`, or `aws configure sso --profile i`). Check:
   `aws --version` (2.x) and `aws sts get-caller-identity --profile i`.
2. **The rights of the profile.** The profile creates a Lightsail machine, S3 buckets and IAM users, so
   it needs an administrator's rights, or at least: `lightsail:*`, the S3 actions `CreateBucket`,
   `ListBucket`, `GetBucketVersioning`, `Get`/`PutBucketPublicAccessBlock`, `Get`/`PutEncryptionConfiguration`,
   `Get`/`PutLifecycleConfiguration`, and the IAM actions `CreateUser`, `TagUser`, `GetUser`,
   `PutUserPolicy`, `GetUserPolicy`, `ListUserPolicies`, `ListAttachedUserPolicies`, `CreateAccessKey`,
   `ListAccessKeys`, `DeleteAccessKey`. `npm run cloud -- preflight` names what is missing.
3. **The configuration file** (next chapter). Choose two bucket names nobody else has (S3 names are
   global), for example `<yourname>-projectman-db`.
4. **The Cloudflare account, the token and the name servers** (PM-536, PM-537): written by those cards.
5. **Save the restic password.** `npm run cloud -- aws` creates `RESTIC_PASSWORD` in `cloud.env`. Copy
   it into your password manager at once: without it the restic backups cannot be read.

Run `npm run cloud -- preflight`, then `npm run cloud -- aws --dry-run` (it only reads and prints what
it would change), then `npm run cloud -- aws`.

## Configuration and secret files

Everything is in `~/.config/projectman/cloud/`. That directory is under `~/.config/projectman`,
which the AI sessions' sandboxes already deny. Nothing from it goes to the repository, a card or a
message.

| File               | Content                                                   | Written by                                        |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------- |
| `config.json`      | the settings; no secret (`--config <file>` names another) | you (start from `deploy/aws/config.example.json`) |
| `cloudflare-token` | the Cloudflare API token (PM-536)                         | you                                               |
| `cloud.env`        | the container's environment, docker env-file format       | `npm run cloud` (below)                           |

`npm run` starts the command in the repository root, so give `--config` an absolute path (a relative one is resolved from the root).

The directory is mode 700 and the files 600. A command refuses (exit 2) a wider mode and every
symbolic link, and `preflight` names the file. A file is written to a 600 temporary file and
renamed, so a crash never leaves half a file. There is no state file: every resource is found by its
name, so a second run changes nothing.

### `config.json`

The file is validated strictly (`version: 1`, no unknown field). A wrong field exits with status 2
and names the field's path. `deploy/aws/config.example.json` has every field you usually set.

| Field                                    | Default                                      | Meaning                                                    |
| ---------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| `aws.profile`                            | `i`                                          | the AWS CLI profile                                        |
| `aws.region`                             | required                                     | for example `eu-west-1`                                    |
| `aws.availabilityZone`                   | `<region>a`                                  |                                                            |
| `aws.instanceName`                       | `projectman-cloud`                           | also the prefix of the IAM users                           |
| `aws.bundleId`, `aws.blueprintId`        | `small_3_0`, `ubuntu_24_04`                  | machine size and image (must be active)                    |
| `aws.databaseBucket`, `aws.backupBucket` | required, different                          | S3 names, lowercase, no dots                               |
| `aws.sshIdentityFile`                    | none                                         | a private key for ssh instead of Lightsail's temporary one |
| `repository.url`                         | `https://github.com/janoist1/projectman.git` | what the machine builds                                    |
| `cloudflare.*`, `access.*`               |                                              | validated now, used from PM-536                            |
| `route53.hostedZoneId`                   | looked up by name                            | used from PM-537                                           |

`cloud.env` is a docker env-file: `NAME=value`, one per line, no quotes. `npm run cloud` sets only
the names it owns and keeps every other line and comment, so a later card can add `TUNNEL_TOKEN` and
`PROJECTMAN_FEEDBACK_PUBLIC_URL` without losing anything.

## The AWS resources

`npm run cloud -- preflight` checks, without changing anything: the `aws` CLI is version 2; the
profile logs in (the account id is printed); the region and the availability zone exist; the bundle
and the blueprint are active; the modes of the secrets store are right. The Cloudflare part is added
by PM-536 as another step of the same command.

`npm run cloud -- aws [--dry-run] [--rotate-keys]` creates, in this order, whatever is missing:

1. **The machine** `aws.instanceName`: no key pair of its own, tagged `projectman=cloud`; the command
   waits for `running`. If the machine exists with another bundle or blueprint, the command exits 2
   and changes nothing.
2. **The metadata service**: IMDSv2 only (`--http-tokens required`), hop limit 1.
3. **The firewall**: replaced as a whole by one entry, `22/tcp` for the alias `lightsail-connect`.
   No other port stays open, not 80 or 443. (Opening your own IP address for a moment is the job of
   the machine part, PM-535.)
4. **The buckets**: created in the region (checked with `--expected-bucket-owner`; a name that is
   someone else's exits 2), all four public-access blocks on, AES256 encryption with a bucket key,
   a rule that aborts unfinished multipart uploads after 7 days (other lifecycle rules are kept).
   Versioning must not be on (Litestream and restic keep their own history): an enabled bucket
   exits 2.
5. **Two IAM users**, `<instanceName>-litestream` (the database bucket) and `<instanceName>-restic`
   (the backup bucket), each with one inline policy `bucket-access`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "ListBucket",
         "Effect": "Allow",
         "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
         "Resource": "arn:aws:s3:::<bucket>"
       },
       {
         "Sid": "ObjectAccess",
         "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
         "Resource": "arn:aws:s3:::<bucket>/*"
       }
     ]
   }
   ```

   Nothing else is allowed. A user that has any other inline or attached policy exits 2.

6. **Access keys.** A Lightsail machine has no IAM role, so the two users have static keys. A new
   key goes straight into `cloud.env` (the secret never appears on the screen or in an argument).
   If the user has a key that `cloud.env` does not hold as an active key, the command exits 2: AWS
   never shows a secret again. `--rotate-keys` makes a new key, writes it, then deletes the old ones
   (an IAM user holds two at most, so with two old keys one is deleted first); afterwards the machine
   needs a `deploy` to get the new `cloud.env`.
7. **`cloud.env`** gets `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT` (`https://s3.<region>.amazonaws.com`),
   `LITESTREAM_REGION`, the key names, `RESTIC_REPOSITORY` (`s3:https://s3.<region>.amazonaws.com/<backupBucket>/projectman`),
   `RESTIC_REGION`, and a `RESTIC_PASSWORD` (32 random bytes, base64url) if there is none yet.

Each step prints one line: `ok | created | updated | unchanged | skipped`, or `FAIL <step>: <reason>`.
With `--dry-run` only reading calls run and a step that would change something prints `skipped … dry-run: would …`.

Exit status: `0` done, `1` failed, `2` refused (a precondition is missing or the state is dangerous;
nothing was changed by that step), `64` bad usage.

## The machine and the installation

The commands of this chapter talk to the machine over SSH and run `deploy/aws/host.sh` on it. The
machine is Ubuntu with Docker; the board is the container of [HYBRID.md](HYBRID.md), supervised by
the systemd unit `projectman-cloud.service`.

| Command                                   | What it does                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy [--ref <tag\|sha>] [--dry-run]`   | installs the machine (idempotent), sends `cloud.env`, builds the image of the ref there, starts it, waits up to 180 s for health, goes back to the old image if none |
| `rollback [--dry-run]`                    | starts the previous image (the one before the current), waits for health                                                                                             |
| `status`                                  | the state of the machine (Lightsail), the unit, the container and its health, the deploy history, disk and memory                                                    |
| `logs [--lines <n>]`                      | the last `n` lines (default 200, at most 10000) of the unit's log (`journalctl`)                                                                                     |
| `ssh`                                     | a shell on the machine, with the same safe connection                                                                                                                |
| `stop [--dry-run]`, `start [--dry-run]`   | stop the board (data stays, the unit is disabled); start the current image again and wait for health                                                                 |
| `rehearse`                                | the restore rehearsal of HYBRID.md in a scratch container on the machine; passes only on the line `REHEARSAL PASSED`                                                 |
| `seed --from <dir> [--ref …] [--dry-run]` | fills an empty machine with the package of `npm run migrate -- hybrid package`, then deploys                                                                         |
| `pull-data --to <new dir> [--dry-run]`    | copies the stopped board's data to a new directory on your Mac                                                                                                       |

`--dry-run` reads only and never connects: no firewall change, no SSH.

### What `deploy` does

1. **The ref.** Without `--ref` the newest release tag of `repository.url` (`git ls-remote --tags`):
   tags look like `vYYYY.M.D` and `vYYYY.M.D.N` (the N-th later release of a day); they are ordered
   by number, not by text. `--ref` takes a tag or a 40-digit commit id. The image is tagged with the
   full commit id and is also what the server reports as its version (`PROJECTMAN_VERSION`), the same
   id the engine compares.
2. **`cloud.env`** (from `npm run cloud -- aws`) is read; a missing file or missing bucket keys is
   exit 2. Its secrets are sent on the standard input of `ssh` only, never in an argument, and are
   written on the machine to `/etc/projectman/cloud.env` (root only, mode 600).
3. **`bootstrap`** installs Docker, git and `jq`, turns on unattended upgrades, makes a 2 GB swap file
   (the 2 GB machine builds a Node image), and installs the unit file. It is safe to run again.
4. **`build`** fetches the repository at the commit and builds the image on the machine. It refuses
   below 3 GiB of free disk. Old images beyond the current and the previous one, and build cache
   beyond 2 GB, are removed.
5. **`start`** writes `/etc/projectman/image.env` (`IMAGE=projectman-cloud:<sha>`) and
   `/var/lib/projectman/deploy.json` (`current`, `previous`, `lastStoppedAt`), then restarts the unit.
6. **Health.** The command polls the container's health check every 5 s for 180 s. If it never
   becomes healthy, it prints the last 200 log lines and, when there is an earlier image, starts it
   again (and exits 1 either way).

An older build refuses a database a newer build has migrated. Therefore every `deploy` that has to
go back, and every `rollback`, prints when the board last stopped before the update
(`lastStoppedAt`) and how to restore the database to that moment
([Restoring the database to a point in time](#restoring-the-database-to-a-point-in-time)).

### The machine's files

| Path                                           | What                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/etc/systemd/system/projectman-cloud.service` | the unit (`deploy/aws/projectman-cloud.service`); no published port, only `/data` is mounted |
| `/etc/projectman/cloud.env`                    | the container's environment (root only, 600)                                                 |
| `/etc/projectman/image.env`                    | the image the unit runs                                                                      |
| `/var/lib/projectman/data`                     | the board's data (`/data` in the container, owner 10001, mode 700)                           |
| `/var/lib/projectman/deploy.json`              | the deploy history and the time the board last stopped                                       |
| `/opt/projectman/src`                          | the checkout the image is built from                                                         |

### How the SSH connection is made

Port 22 is open only for Lightsail's browser client (`lightsail-connect`). Every command that needs
the machine therefore does this, in this order, and always undoes it:

1. looks the machine up (it must exist and run) and finds your public IPv4 address
   (`https://checkip.amazonaws.com`);
2. opens `22/tcp` for **your address alone** (`/32`) next to `lightsail-connect`;
3. asks Lightsail for a temporary key and certificate (`get-instance-access-details`; they live
   about a minute, so a long command asks again), and writes them to a private temporary directory
   (mode 700, files 600);
4. connects with `StrictHostKeyChecking=yes` against the host keys that Lightsail reports for the
   machine, kept in `~/.config/projectman/cloud/known_hosts` (a connection to a machine that does not
   match is refused; there is no "accept new key" and no `StrictHostKeyChecking=no`);
5. after the command, on success, failure and Ctrl-C alike, **deletes the key directory and puts the
   firewall back** to `22/tcp` for `lightsail-connect` only (three tries).

If the firewall cannot be put back the command prints `FAIL firewall-close: …` with the exact `aws`
command that does it by hand, and exits 1. Run that command before anything else.

If the temporary-certificate path does not work for you, set `aws.sshIdentityFile` to a private key
that the machine accepts (a key pair added to the instance, or a key you added to `~ubuntu/.ssh/authorized_keys`
from Lightsail's browser console). The host keys are still checked, and the firewall is still opened
only for your address. As a last resort, the Lightsail console's browser SSH reaches the machine
without any of this (`lightsail-connect` stays open for that).

### `seed` and `pull-data`

`seed` is for the first start with the data you already have (the move from the Mac,
[HYBRID.md](HYBRID.md), "3. The cutover"). Stop the board on the Mac first, then
`npm run migrate -- hybrid package`, then `npm run cloud -- seed --from <the package folder>`. It
refuses (exit 2) when: the folder has no `db.sqlite` or holds anything the cloud must not get (the
same closed list as the package); either bucket already has an object (a replica exists, a seed
would collide); the board is running on the machine; or `/var/lib/projectman/data` is not empty.
All of that is checked before the upload where it can be (the buckets and the folder before any
connection). The data goes over the SSH connection as a `tar` stream, is owned by the container's
user, and the machine is then deployed like `deploy` does.

`pull-data --to <new folder>` is the way back (`npm run migrate -- hybrid back` takes the folder).
The folder must not exist (its parent must), must not be inside a git work tree, and is created with
mode 700. The board must be stopped first (`npm run cloud -- stop`): a copy of a live database is no
copy. A failed download removes the folder. The command prints what in the copy the way back would
refuse.

### What was not tried

The team could not run any of this against a real AWS account. `deploy/aws/host.sh` is checked for
syntax and for what it must never do (no published port, no host network, no privileged container,
no Docker socket), and the commands against a fake `aws`, `ssh` and machine. The first real run is
yours: `status` first (it needs only the machine), then `deploy --dry-run`. The least certain part
is the temporary SSH certificate: if `ssh` refuses it, use `aws.sshIdentityFile`.

## Cloudflare (planned: PM-536)

Zone, edge settings, Access with the exact e-mail list, service tokens, the tunnel, `publish`, `check`.

## DNS move (planned: PM-537)

Moving the zone from Route 53 to Cloudflare (`dns plan|import|verify|status`) and the final list of
manual steps.

## Verification (planned: PM-536)

The checks of [DEPLOY.md](DEPLOY.md) and [HYBRID.md](HYBRID.md) on the public address.

## Recovery after losing the machine

The data is in the two buckets (the database in the Litestream replica, everything else in the restic
repository), not on the machine. If the machine is gone or broken beyond repair:

1. Have `~/.config/projectman/cloud/` (the configuration and `cloud.env`) and the `RESTIC_PASSWORD`
   from your password manager. If `cloud.env` is lost, first create it again with the one line
   `RESTIC_PASSWORD=<from the password manager>` (mode 600; otherwise `aws` makes a new password
   that cannot open the old repository), then run `npm run cloud -- aws --rotate-keys`: it makes
   new access keys for the buckets (the secret of an old key is shown only once) and writes the rest
   of the file. The bucket contents stay.
2. Delete the broken machine in the Lightsail console (or let the new one have another name in
   `aws.instanceName`). `npm run cloud -- aws` creates a new machine, firewall and keys; the
   buckets already exist and are left alone.
3. `npm run cloud -- deploy`. The container starts on an empty data directory and **its entrypoint
   restores** the files from restic and the database from the Litestream replica
   ([HYBRID.md](HYBRID.md), "Restoring on a new volume"); it refuses to start on any error except
   "no replica yet", so an empty board never replicates over a backup it could not read.
4. `npm run cloud -- rehearse` once it runs, to know the restore works.

Never run two machines on the same buckets: one replica has one writer.

### Restoring the database to a point in time

Needed after a `rollback` or a failed `deploy` that went back, when the older build refuses the
database (the newer build migrated it). The command that went back printed the time the board last
stopped before the update; that is the last moment the old build's database was complete.

1. `npm run cloud -- stop`.
2. On the machine (`npm run cloud -- ssh`), restore the replica into a scratch folder with the image
   that is deployed (its Litestream and configuration), replacing `<time>` with the printed time in
   UTC (`2026-10-12T09:30:00Z`) and `<sha>` with the full commit id of `current` in
   `/var/lib/projectman/deploy.json`:

   ```sh
   sudo mkdir -p /var/lib/projectman/restore
   sudo docker run --rm --env-file /etc/projectman/cloud.env -e PROJECTMAN_HOME=/data \
     -v /var/lib/projectman/restore:/restore --entrypoint litestream projectman-cloud:<sha> \
     restore -config /app/deploy/cloud/litestream.yml -timestamp <time> -o /restore/db.sqlite /data/db.sqlite
   ```

3. Keep the current database aside and put the restored one in its place, with the container's owner:

   ```sh
   cd /var/lib/projectman/data
   sudo mv db.sqlite db.sqlite.newer
   sudo rm -f db.sqlite-wal db.sqlite-shm
   sudo install -o 10001 -g 10001 -m 600 /var/lib/projectman/restore/db.sqlite db.sqlite
   ```

4. `npm run cloud -- start`.

What the board wrote after that moment (cards, messages) is lost; the files restic holds are not
reset. This procedure was written, not run: practise it once on a `pull-data` copy with
`litestream restore` (HYBRID.md) before you need it.

## Teardown

In this order, so nothing is left running or billed:

1. If you want the data, `npm run cloud -- stop`, then `npm run cloud -- pull-data --to <new folder>`.
2. Take the Cloudflare part down (PM-536) and revoke the machine key in Settings → Engines.
3. Delete the Lightsail machine (console, or `aws lightsail delete-instance --instance-name
projectman-cloud --profile i --region <region>`). Its firewall goes with it.
4. Delete the two buckets and their contents when you are sure; keep the restic one if you may want
   the data later (the `RESTIC_PASSWORD` is then needed).
5. Delete the IAM users `<instanceName>-litestream` and `<instanceName>-restic` with their keys, and
   `~/.config/projectman/cloud/`.

`npm run cloud` has no command that deletes anything: that is deliberate.

## What this does not cover

- A live trial: nothing here was run against a real AWS account by the team. The first real run is
  yours; start with `preflight` and `aws --dry-run`.
- The release watcher (`com.projectman.live-watcher`) still updates the Mac, not the cloud machine.
- Several machines: one machine means one database writer.
- AWS Organizations, SSO session renewal, billing alarms: set them up in your AWS account.
