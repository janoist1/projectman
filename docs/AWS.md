# The cloud board on AWS EC2 or Lightsail

## Prebuilt ARM and amd64 images (PM-718)

The PM-675 target is Frankfurt (`eu-central-1`), `t4g.micro`, Canonical Ubuntu 24.04 arm64,
20 GiB gp3. Set `aws.ec2.architecture: "arm64"` and `deployment.imageBundle` in cloud config v1.
Omitting architecture keeps `x86_64`. AMI name/architecture, instance type capabilities and the
existing instance must agree; the ownership, IMDS, SSM and empty-inbound guards stay in force.
The imageBundle directory is relative to the config file, or absolute. It need not exist when
config is first written; preflight, seed and deploy verify it before remote writes.

On a **separate admin/builder machine**, with a clean checkout at the accepted full lowercase SHA:

```sh
npm run cloud -- image-build --ref <SHA40> --out /new/path/outside-the-checkout --dry-run
npm run cloud -- image-build --ref <SHA40> --out /new/path/outside-the-checkout
```

Docker and an already configured Buildx `docker-container` driver must support linux/amd64 and
linux/arm64 through native builders or emulation. The command does not create a builder, fetch,
switch branches or publish. Two sequential, single-platform Docker exports use the same SHA and
tracked source context, then load/inspect verifies config digest, Linux architecture, revision
LABEL and PROJECTMAN_VERSION. The bundle becomes valid only when both exports pass and its
strict `manifest.json` is atomically published. Dry-run only checks/plans and creates no output.
See the [Buildx build reference](https://docs.docker.com/reference/cli/docker/buildx/build/) and
[Docker exporter documentation](https://docs.docker.com/build/exporters/oci-docker/).

Keep `manifest.json`, `linux-amd64.tar` and `linux-arm64.tar` together. Output must be a new
directory outside the repository with no symlink components, NUL/newline or comma in its path.
The manifest records sourceSha and each archive's SHA-256, bytes and image config ID. It is
integrity metadata, not a signature: the owner approves the specific builder output and digests.
Record these values from the `ok image` report in the PM-675 round approval.

`deploy --ref <SHA40> --dry-run` validates the selected archive locally. Deploy sends only that
platform's tar over the existing SSH/SSM stream. Host import checks free disk, bounded bytes/hash,
host platform, sole source tag and config content before load, then inspects the immutable ID.
It neither starts the board nor opens SQLite. A conflicting source tag refuses import.
Seed retains the empty bucket/host checks and PM-717 data integrity gate **before** image import,
receive-env and pinned start. There is no host build or fallback on a configured bundle path.

Prebuilt starts use the immutable image ID. Status exposes the actual container ID; health checks
it together with the history's SHA/ID/platform. Manual and health rollback retain previous IDs;
ARM refuses a legacy record without its digest/platform. Old amd64 records and deployment without
an imageBundle retain the existing host-build path. Rollback does not undo DB migrations: keep
the existing point-in-time recovery gate. No image import prunes current/previous images.

Real two-platform builds and disposable runtime smoke (Node/better-sqlite3, cloudflared,
litestream, restic and cloud server), plus 1 GiB RAM and import disk headroom checks, are PM-675
release artifact evidence. This implementation does not provision resources or authorize cutover.

For the owner-approved Mac single → EC2 cloud + Mac engine execution order, approval
points, checks and rollback, use [CLOUD-CUTOVER.md](CLOUD-CUTOVER.md) (PM-674).
It preserves existing Cloudflare DNS/mail and distinguishes the private move from public activation.

## EC2 central account and provisioning (PM-676, part of PM-664)

PM-664 uses **EC2 in the `aroom` profile**, with the domain registrar and retained Route 53 zone
in **`i`**. Authoritative DNS is already Cloudflare. `aws.profile` targets compute, S3 and IAM;
`route53.profile` targets registrar/source-zone calls (absent: `aws.profile`). Every call passes
an explicit profile and region; Route 53 Domains always uses `us-east-1`. `aws` and `preflight`
never import records or switch delegation. Cloudflare remains the DNS writer.

These are owner provisioning commands, outside AI sessions. No AWS login, secret or operation is
required for reviewing this change; the tests use a stateful fake. The Mac engine connects outward
to the board and receives no AWS profile credentials. Provisioning does not change engine RPC.

1. On the owner's Mac, install AWS CLI v2 and sign in to `aroom` and `i` with MFA. Confirm each
   account with `aws --profile aroom --region <region> sts get-caller-identity` and
   `aws --profile i --region us-east-1 sts get-caller-identity`. Save the expected account ids in
   the execution package, and compare them with each script's printed identity before approval.
2. Copy `deploy/aws/config.example.json` to the protected secrets store described below. Replace
   **all** choice markers. The example records the PM-675 Frankfurt/ARM/type/disk decision;
   other installations choose their target explicitly. Use unique bucket names. `aws.compute=ec2` requires an explicit `aws.ec2` object:
   `instanceType`, `amiId`, `vpcId`, `subnetId` and integer `volumeGiB` (20–1024). No EC2 type,
   image or disk-size default is chosen. Retain `aws.profile=aroom`, `route53.profile=i`.
   To discover candidates before the config is complete, the owner can read the catalogue with
   `aws --profile aroom --region <region> ec2 describe-images --owners 099720109477 --filters
'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*'` (use amd64 for x86_64) and
   `aws --profile aroom --region <region> ec2 describe-subnets`. No resource is created by these reads.
   EC2 refuses a missing/empty compute profile and the registrar profile `i` before any AWS call.
   Other explicit central profiles are accepted; the name check supplements STS/owner checks.
3. Run `npm run cloud -- preflight`. It prints the STS account, available Canonical Ubuntu 24.04
   server AMIs for the configured architecture and subnet choices. It checks the chosen AMI owner, OS, architecture, HVM/EBS
   root and minimum disk size (AMI ephemeral instance-store mappings are allowed; additional EBS
   mappings are refused); enabled region; VPC/subnet ownership, free IPv4 and DNS support;
   subnet's effective default route directly to an attached internet gateway; IPv4 network ACL;
   and encrypted-EBS/selected-architecture support plus availability of the type in the subnet's zone. This proves
   the configured network prerequisites; installed SSM and application connectivity are verified
   by the later host adapter. The conservative ACL check accepts an initial allow-all IPv4 rule
   in each direction and refuses custom ACLs it cannot prove. The security group still blocks all
   new inbound connections. No VPC, subnet, NAT, load balancer or extra machine is created.
4. Run `npm run cloud -- aws --dry-run`. Review the proposed instance, root volume and public IPv4
   separately. The script prints **cost components**, not a regional price quote: Linux On-Demand
   running hours (730/month for an always-on estimate); encrypted gp3 storage at the selected GiB
   even while stopped; one auto-assigned public IPv4 while allocated; transfer and S3 usage.
   Baseline gp3 performance is explicit (3000 IOPS, 125 MiB/s); burstable instances use standard
   CPU credits. Record current regional rates from [EC2](https://aws.amazon.com/ec2/pricing/on-demand/),
   [EBS](https://aws.amazon.com/ebs/pricing/) and [IPv4](https://aws.amazon.com/vpc/pricing/) in the
   execution package before the owner approves creation. Dry-run performs only reads and does not
   write `cloud.env`, IAM keys, tags or any AWS resource.
5. After the exact creation step is approved, run `npm run cloud -- aws`. Its cost preview precedes
   `RunInstances`. It creates `<instanceName>-host` with EC2-only trust, the managed policy
   `AmazonSSMManagedInstanceCore` and a same-name instance profile, plus a dedicated
   `<instanceName>-cloud` security group with **empty inbound** and IPv4 outbound internet access.
   One instance uses the existing selected public subnet, an automatically assigned public IPv4,
   encrypted gp3 root EBS, IMDSv2 required/hop-limit 1, termination protection and shutdown=stop.
   The two private encrypted S3 buckets and separate Litestream/restic users use the common
   provisioning steps documented below. The host role has SSM rights only; backup keys remain
   bucket-scoped in the protected `cloud.env`. Save the new `RESTIC_PASSWORD` separately.
6. If a command fails, read its failed step and rerun the same config after resolving the cause.
   Security group creation waits for the tagged group to become visible; a propagation timeout stops
   before instance launch and a later run rediscovers it. IAM profile/launch-time group propagation
   retries the identical request/token. A lost launch response is recovered
   by rediscovering the instance; no local state file is used. Every resource has ownership tags;
   instances are searched by Name alone to detect unmanaged namesakes. A unique instance must have
   `Name=<instanceName>` and `ProjectmanManaged=true`. Multiple instances/groups, foreign tags,
   changed VPC/image/type/disk/role/profile/IMDS, extra NICs or any inbound rule refuse the operation.
   The script never repairs those states destructively or launches a replacement. A stopped instance
   remains stopped. A terminated namesake refuses creation while visible: an intentional replacement
   needs a separately reviewed name/config. A terminated instance eventually disappears from AWS
   discovery; absence then does not prove that the name was never used. This tool has no permanent
   termination history. The deterministic `ClientToken` hashes the namespace, account, region and
   complete public launch request: it protects retries of that request, not reuse of a name forever.
   After termination, review a new instance name/config explicitly instead of assuming the old token
   will create a replacement. See [EC2 idempotency](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html).

The only UserData is `deploy/aws/ec2-bootstrap.sh`: it installs/enables sshd, EC2 Instance Connect
and the SSM agent. Credentials, `cloud.env`, board data and engine keys are absent. Ubuntu's snap
agent setup follows the [AWS Ubuntu SSM guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/agent-install-ubuntu-64-snap.html);
image ownership/name checks follow the [Canonical image catalogue](https://ubuntu.com/aws/docs/aws-how-to/instances/find-ubuntu-images/).
Host operation uses **SSH through SSM (PM-677)** for `compute=ec2`; the same cloud commands
select the legacy transport only for `compute=lightsail`. The container keeps bridge networking,
with no public port, host network or Docker socket.

The provisioning login needs the EC2 describe operations above and `DescribeInstances`,
`DescribeSecurityGroups`, `DescribeVolumes`, `DescribeInstanceAttribute`, `CreateSecurityGroup`,
tag-on-create `CreateTags`, `RunInstances`; IAM `GetRole`, `CreateRole`, `ListRolePolicies`,
`ListAttachedRolePolicies`, `AttachRolePolicy`, `GetInstanceProfile`, `CreateInstanceProfile`,
`AddRoleToInstanceProfile`, tag-on-create `TagRole`/`TagInstanceProfile`, and `PassRole` restricted to
the host role and EC2 service. S3 and backup-user permissions are listed in the legacy/common
resource guide below. The `i` login needs only the registrar/Route 53 rights for the requested
DNS reads; it receives no EC2, S3, host IAM or SES provisioning call.

## EC2 host operation through SSM (PM-677)

All host commands (`deploy`, `rollback`, `status`, `logs`, `stop`, `start`, `rehearse`, `seed`,
`pull-data`, `ssh`, and the host step of `up`) use the same `deploy/aws/host.sh`, systemd unit,
JSON responses, full-SHA image tags and data paths as Lightsail. There is **no inbound SSH rule**,
public-IP connection, long-lived key import or public-SSH fallback. `aws.sshIdentityFile` applies
only to Lightsail; EC2 always generates an ephemeral key. The address exposed by the adapter is
the EC2 instance id, never its public IPv4 address.

On the owner/integrator's POSIX machine, install **AWS CLI v2**, **session-manager-plugin**,
**OpenSSH** (`ssh` and `ssh-keygen`), git and tar. Log in to the explicit central profile
(`aroom` for PM-664). Along with the provisioning rights, the caller needs `ec2:DescribeInstances`,
`ec2-instance-connect:SendSSHPublicKey` for the selected instance and OS user `ubuntu`, and SSM
`DescribeInstanceInformation`, `SendCommand` (the instance and `AWS-RunShellScript` document),
`GetCommandInvocation`, `StartSession` (the instance and `AWS-StartSSHSession` document),
`DescribeSessions` and `TerminateSession` for its own sessions. These are caller rights; do not
add them to the instance's SSM-agent role or give the registrar profile `i` compute access.

The connection sequence is:

1. Describe instances by the configured `Name`; require exactly one nonterminated instance,
   with matching `Name` and `ProjectmanManaged=true` tags, a valid instance id/AZ, and state `running`.
   Require that exact instance to report `Online` in SSM. Missing, ambiguous, offline or timed-out
   answers refuse operation; `status` can report a stopped machine without SSH.
2. SSM `AWS-RunShellScript` runs only the fixed public command
   `cat /etc/ssh/ssh_host_ed25519_key.pub`, targeting only that instance id. Poll its invocation
   for at most 120 seconds. Validate the single-line ed25519 key, including its binary format,
   and omit raw AWS/RunCommand output on failure. No secrets, tar, script installation or application
   command enter RunCommand or UserData.
3. Create a temporary directory (700), private key (600) and `known_hosts` (600). Pin the
   SSM-authenticated host key with `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes`, no password,
   no user SSH config and no global host-key fallback. There is no TOFU or disabled checking.
4. Immediately before **each** SSH connection, send only the temporary **public** key through
   EC2 Instance Connect for the instance's actual AZ and `ubuntu`. The key is valid for 60 seconds;
   long builds do not consume the next connection's window. The private key stays on the owner machine.
5. SSH connects to `ubuntu@i-…` with a validated, quoted ProxyCommand:
   `aws --profile aroom --region <configured-region> ssm start-session --target <instance-id> --document-name AWS-StartSSHSession --parameters portNumber=22`.
   The actual command also disables CLI prompts/pagers and carries a random public `--reason`
   correlation id unique to each connection. `cloud.env` uses SSH stdin and tar uses an SSH stream. AWS sees only the
   tunnel's encrypted SSH traffic, not the payload. See
   [AWS's SSH transport guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html),
   [SSH session logging boundary](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-logging.html)
   and [EIC key lifetime](https://docs.aws.amazon.com/cli/latest/reference/ec2-instance-connect/send-ssh-public-key.html).
6. On success, failure, timeout or Ctrl-C, stop the local SSH/AWS/plugin process group, wait for
   the stream peers, then reconcile active SSM sessions by target and the exact set of random
   reasons issued by this invocation. Read all pages before terminating any matching session.
   The cleanup AWS phase has a 30-second total budget, including the process runner's 5-second
   shutdown grace, with at least three complete snapshots 2 seconds apart. After termination,
   a fresh complete snapshot must show no own active session. Delayed visibility and transient
   failures retry within that budget. Temporary files and signal handlers are removed in a separate
   finally even if AWS fails. A failed cleanup exits 1, retains the original operation error and
   prints the public instance id/reasons for manual inspection. Other operators' sessions are untouched.
   This observation window does not guarantee AWS consistency; failed verification needs the manual
   inspection below.

### Owner/integrator live rehearsal

No live AWS operation runs as part of the card's fake tests. Run the following only in the
approved live execution round (PM-675), with the explicit EC2/aroom configuration from PM-676.
Use `--config <file>` on every command if it is outside the default store.

1. Confirm the provisioned instance is running, bootstrap has finished, its SSM agent is `Online`,
   and its security group still has empty inbound rules. Check CLI/plugin versions locally and
   the caller permissions above. Failure here is a dependency to fix, never a reason to open port 22.
2. `npm run cloud -- deploy --dry-run --ref <approved-sha>` prints the SSM path without connecting.
   `npm run cloud -- status` then proves Online lookup, authenticated host key, EIC and SSH while
   reporting the existing unit/container state. Follow with `logs --lines 25` and `ssh`; exit the shell.
   Verify that no temporary key directory or correlated active SSM session remains.
3. For a fresh empty host and empty database/backup buckets, stop the local writer, make the
   approved hybrid package, then `seed --from <package-dir> --ref <approved-sha>`. Existing host
   data, a running board, nonempty buckets or provider credentials in the package must refuse the seed.
   `deploy --ref <approved-sha>` updates an already-seeded installation without relaxing these guards.
4. Verify `status`, `logs` and `rehearse` (requires `REHEARSAL PASSED`). In the approved downtime
   window, `stop`, `pull-data --to <new-directory>` and `start` verify one-writer behavior and the
   return stream. Keep the copy outside a git worktree; never copy a running database.
5. Exercise Ctrl-C during a disposable build or transfer. Confirm local SSH/plugin descendants
   ended, key files disappeared, and active SSM sessions for the printed correlation id closed.
   A partial pull directory is removed. Recheck empty inbound rules. Rollback keeps the existing
   migration refusal and point-in-time restore procedure; an older image is not a database downgrade.

If cleanup fails, use `aws --profile aroom --region <region> ssm describe-sessions --state Active
--filters key=Target,value=<instance-id>` in the owner round. Match **both** the target and exact
`Reason` printed by the failed command; terminate each matching `SessionId` with
`aws --profile aroom --region <region> ssm terminate-session --session-id <session-id>`.
Do not broadly terminate sessions or use public SSH to recover an offline SSM agent. Repair its
outbound connectivity/agent through the approved EC2 recovery procedure instead.

This is the owner's central-server administration connection, independent of the Mac engine link.
The engine receives no AWS login, new RPC, host private key or cloud-admin payload.

## Lightsail compatibility and common backup/Cloudflare guide (PM-532)

This guide sets up the board in the cloud so that it is reachable when your Mac is off: one AWS
Lightsail machine that runs the container of [HYBRID.md](HYBRID.md) (`deploy/cloud/Dockerfile`), two
S3 buckets for the backups, and Cloudflare (tunnel and Access) in front. You run everything from
your own Mac with one command, `npm run cloud -- <command>`, with your own logins. No member of the
team, human or AI, gets an AWS or Cloudflare secret: the commands are yours to run.

The CLI and this guide cover the four parts of PM-532 (PM-534 to PM-537).

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

Short and in order: account setup, local credentials, and commands that the owner runs.

1. **Cloudflare account:** protect it with a passkey (or two-factor authentication) and save recovery codes.
2. **Zero Trust:** choose the team name and the Free plan in the dashboard.
3. **API token:** use the rights in "The Cloudflare token" below, with about 90 days of validity;
   save only the token in `~/.config/projectman/cloud/cloudflare-token`, mode 600.
4. **AWS login:** install CLI v2 (`brew install awscli`) and sign in as profile `i` with MFA/passkey.
   Do this only after PM-533 is released: AI sessions must be denied access to `~/.aws`.
   Check `aws --version` and `aws sts get-caller-identity --profile i`.
5. **Configuration:** fill `config.json` from `deploy/aws/config.example.json`, including unique bucket names.
6. **DNS delegation:** run `dns switch` as in "DNS move" below, only after green `dns verify`. The domain is managed
   through **Route 53 Domains**, even though RDAP names Gandi as the underlying registrar.
   Check automatic renewal: the owner's recorded expiration is **2026-11-19**; `dns status` reads the current value.
7. **First setup:** use the one-time code in `logs`; when moving an existing board, use `seed` (PM-318).
8. **Public checks:** `brew install cloudflared`, `cloudflared access login https://<hostname>`,
   then create the mode-600 `login.json` described in "Verification" for `check`.
9. **Backup password:** copy `RESTIC_PASSWORD` from `cloud.env` into your password manager after `aws`.
10. **Engine:** set `linkHeadersFile` to `~/.config/projectman/cloud/engine-access-token.json`
    as in [HYBRID.md](HYBRID.md).
11. **Later:** manually delete the old Route 53 hosted zone after keeping the rollback window.

The AWS profile needs `lightsail:*`, the S3 actions `CreateBucket`, `ListBucket`, `GetBucketVersioning`,
`Get`/`PutBucketPublicAccessBlock`, `Get`/`PutEncryptionConfiguration`, `Get`/`PutLifecycleConfiguration`,
and IAM `CreateUser`, `TagUser`, `GetUser`, `PutUserPolicy`, `GetUserPolicy`, `ListUserPolicies`,
`ListAttachedUserPolicies`, `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`.
DNS also needs `route53:ListHostedZonesByName`, `route53:GetHostedZone`, `route53:ListResourceRecordSets`,
`route53domains:GetDomainDetail` and `route53domains:UpdateDomainNameservers`.

Run `npm run cloud -- preflight`, then `npm run cloud -- aws --dry-run` (it only reads and prints what
it would change), then `npm run cloud -- aws`.

## Configuration and secret files

Everything is in `~/.config/projectman/cloud/`. That directory is under `~/.config/projectman`,
which the AI sessions' sandboxes already deny. Nothing from it goes to the repository, a card or a
message.

| File                           | Content                                                                    | Written by                                        |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------- |
| `config.json`                  | the settings; no secret (`--config <file>` names another)                  | you (start from `deploy/aws/config.example.json`) |
| `cloudflare-token`             | the Cloudflare API token (PM-536)                                          | you                                               |
| `cloud.env`                    | the container's environment, docker env-file format                        | `npm run cloud` (below)                           |
| `engine-access-token.json`     | the engine's Access service token (`linkHeadersFile` format)               | `npm run cloud -- edge`                           |
| `integrator-access-token.json` | the integrator's service token (only with `access.integratorServiceToken`) | `npm run cloud -- edge`                           |

`npm run` starts the command in the repository root, so give `--config` an absolute path (a relative one is resolved from the root).

The directory is mode 700 and the files 600. A command refuses (exit 2) a wider mode and every
symbolic link, and `preflight` names the file. A file is written to a 600 temporary file and
renamed, so a crash never leaves half a file. There is no state file: every resource is found by its
name, so a second run changes nothing.

### `config.json`

The file is validated strictly (`version: 1`, no unknown field). A wrong field exits with status 2
and names the field's path. `deploy/aws/config.example.json` has every field you usually set.

| Field                                    | Default                                      | Meaning                                                                                             |
| ---------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `aws.compute`                            | `lightsail`                                  | `ec2` selects EC2 provisioning and SSH over SSM; existing version-1 files keep Lightsail            |
| `aws.profile`                            | `i`                                          | the AWS CLI profile                                                                                 |
| `aws.ec2`                                | none                                         | required for EC2: explicit type, AMI, existing VPC/subnet, integer root volume GiB (20–1024)        |
| `aws.region`                             | required                                     | for example `eu-west-1`                                                                             |
| `aws.availabilityZone`                   | `<region>a`                                  |                                                                                                     |
| `aws.instanceName`                       | `projectman-cloud`                           | also the prefix of the IAM users                                                                    |
| `aws.bundleId`, `aws.blueprintId`        | `small_3_0`, `ubuntu_24_04`                  | machine size and image (must be active)                                                             |
| `aws.databaseBucket`, `aws.backupBucket` | required, different                          | S3 names, lowercase, no dots                                                                        |
| `aws.sshIdentityFile`                    | none                                         | a private key for ssh instead of Lightsail's temporary one                                          |
| `repository.url`                         | `https://github.com/janoist1/projectman.git` | what the machine builds                                                                             |
| `cloudflare.zone`, `.hostname`           | required                                     | the zone (`example.com`) and the board's name in it (`board.example.com`, one label under the zone) |
| `cloudflare.feedbackHostname`            | none                                         | the feedback widget's own name (HYBRID.md); one label under the zone, not the board's               |
| `cloudflare.accountId`                   | the only account the token sees              | needed when the token sees more than one account                                                    |
| `cloudflare.tunnelName`                  | `aws.instanceName`                           | the tunnel's name, and the prefix of the Access applications, policies and service tokens (`<N>`)   |
| `cloudflare.tokenFile`                   | `<secrets store>/cloudflare-token`           | an absolute path or `~/…`                                                                           |
| `access.emails`                          | required                                     | the exact e-mail addresses that may log in; no wildcard, no domain                                  |
| `access.sessionDuration`                 | `24h`                                        | the Access session (`30m`, `24h`)                                                                   |
| `access.integratorServiceToken`          | `false`                                      | make a second service token for the integrator's smoke test                                         |
| `route53.hostedZoneId`                   | looked up by name                            | used from PM-537                                                                                    |
| `route53.profile`                        | `aws.profile`                                | independent registrar and retained Route 53 source account; PM-664 uses `i`                         |

`cloud.env` is a docker env-file: `NAME=value`, one per line, no quotes. `npm run cloud` sets only
the names it owns and keeps every other line and comment: `aws` writes the S3 names and keys,
`edge` writes `TUNNEL_TOKEN` and `PROJECTMAN_FEEDBACK_PUBLIC_URL`. The machine gets the file with `deploy`.

## The AWS resources

`npm run cloud -- preflight` checks, without changing anything: the `aws` CLI is version 2; the
profile logs in (the account id is printed); the region and the availability zone exist; the bundle
and the blueprint are active; the modes of the secrets store are right. Then the Cloudflare part (see
"Cloudflare" below): the token is active, the account is found, Zero Trust is on, and one reading call
per right the token needs. It changes nothing, in either cloud.

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
| `status`                                  | the state of the EC2 or Lightsail machine, the unit, the container and its health, the deploy history, disk and memory                                               |
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

### How the Lightsail SSH connection is made

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
user. Before any build/start, the mandatory PM-717 `seed-integrity` gate compares the closed
package's database SHA-256 and byte count before and after upload with `host.sh seed-digest`.
The host reads only `/var/lib/projectman/data/db.sqlite` with Ubuntu 24.04 coreutils, without
opening SQLite or starting a container. Both sides reject a missing, non-regular or symlink DB
and any `db.sqlite-wal`, `db.sqlite-shm` or `db.sqlite-journal` entry (including dangling symlinks).
The host checks that the unit/container is stopped before and after hashing and detects file changes.
Only an exact match permits deployment and prints, before build/start:
`ok seed-integrity: database sha256=<64hex> bytes=<n> (before first start)`.
Record that proof on PM-675; never record database contents. Keep the package closed and use one
administrator throughout the maintenance window; no other cloud operation may start the board.

Local precondition refusals exit 2; host state refusals (host exit 3) also exit 2. Invalid/incomplete
digest JSON, hash/size mismatch, changed/disappearing source, read/hash or transport errors exit 1.
`FAIL seed-integrity` means **STOP**: no build/start, automatic retry, deletion or overwrite follows.
Uploaded data remains in place; ask the owner for a recovery decision. A used target still refuses
another seed. `--dry-run` only previews this mandatory gate and never connects or claims remote proof.

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

### Reset between the two PM-675 trial rounds (PM-719)

The owner chose **the same EC2 instance, emptied**, with both buckets retained. This tool is
only for the approved trial target. Completing PM-719 does not authorize any live deletion.
First finish `stop` → final `pull-data` → `hybrid back` → `instance activate` → Mac single/watcher
checks. Record the successful return and login checks on PM-675; the reset validates the event id
format and retained bytes, while the owner verifies the event's meaning and acceptance evidence.

Keep the final download in a private mode 0700 directory outside any repository and the live
Mac home. Keep the plan in a separate existing mode 0700 directory owned by the administrator.
Do not place it inside the final download. Paths and keys in the plan are private data; attach
neither the plan nor object listings to the task. Use the explicit central profile (`aroom` for
PM-675), never the registrar `i`. No profile lookup/fallback takes place.

```sh
npm run cloud -- trial-reset-plan --from <FINAL_RETURN_DIRECTORY> --rollback-event <EVENT_ID> --out <NEW_PLAN_JSON> --config <PRIVATE_CONFIG>
```

Planning reads the account, unique managed EC2 target, VPC/subnet/SSM, stopped and disabled host,
entire data tree, metadata digests and both complete paginated bucket inventories. It requires
the retained download's canonical content inventory and DB digest to match the host. Symlinks,
special entries, nested mounts, invalid UTF-8 names and detectable changes are refused. No SQLite
connection is opened. Versioned **or suspended** buckets, Object Lock, replication and multipart
uploads are refused; permission/transport failures never mean an absent configuration. An empty
backup bucket is valid. Planning writes only a new mode 0600 plan and reports its exact file SHA-256.

Host requirements: an already deployed Ubuntu 24.04 target with its existing regular root-owned
`.image.lock`, existing Python3 and Linux descriptor/no-follow/mountinfo support. The fixed embedded
standard-library program runs in isolated `python3 -I -S` mode. Missing interpreter/capabilities
refuse before writes; the reset installs nothing and has no fallback. The dedicated trial host
must have no running/starting containers or restic/Litestream/backup processes. `trial-reset-inspect`
returns active-tree hashes; `trial-reset-archive` preserves it; `trial-reset-verify` rehashes that
specific archive after deletion, checks the archived receipt and confirms empty owned active data.
The last two host operations take the same UUID/hash/none arguments and no stdin payload.
Use one administrator throughout this maintenance window; do not deploy/start the host or change
bucket policies/replication while the reset is in progress. Planning never stops writers itself.

Before execution the owner approves that **specific plan file hash**, account/profile/region,
instance id/name, the two exact bucket names, rollback event, inventory hashes/counts/bytes and
fixed archive directory. Any edited/regenerated plan needs a new concrete approval. Confirming
a hash is integrity binding, not proof of human approval or QA. The AWS administrator needs the
existing read permissions and S3 conditional-delete permissions; this tool grants no IAM rights.

```sh
npm run cloud -- trial-reset-apply --plan <PLAN_JSON> --confirm-sha256 <PLAN_FILE_SHA256> --dry-run --config <PRIVATE_CONFIG>
# Only after the owner's exact execution approval:
npm run cloud -- trial-reset-apply --plan <PLAN_JSON> --confirm-sha256 <PLAN_FILE_SHA256> --config <PRIVATE_CONFIG>
```

Dry-run performs all preflight comparisons without an archive, deletion or receipt. Apply first
creates a mode 0600 `<PLAN_JSON>.result.json`; any existing result prevents reapplication. On the
host it preserves deploy.json/image.env and renames active data to the root-only mode 0700
`/var/lib/projectman/trial-archive/<PLAN_UUID>/data`. A mode 0600 reset.json records started/archived;
the new active data is empty, mode 0700, uid/gid 10001. cloud.env, credentials, Docker images and
other hosts/resources stay in place. The unit remains inactive and disabled.

Only after archive verification and another exact bucket inventory comparison does deletion
start. Each planned object uses its exact ETag with `If-Match`, expected bucket owner and explicit
profile/region. The installed AWS CLI model must support conditional deletion. Each delete uses
`AWS_MAX_ATTEMPTS=1`/standard retry mode; the first 412, denial, timeout or interruption stops the
operation. See the [AWS conditional-delete contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-deletes.html).
There is no unconditional fallback, recursive deletion, version deletion, bypass, seed or start.

The local receipt tracks started/host-archived/failed/complete and confirmed delete counts.
A failed or interrupted operation may already have archived data or deleted objects; an uncertain
response can mean AWS deleted one more object than the confirmed count. Keep both receipts,
archive and final download. Stop and obtain a separately reviewed owner recovery plan for the
remaining state; do not remove markers, replay an old plan, restore automatically or retry deletes.
Host archival is not an atomic transaction with S3. Success requires fresh empty listings and no
multipart uploads plus final read-only stopped-host/empty-data/archive integrity verification.

Retain the protected final download and host archive until at least the second round's full
backup and isolated restore acceptance. Removing either requires a separate decision. Round two
starts with a **new package from the Mac's then-current stopped state**, verify, seed-integrity
(PM-717) and the approved prepared ARM image (PM-718). Do not reuse the first round's package.
Exit codes: 64 bad CLI; 2 unsafe/different precondition (host refusal 3 maps to 2);
1 API/transport/computation failure; 0 success. Failure output contains operation/fixed codes,
never raw object keys, ETags, URLs or credentials.

## Cloudflare

`npm run cloud -- edge` makes the Cloudflare side with the Cloudflare API and your own token, like
`aws` does for AWS: every resource is found by its name, a second run changes nothing, and a
setting someone changed in the dashboard is put back. `<N>` below is `cloudflare.tunnelName`
(by default `aws.instanceName`, `projectman-cloud`).

### The Cloudflare token

Create a custom API token (dashboard → My Profile → API Tokens), with these rights and no other:

| Scope   | Group                                                                    | Level | Used for                             |
| ------- | ------------------------------------------------------------------------ | ----- | ------------------------------------ |
| Account | Cloudflare Tunnel                                                        | Edit  | the tunnel, its ingress and token    |
| Account | Access: Apps and Policies                                                | Edit  | the Access applications and policies |
| Account | Access: Service Tokens                                                   | Edit  | the engine's and integrator's tokens |
| Account | Access: Organizations, Identity Providers, and Groups                    | Edit  | the One-time PIN identity provider   |
| Zone    | Zone (all zones from the account; the zone does not exist before `edge`) | Edit  | creating the zone                    |
| Zone    | DNS                                                                      | Edit  | the CNAME records of `publish`       |
| Zone    | Zone Settings                                                            | Edit  | the edge settings                    |
| Zone    | Transform Rules                                                          | Edit  | the no-framing header rule           |

Page Rules, Cache Rules and Workers are not needed: nothing here uses them. Give the token an
expiry you will remember. The token is yours: no AI member gets it.

`preflight` proves each right with one reading call (`GET`). A reading call proves a right to read
only, so a right to read without a right to edit passes `preflight`; `edge` and `publish` then stop
at the first refused change, name the right they lack and change nothing further in that step.

### What `edge` does

`npm run cloud -- edge [--dry-run] [--rotate-engine-token] [--rotate-integrator-token]`, in this order:

1. **The zone** `cloudflare.zone`: created (full setup, no automatic records) if the account has none.
   It prints the two name servers. The zone stays `pending` until the registrar uses them (PM-537);
   `publish` waits for `active`.
2. **The edge settings**: HTTPS only, minimum TLS 1.2, automatic HTTPS rewrites, Rocket Loader, e-mail
   obfuscation and server-side excludes off (they rewrite the page the board serves), and HSTS for
   180 days without subdomains and preload.
3. **A transform rule** `projectman_frame_headers` on `cloudflare.hostname`: `X-Frame-Options: DENY`
   and `Content-Security-Policy: frame-ancestors 'none'` on every response (Access's own pages
   included). Other rules of the zone are kept.
4. **The One-time PIN identity provider**, if the account has none.
5. **The service tokens** `<N>-engine` and, with `access.integratorServiceToken`, `<N>-integrator`,
   valid for a year. The secret is shown only when the token is made, so it goes at once to
   `engine-access-token.json` / `integrator-access-token.json` (mode 600; the format is the engine's
   `linkHeadersFile`, HYBRID.md). A token that exists while its file is missing or for another token
   exits 2: `--rotate-engine-token` (or `--rotate-integrator-token`) makes a new secret and writes
   the file; whoever used the old secret needs the new file. `edge` prints the expiry and warns
   30 days before it.
6. **The Access policies**, with the exact lists and nothing else (no domain or group, and `everyone` only in the public board's one bypass policy, below):
   `<N>-allow-emails` (allow, one `email` rule per `access.emails` entry), `<N>-engine-service` and
   `<N>-integrator-service` (service auth, that one token).
7. **The Access applications**, both self-hosted with the One-time PIN as the only provider, hidden from
   the launcher, with `access.sessionDuration`: `<N>` on `cloudflare.hostname` (the e-mail policy, and
   the integrator policy if there is one) and `<N>-engine` on `cloudflare.hostname/engine` (the engine
   policy only). Their policy lists must be exactly these: an extra policy is removed. With the
   integrator token switched off, its policy, token and file are deleted.
8. **The tunnel** `<N>` (managed from Cloudflare, `config_src: cloudflare`; a tunnel that is configured
   from a local file exits 2) and its **ingress**: `/hooks*` and `/mcp*` answer 404 (the board's
   webhook and MCP doors stay closed to the world), the board's name goes to `127.0.0.1:4700` with the
   `access.required` check against the audience tags of both applications (the origin checks the
   Access JWT itself), with a feedback name the `/feedback/` path of it goes to the same port and the
   rest is 404, everything else 404.
9. **`cloud.env`** gets `TUNNEL_TOKEN` and, with a feedback name, `PROJECTMAN_FEEDBACK_PUBLIC_URL`.
   Run `npm run cloud -- deploy` afterwards: the machine reads the file when the container starts.

Every step prints one line like those of `aws`, and the exit statuses are the same. With `--dry-run`
only reading calls run, and a step that would change something prints `skipped … dry-run: would …`.

### Making the name public: `publish`

`npm run cloud -- publish [--feedback] [--dry-run]` creates the one DNS record that opens the door:
a proxied CNAME from `cloudflare.hostname` to `<tunnel id>.cfargotunnel.com`. It does it last, after
it has read the whole setup and found it right; any failed check exits 2 with no record made:

- the zone is `active` (the name servers of PM-537 are in use);
- both Access applications exist with exactly their policies, the e-mail policy lists exactly
  `access.emails` and the service policies exactly their token;
- the tunnel is `healthy`, that is, the machine's `cloudflared` is connected (`deploy` first).

A name that already has an A record, a CNAME elsewhere, or several records exits 2 and is left alone;
a CNAME of its own with the wrong `proxied` flag is put right.

`--feedback` adds the feedback name (`cloudflare.feedbackHostname`), which has no Access application
and so is public by design (the marking widget posts to it, HYBRID.md). It needs `cloud.env` to hold
`PROJECTMAN_FEEDBACK_PUBLIC_URL=https://<feedbackHostname>`, and the board must answer `404` to
`/api/setup` twice, with `Host: <feedbackHostname>` and with `Host: <feedbackHostname>:443` (the
board's own guard for the feedback name; `deploy/aws/host.sh guard-check`, run on the machine over
SSH, asks the container). A board that answers anything else there would show more than the widget's
door on that name, so then no record is made.

Order for a first run: `aws`, `edge`, set the name servers (PM-537), `deploy` (the tunnel connects),
`publish`, `check`.

### Does this work on a remote engine?

`edge`, `publish` and `check` run on the owner's computer and talk to the Cloudflare API; they do
not run on the cloud machine, and the machine never gets the API token. What crosses to the machine is
`cloud.env` (`TUNNEL_TOKEN`, `PROJECTMAN_FEEDBACK_PUBLIC_URL`) by `deploy`, and `guard-check` over the
same SSH connection as the other machine commands. A remote engine reads its service token file,
`engine-access-token.json`, through the engine's `linkHeadersFile` (copy it there by your own means).
`docs/ARCHITECTURE.md` lists the entries.

### The public board (PM-672, part of PM-664)

`access.boardMode` is `private` (default: the steps above, Cloudflare Access in front of the board's
pages) or `public`: the board's own e-mail login (PM-670) is the only boundary of its pages, so clients
reach it without a Cloudflare account or a One-time PIN. `public` needs the `ses` block (the e-mail login
is the way in; the registrar profile `i` is refused there too). The engine door stays closed to the world
in both modes.

What `edge` does differently with `boardMode: public` (the order of the steps is the same):

- **Policies and applications.** The main application `<N>` has exactly one policy, `<N>-public-board`
  (Bypass, `include: everyone`, no exclude or require), and no automatic redirect to the identity
  provider. `<N>-allow-emails` is kept for the way back but attached to nothing. The engine application
  `<N>-engine` on `cloudflare.hostname/engine` stays exactly its service token. The service policies keep
  their meaning; the integrator token (`access.integratorServiceToken`) has no use on the main name, so
  `check` skips the integrator smoke test.
- **Ingress.** With a feedback name, its `^/feedback/` goes to `127.0.0.1:4700` and the rest of that name
  is 404 (unchanged). On the main name: `^/hooks` and `^/mcp` answer 404 (the webhook and MCP doors never
  open to the world); `^/engine(/|$)` goes to the port with `originRequest.access` required, the team
  name and **the audience tag of the engine application only**; everything else on the name goes to the
  port with no audience check (the board's login guards it); the last rule is 404.
- **`cloud.env`** gets `PROJECTMAN_PUBLIC_BOARD=1`; in `private` mode `edge` removes the line.

The server side of the switch (`PROJECTMAN_PUBLIC_BOARD`, `0` default or `1`, anything else stops the
start) adds no way in: the board's login is the same in both modes. It only refuses to start where the
login would be missing: `public_board_requires_cloud` (not cloud mode), `public_board_requires_setup`
(no owner yet, so there is no anonymous first setup to take) and `public_board_requires_email_login`
(the mailer is off). `GET /api/setup` then says `publicBoard: true`. A restore rehearsal starts its standby
copy with `PROJECTMAN_PUBLIC_BOARD=0`.

**`publish` for the public board** makes the DNS record only after more checks (any failure exits 2 with no
record made): the main application has exactly the bypass policy and the engine application exactly its
token; the ingress is the public shape above, with the engine audience; `cloud.env` holds
`PROJECTMAN_PUBLIC_BOARD=1`; the working feedback guard, when there is a feedback name (the guard is
checked even without `--feedback`, because a public board with an open widget name behind it is not
acceptable); and `deploy/aws/host.sh public-check <hostname>`, run on the machine over SSH, answers
exactly `{"publicBoard":true,"emailLoginEnabled":true,"needsSetup":false,"apiStatus":401,"crossOriginStatus":403}`:
the server is the public board, the e-mail login works, the owner is set up, an anonymous `GET
/api/auth/me` is 401 and a cross-origin login `POST` is 403. An answer of another shape exits 1.

**`check`** runs the public matrix of `deploy/cloudflare/check.sh` (`BOARD_MODE=public`, no `cloudflared`
login and no Access token needed): `/` 200; `/api/setup` 200 with `publicBoard` and `emailLoginEnabled`
true and `needsSetup` false; `/api/auth/me` and `/ws` 401; an e-mail code request 202; a foreign-origin
login 403; the session cookie `HttpOnly` and `SameSite` (both modes), and, through the engine doors, that
the engine token itself gets 401 on `/api/auth/me` (it is no board login). `deploy/cloud/smoke.sh` has
`SMOKE_PUBLIC_BOARD=1` for the same on a running instance.

**Switching.** Edit `access.boardMode`, then `edge`, `deploy`, `check`. A name that is already published
is open to the new mode at once when `edge` finishes: going public without `deploy` leaves the old
container running without the flag (it still protects itself with its own login, but then `publish` and
`check` would refuse it), so run `deploy` and `check` straight after. The order is fixed, and a runbook
(PM-675) must keep it as one uninterrupted sequence: `edge` changes the Access applications and the ingress
(the step order is in `scripts/cloud/cloudflare.ts`, the policies and applications before the tunnel
configuration), and from then on the published name answers in the new mode, whatever the running container
was started with. Do not leave a published name between `edge` and `check`. Going back to `private` puts the
Access lock back on the main application (the allow-emails policy, the automatic redirect, the ingress
with both audiences), deletes `<N>-public-board` after the applications stopped using it, and removes the
flag from `cloud.env`; run it again and nothing changes.

**Does this work on a remote engine?** Yes. The public board concerns the browser side only: the engine
still connects outward to `/engine`, which is behind its own Access application and its own machine key.

## DNS move (PM-537)

Move the **whole zone**, including mail (SES MX, DKIM and verification TXT) and site verification.
The commands only read the Route 53 hosted zone; the explicit `switch` updates registrar delegation.
All imported records are DNS-only (`proxied: false`);
`publish` later adds the tunnel records separately. Cloudflare's automatic scan is disabled by `edge`.

1. `npm run cloud -- edge`: creates the full zone and prints its two assigned name servers.
2. `npm run cloud -- dns plan`, then `npm run cloud -- dns import`, then
   `npm run cloud -- dns verify`. `plan` only reads and prints `create`, `same`, `different`,
   `skip` or `REFUSE` per record. A refusal exits 2 and prevents every import write.
   `import --dry-run` previews writes; `--update` explicitly allows PATCH of differing records.
   Nothing is deleted. Cloudflare-only records are listed as warnings, except published tunnel CNAMEs.
3. **Only after green verification**, `npm run cloud -- dns switch --dry-run`, then
   `npm run cloud -- dns switch`. DNSSEC must be disabled first if `dns status` reports a DS record or registrar keys.
4. `npm run cloud -- dns status` until Cloudflare reports `active`. It reads delegation and DS
   through Cloudflare and Google DoH, reports registrar name servers, DNSSEC key count, registration expiry and auto-renew, and requests an
   activation check for a pending zone. Both public resolver answers are printed; allow cached delegation to expire.
5. `npm run cloud -- publish`, then `check`. Test **SES receiving and DKIM** after the change.

Mapping: A/AAAA make one record per address; CNAME and delegated subdomain NS lose the trailing dot;
MX preserves priority; TXT quoted chunks are decoded and joined with no separator; SRV preserves
priority/weight/port/target; CAA preserves flags/tag/value. Apex NS/SOA are skipped. Aliases become
CNAMEs (matching A+AAAA aliases produce one); Cloudflare flattens the apex. Names are lowercase,
with Route 53 octal escapes decoded. TTL is clamped to 60–86400 seconds; a TTL difference counts as
`different`. Routing policies, health checks, unsupported types and occupied publish hostnames are refused.

`verify` compares sorted responses from **both Cloudflare authorities and all four Route 53 authorities**,
resolving their IPs first with the system resolver. Nonalias differences exit 1. Alias differences only warn,
because providers can flatten them to different addresses.
If a Cloudflare authority does not answer for the pending zone, verification prints a specific error and
exits 1. In that case `dns plan` with **every imported record `same`**, no `different`, `create` or `REFUSE`,
is fallback evidence of API contents, but it is not a green authoritative verification. Wait, then run
`dns verify` again; delegation cannot change until it is green. There is no manual override.

Keep the Route 53 hosted zone for **at least one week** as a rollback path (about USD 0.50/month).
To roll back, run `npm run cloud -- dns switch --back --dry-run`, then `dns switch --back`
to restore its four awsdns name servers in Route 53 Domains, then check public delegation
and mail delivery again. Never delete that zone during the move. It can be deleted manually later.

### Explicit delegation switch

`dns switch [--back] [--dry-run]` reads Route 53 Domains first, then the target name servers.
If the registrar already has that exact set it reports `unchanged`. Otherwise it refuses registrar
DNSSEC keys or public DS records, runs `dns verify` again in the same invocation, and refuses (exit 2)
unless it is green. There is no override. `--back` targets the retained Route 53 delegation set and
does not require verification against Cloudflare. `--dry-run` performs checks but never submits an update.
The rollback warns that records changed in Cloudflare since the move are not copied back to Route 53.
If the domain cannot be read through Route 53 Domains, `switch` refuses (exit 2): missing permission
names `route53domains:GetDomainDetail`; another registrar requires a manual delegation step there,
with the same green verification prerequisite.
Renewal disabled or expiration within 30 days produces a warning. `dns status` treats an unavailable
registrar API as a warning and still reports Cloudflare activation.

The update is asynchronous: the command prints its operation ID; poll `dns status` afterwards.
The registrar API calls use `us-east-1` irrespective of the Lightsail region, as required by the
[AWS CLI reference](https://docs.aws.amazon.com/cli/latest/reference/route53domains/update-domain-nameservers.html).

### `up`

`npm run cloud -- up [--login-json <file>] [--dry-run]` runs `preflight` → `aws` → `edge` → `deploy`.
If the zone is active it continues with `publish`, then `check` when a login file is supplied.
A pending zone prints `dns plan`, `dns import`, `dns verify`, `dns switch` and stops before publish.
It never changes delegation implicitly.
The first failure stops the sequence with that command's exit status. Dry-run passes through the provisioning
steps without writes and skips the live login check.

## Verification

`npm run cloud -- check --login-json <file>` runs the checks of [DEPLOY.md](DEPLOY.md) and
[HYBRID.md](HYBRID.md) against `https://<cloudflare.hostname>`. Before the first run sign in to
Access as yourself: `cloudflared access login https://<hostname>` (an e-mail PIN from the list in
`access.emails`). `<file>` is a mode-600 JSON file with `{"email": "…", "password": "…"}` of a board
account; the command reads it only to hand it to `deploy/cloudflare/check.sh`, in the environment
and never in an argument. It runs three groups:

1. **`deploy/cloudflare/check.sh`**: Access in front of everything, `/hooks` and `/mcp` closed, the
   origin and cookie rules of the server, the edge settings (no framing, HTTPS only), and since
   PM-536 also that the edge does not cache the main page or `/api/setup` (`cf-cache-status` is not
   `HIT`) and does not inject a script into the page (Rocket Loader, Cloudflare's own beacon). With
   a feedback name it checks the widget's entrance too.
2. **The three engine doors** (`/engine/link` and the two file doors): without a token each answers
   the Access login (a redirect, never followed) or `403`, and with the engine service token each
   gets through Access and is refused by the board itself (a `GET` on these doors is never a
   success): a `2xx` means the door is open, a redirect to the Access login means the token is not
   accepted.
3. **The integrator smoke test** with `access.integratorServiceToken`: `deploy/cloud/smoke.sh` with
   the integrator token in its environment; without the setting the group is `skipped`.

A line `FAIL …` exits 1; a missing file or tool exits 2. The service token's secret never reaches the
output: it is masked if a script echoes it.

Run it after `publish`, and after every `edge` that changed an Access policy or the edge settings.

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
4. `npm run cloud -- rehearse` and perform the file/hash/database-reference checks in
   [HYBRID.md](HYBRID.md#backup-and-restore) before accepting recovery. Record both recovery times
   and any lost records/files. The latest replica and latest restic snapshot are not a shared
   snapshot: files may lag by 6 hours, longer after a failed backup. If the DB references files
   absent from the snapshot, recover a verified copy or choose an earlier database point below
   and repeat the checks in isolation. The rehearsal success line proves smoke checks only.

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
2. Take the Cloudflare part down, in the dashboard (`npm run cloud` deletes nothing): the DNS records
   of `cloudflare.hostname` and the feedback name, the tunnel `<N>`, the Access applications `<N>` and
   `<N>-engine`, their policies and the service tokens `<N>-engine` and `<N>-integrator`; the zone
   too if you do not use it otherwise. Delete the two `*-access-token.json` files and revoke the API
   token. Revoke the machine key in Settings → Engines.
3. Delete the Lightsail machine (console, or `aws lightsail delete-instance --instance-name
projectman-cloud --profile i --region <region>`). Its firewall goes with it.
4. Delete the two buckets and their contents when you are sure; keep the restic one if you may want
   the data later (the `RESTIC_PASSWORD` is then needed).
5. Delete the IAM users `<instanceName>-litestream` and `<instanceName>-restic` with their keys, and
   `~/.config/projectman/cloud/`.

`npm run cloud` has no command that deletes anything: that is deliberate.

## The e-mail login code mailer (SES, PM-669)

The later e-mail login of customers (PM-670) needs a mailer. PM-669 builds only that: the adapter
`createSesEmailCodeMailer` (`apps/server/src/services/email-login/`) sends one message through the
Amazon SES v2 `SendEmail` operation. It creates no SES identity, no account, no endpoint and offers no
login yet; the board's `emailCodeMailer` option stays empty until the login uses it.

**Settings** (lines in `cloud.env`, so they travel with `deploy`; a server started without them has the
mailer off):

| Variable                           | Meaning                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `PROJECTMAN_EMAIL_LOGIN_ENABLED`   | `0` (default) or `1`. Anything else stops the start.                          |
| `PROJECTMAN_SES_REGION`            | The SES region of the identity, for example `eu-central-1`. Required when on. |
| `PROJECTMAN_SES_FROM`              | The sender, an address of the verified identity. Required when on.            |
| `PROJECTMAN_SES_ACCESS_KEY_ID`     | The access key of the sending-only IAM user. Required when on.                |
| `PROJECTMAN_SES_SECRET_ACCESS_KEY` | Its secret. Required when on.                                                 |
| `PROJECTMAN_SES_SESSION_TOKEN`     | Only for temporary credentials. Optional.                                     |

When it is on and one required name is empty, the server does not start and says
`email_login_not_configured: missing <names>` (names only, never a value). The adapter uses these keys
and nothing else: no `AWS_*` variable, no profile, no instance role and no credential chain; the SES
endpoint is pinned to the region. The server reads the variables once and removes them from its own
environment, so a process it starts later (git, a shell) does not inherit the keys; the runner drops every
`PROJECTMAN_*` variable from the environment of an AI member's session as well, and the container's
entrypoint gives them to the server process only (not to Litestream, restic or the tunnel). A restore
rehearsal starts its standby copy with `PROJECTMAN_EMAIL_LOGIN_ENABLED=0` and `PROJECTMAN_PUBLIC_BOARD=0`. The mailer never logs an
address or a code; a provider failure becomes an `EmailCodeDeliveryError` (`code`
`email_code_delivery_failed`) with a fixed message and a coarse `reason` (`rejected`, `throttled`,
`credentials`, `unavailable`), and the caller decides the HTTP answer.

**Scripted SES provisioning (PM-678).** Add the optional version-1 configuration explicitly:

```json
"ses": { "region": "eu-central-1", "domain": "istvan.io", "from": "login@istvan.io" }
```

Choose the region and sender before running; this is an example, not a default. The address must belong
to exactly `ses.domain`, and that domain must be in the configured Cloudflare zone. Without `ses`, every
SES command refuses (exit 2) and email login stays unchanged. Use `aws.profile: "aroom"` for identity and
sender IAM and `route53.profile: "i"` for the registrar. The SES commands never use the registrar profile,
move the domain or change delegation. A default/explicit `i` central profile is refused. Every AWS call
uses explicit `--profile` and `--region` (the SES region may differ from the compute region). Cloudflare's
existing active zone proves the identity; no cross-account sending authorization is needed.

**The owner's steps**, run outside AI member sessions, each live change approved separately:

1. `npm run cloud -- ses plan`: read only STS, SES identity/account and Cloudflare zone/DNS. Prints identity,
   DKIM, sandbox/production/sending status, local sender state, planned DNS/IAM and remaining owner steps.
   It deliberately does not read IAM; use the next preview or `ses check` to verify actual IAM.
2. `npm run cloud -- ses configure --dry-run`: additionally read IAM ownership, inline/managed policies,
   groups and keys. Preview costs (sending can incur AWS charges), exact policy and env changes. It writes
   nothing, including no local env file. If the identity is missing, actual DKIM names become known only
   after creation. The caller needs STS identity, SESv2 identity/account read/create, IAM user/policy/group/key
   read, managed user creation, inline policy write and access-key creation; deleting only a newly issued
   key is attempted if its protected local persistence fails. The Cloudflare token needs Zone Read and
   DNS Read/Edit for the existing zone, no Access/tunnel/registrar rights for these commands.
3. After approving that preview, `npm run cloud -- ses configure`: keep an existing Easy DKIM identity or
   create one, converge only the three AWS-token CNAMEs with `proxied=false`, and leave MX/SPF/DMARC/other
   TXT untouched. AWS's `SigningHostedZone` supplies the CNAME target; older responses use the documented
   [regional DKIM domain](https://docs.aws.amazon.com/general/latest/gr/ses.html#ses_dkim). Conflicting
   records are refused rather than overwritten. Disabled/external DKIM or identity authorization policies
   require an explicit owner repair; configure does not replace them.
   The managed `<instanceName>-ses` user (tag `projectman=cloud`) has only inline `ses-send`:
   `ses:SendEmail`, resource `arn:aws:ses:<ses.region>:<STS account>:identity/<ses.domain>`, condition
   `StringEquals ses:FromAddress=<ses.from>`. Foreign users, extra policies/groups, unknown/inactive/extra
   keys or incomplete/temporary credentials are refused. No automatic rotation or adoption.
   A new key is immediately stored in mode-600 `cloud.env` under the mode-700 cloud store; other env lines
   stay. The command sets `PROJECTMAN_SES_REGION/FROM/ACCESS_KEY_ID/SECRET_ACCESS_KEY` and
   `PROJECTMAN_EMAIL_LOGIN_ENABLED=1` only as this explicit configure flow succeeds. It does not submit
   a production request, deploy, or prove backend login availability.
4. `npm run cloud -- ses request-production --dry-run`: review the separate request, then explicitly approve
   `npm run cloud -- ses request-production`. It submits SESv2 `put-account-details` with production=true,
   mail type `TRANSACTIONAL`, website `https://<cloudflare.hostname>`, English contact language, the fixed
   invited-customer OTP description and all `access.emails` as contacts (AWS accepts at most four).
   A pending request or production account is not resubmitted. Request submission is not AWS approval;
   see [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
5. Wait for AWS verification/approval and `npm run cloud -- ses check` to pass: verified domain, DKIM SUCCESS
   with signing enabled, production and sending enabled in the exact region, three DNS-only CNAMEs,
   exact sender IAM scope, one protected active key and matching enabled env. A bad operational state exits
   1, a missing precondition or unsafe ownership/key/DNS state exits 2. It never sends a test message.
6. Approve `npm run cloud -- deploy` to transfer the protected env through SSH stdin and restart the board.
   Actual login availability is reported by the backend. Approve the first real OTP trial separately after
   the auth implementation is released. Provisioning tests use stateful AWS/Cloudflare fakes.

`up`/`aws`/`edge` never configure SES or request production access. Repeating configure after success
changes nothing. Partial identity/DNS/policy failure can be resumed after repair; if key creation loses
its response, the next run refuses the unknown key and needs owner inspection. The one-time secret cannot
be recovered from AWS. Scripts print no credentials and pass no secret in argv; never copy keys into a card,
message or approval request. Read the protected store only on the owner's administration machine.

**Does this work on a remote engine?** Yes. The sending and the keys exist only in the board
(the cloud server); the engine, the engine link and the engine protocol do not change, and the board
sends the mail whether the engine is connected or not.

## What this does not cover

- A live trial: nothing here was run against a real AWS account by the team. The first real run is
  yours; start with `preflight` and `aws --dry-run`.
- The release watcher (`com.projectman.live-watcher`) still updates the Mac, not the cloud machine.
- Several machines: one machine means one database writer.
- AWS Organizations, SSO session renewal, billing alarms: set them up in your AWS account.
