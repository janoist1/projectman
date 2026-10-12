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

The directory is mode 700 and the files 600. A command refuses (exit 2) a wider mode and every
symbolic link, and `preflight` names the file. A file is written to a 600 temporary file and
renamed, so a crash never leaves half a file. There is no state file: every resource is found by its
name, so a second run changes nothing.

### `config.json`

The file is validated strictly (`version: 1`, no unknown field). A wrong field exits with status 2
and names the field's path. `deploy/aws/config.example.json` has every field you usually set.

| Field                                    | Default                                      | Meaning                                       |
| ---------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| `aws.profile`                            | `i`                                          | the AWS CLI profile                           |
| `aws.region`                             | required                                     | for example `eu-west-1`                       |
| `aws.availabilityZone`                   | `<region>a`                                  |                                               |
| `aws.instanceName`                       | `projectman-cloud`                           | also the prefix of the IAM users              |
| `aws.bundleId`, `aws.blueprintId`        | `small_3_0`, `ubuntu_24_04`                  | machine size and image (must be active)       |
| `aws.databaseBucket`, `aws.backupBucket` | required, different                          | S3 names, lowercase, no dots                  |
| `aws.sshIdentityFile`                    | none                                         | only a fallback for the machine part (PM-535) |
| `repository.url`                         | `https://github.com/janoist1/projectman.git` | what the machine builds                       |
| `cloudflare.*`, `access.*`               |                                              | validated now, used from PM-536               |
| `route53.hostedZoneId`                   | looked up by name                            | used from PM-537                              |

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

## The machine and the installation (planned: PM-535)

`deploy`, `rollback`, `status`, `logs`, `ssh`, `stop`, `start`, `rehearse`, `seed`, `pull-data`.

## Cloudflare (planned: PM-536)

Zone, edge settings, Access with the exact e-mail list, service tokens, the tunnel, `publish`, `check`.

## DNS move (planned: PM-537)

Moving the zone from Route 53 to Cloudflare (`dns plan|import|verify|status`) and the final list of
manual steps.

## Verification (planned: PM-536)

The checks of [DEPLOY.md](DEPLOY.md) and [HYBRID.md](HYBRID.md) on the public address.

## Recovery after losing the machine (planned: PM-535)

The data is in the two buckets. A new machine, `deploy`, then Litestream and restic restore it.
`RESTIC_PASSWORD` from your password manager is needed.

## Teardown (planned: PM-535)

## What this does not cover

- A live trial: nothing here was run against a real AWS account by the team. The first real run is
  yours; start with `preflight` and `aws --dry-run`.
- The release watcher (`com.projectman.live-watcher`) still updates the Mac, not the cloud machine.
- Several machines: one machine means one database writer.
- AWS Organizations, SSO session renewal, billing alarms: set them up in your AWS account.
