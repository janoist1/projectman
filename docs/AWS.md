# The cloud board on AWS EC2

## Prebuilt ARM images (PM-718)

The PM-675 target is Frankfurt (`eu-central-1`), `t4g.micro`, Canonical Ubuntu 24.04 arm64,
20 GiB gp3. Only arm64 is supported (PM-1116): `aws.ec2.architecture` is `"arm64"` (the default) and
`deployment.imageBundle` is required for an `ec2` config. AMI name/architecture, instance type
capabilities and the existing instance must agree; the ownership, IMDS, SSM and empty-inbound guards
stay in force. The imageBundle directory is relative to the config file, or absolute. It need not exist
when config is first written; preflight and deploy verify it before remote writes.

### Build on GitHub, fetch on the admin machine (PM-1145)

The image is built on GitHub's `ubuntu-24.04-arm` runner by the general workflow
`.github/workflows/projectman-job.yml` (PM-1144), so the admin Mac needs no Docker Desktop. The workflow is
general: another project copies the same file into its repository and passes its own command. It starts only
by hand (`workflow_dispatch`), only from the default branch, holds `contents: read`, `id-token: write` and
`attestations: write`, and uses no secret. It runs `command` with `sh -c` at the checked-out `commit`, with
`PROJECTMAN_JOB_COMMIT` and `PROJECTMAN_JOB_OUT` set, then attests every declared output file and uploads them as
the artifact `projectman-job-<run_id>` (7 days). The title of the run is
`projectman-job <job> <commit> <run_id>`.

The cloud image is the first job. Its values (the same ones that are in `CLOUD_IMAGE_JOB`,
`scripts/cloud/image-fetch.ts`; after PM-1148 they live in the project settings):

| Input             | Value                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job`             | `cloud-image`                                                                                                                                                                                                        |
| `runs_on`         | `ubuntu-24.04-arm`                                                                                                                                                                                                   |
| `node`            | `22`                                                                                                                                                                                                                 |
| `timeout_minutes` | `60`                                                                                                                                                                                                                 |
| `outputs`         | `bundle/manifest.json bundle/linux-arm64.tar`                                                                                                                                                                        |
| `command`         | `npm ci && docker buildx create --name projectman --driver docker-container --use && npm run cloud -- image-build --ref "$PROJECTMAN_JOB_COMMIT" --out "$PROJECTMAN_JOB_OUT/bundle"` (`image-build` needs no config) |

Start it for the accepted full SHA (the `run_id` is `manual-<first 8 of the SHA>-<time>`):

```sh
SHA=<SHA40>
gh workflow run projectman-job.yml --ref main -f job=cloud-image -f run_id="manual-${SHA:0:8}-$(date -u +%Y%m%d%H%M%S)" \
  -f commit="$SHA" -f runs_on=ubuntu-24.04-arm -f node=22 -f timeout_minutes=60 \
  -f outputs='bundle/manifest.json bundle/linux-arm64.tar' \
  -f command='npm ci && docker buildx create --name projectman --driver docker-container --use && npm run cloud -- image-build --ref "$PROJECTMAN_JOB_COMMIT" --out "$PROJECTMAN_JOB_OUT/bundle"'
```

Then fetch and verify the bundle on the admin machine (needs `gh` logged in, with read access to the repository's
Actions, and `gh attestation`, gh 2.49 or newer; no Docker, no cloud configuration):

```sh
npm run cloud -- image-fetch --ref <SHA40> --out /new/path/outside-the-checkout --dry-run
npm run cloud -- image-fetch --ref <SHA40> --out /new/path/outside-the-checkout [--run <run number>]
```

`image-fetch` never starts a run. It takes the newest `projectman-job.yml` run of `cloud-image` at that SHA
(or the run given with `--run`) and follows it while it is going (every 15 seconds, at most 60 minutes). With no
such run it refuses and prints the `gh workflow run` line above. It then refuses the run unless it ran the
workflow `.github/workflows/projectman-job.yml` by hand on the repository's default branch, succeeded, and has a
title of this job and SHA. It downloads the artifact and verifies the attestation of **both** files against the
exact workflow identity (`.../.github/workflows/projectman-job.yml@refs/heads/<default branch>`, no self-hosted
runner) and against this very run, so member code that ran on a `pm-check/*` branch, or a file of another job, is
not accepted. Last it checks the manifest (`sourceSha` equals `--ref`), the archive hash and the image inside the
archive with `tar` alone. The `--out` rules are those of `image-build`. On success the archive is moved in and
`manifest.json` is written last, atomically; on any failure `--out` is removed. The bundle is the one `image-build`
writes, so `deploy` and the host are unchanged; there is no registry. The report line is `ok image: source=...
platform=linux/arm64 archiveSha256=... imageId=... run=<url>`.

One-time owner setting: Settings → Actions → General → Workflow permissions → "Read repository contents".

Measuring (PM-1144): on the same SHA, before: `/usr/bin/time -l npm run cloud -- image-build --ref <SHA> --out <new>`
with the Docker VM's memory peak and the Memory Pressure from Activity Monitor, then `time npm run cloud -- deploy
--ref <SHA>`. After, with Docker Desktop stopped: the GitHub run's time including the wait, `time npm run cloud --
image-fetch --ref <SHA> --out <new>` with the bundle size and the Memory Pressure, and the same `deploy`. It stays
if a release no longer needs Docker Desktop and takes at most about 5 minutes longer than before; otherwise the
PM-1145 merge is reverted.

### The local fallback

The local `image-build` stays for a GitHub outage and for commits from before PM-1145 (they cannot be built on
GitHub). On a **separate admin/builder machine**, with a clean checkout at the accepted full lowercase SHA:

```sh
npm run cloud -- image-build --ref <SHA40> --out /new/path/outside-the-checkout --dry-run
npm run cloud -- image-build --ref <SHA40> --out /new/path/outside-the-checkout
```

Only linux/arm64 is built. An emulated build (arm64 on an x86 builder) is slow and can fail inside
QEMU, so build on an arm64 builder when you can.

Docker and an already configured Buildx `docker-container` driver must support linux/arm64
through a native builder or emulation. The command does not create a builder, fetch,
switch branches or publish. Sequential, single-platform Docker exports use the same SHA and
tracked source context, then load/inspect verifies config digest, Linux architecture, revision
LABEL and PROJECTMAN_VERSION. The bundle becomes valid only when every requested export passes and its
strict `manifest.json` is atomically published. Dry-run only checks/plans and creates no output.
See the [Buildx build reference](https://docs.docker.com/reference/cli/docker/buildx/build/) and
[Docker exporter documentation](https://docs.docker.com/build/exporters/oci-docker/).

Keep `manifest.json` and the archive it lists (`linux-arm64.tar`) together. A manifest holds one
arm64 image; a bundle with another platform is refused, and `deploy` refuses a bundle built from another
commit than the ref being deployed. Output must be a new
directory outside the repository with no symlink components, NUL/newline or comma in its path.
The manifest records sourceSha and each archive's SHA-256, bytes and image config ID. It is
integrity metadata, not a signature: the owner approves the specific builder output and digests.
Record these values from the `ok image` report in the PM-675 round approval.

`deploy --ref <SHA40> --dry-run` validates the archive locally. Deploy sends the tar over the existing
SSH/SSM stream. Host import checks free disk, bounded bytes/hash, host platform, sole source tag and
config content before load, then inspects the immutable ID. It neither starts the board nor opens
SQLite. A conflicting source tag refuses import. There is no host build: the machine only imports a
verified image.

Prebuilt starts use the immutable image ID. Status exposes the actual container ID; health checks
it together with the history's SHA/ID/platform. Manual and health rollback retain previous IDs;
a history record without its image ID or with another platform (an old amd64 one) cannot be started.
Rollback does not undo DB migrations: keep the existing point-in-time recovery gate. No image import
prunes current/previous images.

Real builds of the target platform and disposable runtime smoke (Node/better-sqlite3, cloudflared,
litestream, restic and cloud server), plus 1 GiB RAM and import disk headroom checks, are PM-675
release artifact evidence. This implementation does not provision resources or authorize cutover.

For the data-preserving return from EC2 cloud + Mac engine to Mac single,
use [CLOUD-CUTOVER.md](CLOUD-CUTOVER.md) (PM-674).

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
'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*'` and
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
Host operation uses **SSH through SSM (PM-677)**. The container keeps bridge networking,
with no public port, host network or Docker socket.

The provisioning login needs the EC2 describe operations above and `DescribeInstances`,
`DescribeSecurityGroups`, `DescribeVolumes`, `DescribeInstanceAttribute`, `CreateSecurityGroup`,
tag-on-create `CreateTags`, `RunInstances`; IAM `GetRole`, `CreateRole`, `ListRolePolicies`,
`ListAttachedRolePolicies`, `AttachRolePolicy`, `GetInstanceProfile`, `CreateInstanceProfile`,
`AddRoleToInstanceProfile`, tag-on-create `TagRole`/`TagInstanceProfile`, and `PassRole` restricted to
the host role and EC2 service. S3 and backup-user permissions are listed in the common
resource guide below. The `i` login needs only the registrar/Route 53 rights for the requested
DNS reads; it receives no EC2, S3 or host IAM call. SES provisioning uses `ses.profile` (PM-729), which
may be `i`, and only its SES and narrow-user IAM calls.

## EC2 host operation through SSM (PM-677)

All host commands (`deploy`, `rollback`, `status`, `logs`, `stop`, `start`, `rehearse`,
`pull-data`, `ssh`, and the host step of `up`) use the same `deploy/aws/host.sh`, systemd unit,
JSON responses, full-SHA image tags and data paths. There is **no inbound SSH rule**,
public-IP connection, long-lived key import or public-SSH fallback; the connection always uses an
ephemeral key. The address exposed by the adapter is the EC2 instance id, never its public IPv4 address.

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

### Failure tolerance and load diagnostics (PM-748)

Under load the EC2 Instance Connect authorized-keys helper on the host can time out
(`eic_run_authorized_keys failed, status 124`), and the client then sees only
`Permission denied (publickey)` (ssh status 255). The transport handles this inside the same boundary:
empty inbound rules, SSH over SSM, the pinned host key. It adds no instance resizing, reboot, network
access, sshd/EIC timeout change, durable SSH key or host build.

- **Fixed read-only diagnostics.** A second fixed `AWS-RunShellScript` command (instance-scoped, same
  `CommandId`/instance checks and bounded poll as the host key read, output limit 512 characters, strict
  seven-line parse, no raw output on failure) returns `Ec2HostDiagnostics`: `sampledAt`, `cpuCount`,
  `load1`, `availableMemoryBytes`, `freeDiskBytes`, `oomKills` and `eicTimeouts10m`. It takes no
  parameter and returns no credential, environment or journal text. `oomKills` is the kernel counter since
  boot: it shows that something was killed, not when or why. `eicTimeouts10m` counts only the journal lines
  of the last 10 minutes that match `eic_run_authorized_keys` with status 124. A missing or unreadable
  measurement (for example an unreadable journal) is an error, never a guessed zero. It works while SSH
  authentication fails.
- **Reads retry, writes never.** Only `status` and the pre-change connection probe (`ssh … true`) may be
  repeated: at most 3 attempts, waiting 5 s and then 15 s, inside one 120-second wall-clock budget that
  includes stopping the child process and reserves time for the diagnosis. Each attempt publishes a fresh
  EIC key. Ctrl-C and identity, ownership, host-key and schema errors stop at once with no retry. The
  explicit lists are `RETRYABLE_READS` and `READ_ONLY_SUBCOMMANDS` in `scripts/cloud/host.ts`; a new
  subcommand is neither retried nor treated as read-only. A state-changing command or a tar/secret stream
  (`bootstrap`, `receive-env`, `receive-image`, `start`, `stop`, …) is never
  repeated by the transport.
- **Load check before the first change.** Once per session, before its first state-changing subcommand,
  the diagnostics must not show `load1 > 2 × cpuCount` or less than 128 MiB available memory, and a
  connection probe must succeed; otherwise the same bounded wait runs, then the change is refused
  (`cloud_host_busy`, exit 2). Unreachable diagnostics are a refusal too, never leave for a blind change.
  The check is not repeated mid-session, because the session's own image import would otherwise block its `start`.
  Interactive `ssh` is not gated.
- **Errors.** `CloudTransportError` (`scripts/cloud/errors.ts`, internal; the CLI still exits 0/1/2/64)
  carries `code` (`cloud_ssh_auth_timeout`, `cloud_ssh_unavailable`, `cloud_host_busy`,
  `cloud_host_identity_mismatch`), `commandStarted` (`no` or `unknown`) and `retryable`. After a lost
  answer to a state change `commandStarted` is `unknown` and `retryable` is `false`: the PM-735 coordinator
  reconciles the machine's state (`status`) before it acts again. Status 255/124 alone never proves EIC:
  `cloud_ssh_auth_timeout` is used only when SSH rejected the key **and** the host journal shows EIC
  status 124 events in the last 10 minutes. The message keeps the _connection diagnosis_ (what the logs
  prove) apart from the _suspected cause_ (what load, memory and OOM measurements hint at, not proven).
  A failed cleanup keeps the main failure visible (`FAIL operation before SSM cleanup`), and only
  the sessions with this invocation's reasons are terminated.

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
3. `deploy --ref <approved-sha>` updates the installed board with the bundle built at that SHA. The
   first seeding of a host (`seed`) is retired (PM-1116; commit `358bb7c7` on `main`, tagged `retired-migrate-dns`, has it).
4. Verify `status`, `logs` and `rehearse` (requires `REHEARSAL PASSED`). In the approved downtime
   window, `stop`, `pull-data --to <new-directory>` and `start` verify one-writer behavior and the
   return stream. Keep the copy outside a git worktree; never copy a running database.
5. Exercise Ctrl-C during a disposable image transfer. Confirm local SSH/plugin descendants
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

## Common backup/Cloudflare guide (PM-532)

This guide sets up the board in the cloud so that it is reachable when your Mac is off: one AWS
EC2 machine that runs the container of [HYBRID.md](HYBRID.md) (`deploy/cloud/Dockerfile`), two
S3 buckets for the backups, and Cloudflare (tunnel and Access) in front. You run everything from
your own Mac with one command, `npm run cloud -- <command>`, with your own logins. No member of the
team, human or AI, gets an AWS or Cloudflare secret: the commands are yours to run.

The CLI and this guide cover the four parts of PM-532 (PM-534 to PM-537).

## Overview and cost

```
 browser / engine ──► Cloudflare (Access) ──► tunnel ──► EC2 machine ─ container ─ server
                                                         (no open port)    ├ Litestream ─► S3 bucket (database)
                                                                           └ restic     ─► S3 bucket (the rest)
```

| Part                             | Cost (about, per month)                                                     |
| -------------------------------- | --------------------------------------------------------------------------- |
| EC2 machine                      | instance hours, root volume and public IPv4 (the cost components of step 4) |
| S3 buckets (database, backups)   | a few cents (a small database, deduplicated backups)                        |
| Cloudflare Free (tunnel, Access) | 0 USD (Access is free up to 50 users)                                       |
| Route 53 hosted zone (kept)      | 0.50 USD, only while the zone is kept as a fallback                         |

Nothing listens on a public address: the machine's security group has no inbound rule (SSH goes
through SSM); the tunnel connects outwards. One machine runs one writer to the database, which
Litestream needs.

## The owner's manual steps

Short and in order: account setup, local credentials, and commands that the owner runs.

1. **Cloudflare account:** protect it with a passkey (or two-factor authentication) and save recovery codes.
2. **Zero Trust:** choose the team name and the Free plan in the dashboard.
3. **API token:** use the rights in "The Cloudflare token" below, with about 90 days of validity;
   save only the token in `~/.config/projectman/cloud/cloudflare-token`, mode 600.
4. **AWS login:** install CLI v2 (`brew install awscli`) and sign in as the compute profile
   (`aws.profile`, for example `aroom`) with MFA/passkey.
   Do this only after PM-533 is released: AI sessions must be denied access to `~/.aws`.
   Check `aws --version` and `aws sts get-caller-identity --profile <aws.profile>`.
5. **Configuration:** fill `config.json` from `deploy/aws/config.example.json`, including unique bucket names.
6. **DNS delegation:** done (PM-537); the commands that moved it are retired (see "DNS" below). The domain is managed
   through **Route 53 Domains**, even though RDAP names Gandi as the underlying registrar.
   Check automatic renewal: the owner's recorded expiration is **2026-11-19**; `dns status` reads the current value.
7. **First setup:** use the one-time code in `logs`.
8. **Public checks:** `brew install cloudflared`, `cloudflared access login https://<hostname>`,
   then create the mode-600 `login.json` described in "Verification" for `check`.
9. **Backup password:** copy `RESTIC_PASSWORD` from `cloud.env` into your password manager after `aws`.
10. **Engine:** set `linkHeadersFile` to `~/.config/projectman/cloud/engine-access-token.json`
    as in [HYBRID.md](HYBRID.md).
11. **Later:** manually delete the old Route 53 hosted zone when the owner decides; the delegation cannot be
    switched back by the tool any more.

The AWS profile needs the EC2 and IAM rights of "EC2 central account and provisioning" above, the S3 actions `CreateBucket`, `ListBucket`, `GetBucketVersioning`,
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

| File                                                                               | Content                                                                    | Written by                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| `config.json`                                                                      | the settings; no secret (`--config <file>` names another)                  | you (start from `deploy/aws/config.example.json`) |
| `cloudflare-token`                                                                 | the Cloudflare API token (PM-536)                                          | you                                               |
| `cloud.env`                                                                        | the container's environment, docker env-file format                        | `npm run cloud` (below)                           |
| `engine-access-token.json`                                                         | the engine's Access service token (`linkHeadersFile` format)               | `npm run cloud -- edge`                           |
| `integrator-access-token.json`                                                     | the integrator's service token (only with `access.integratorServiceToken`) | `npm run cloud -- edge`                           |
| `owners/<id>/engine-access-token.json`, `owners/<id>/integrator-access-token.json` | a further owner's own two service tokens (`access.owners`, PM-1065)        | `npm run cloud -- edge`                           |

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
| `aws.compute`                            | `ec2`                                        | only `ec2` exists; any other value is refused with a message that names the fix                     |
| `aws.profile`                            | required                                     | the AWS CLI profile of compute, S3 and IAM; not `i` (the registrar profile)                         |
| `aws.ec2`                                | required                                     | explicit type, AMI, existing VPC/subnet, integer root volume GiB (20–1024)                          |
| `aws.region`                             | required                                     | for example `eu-west-1`                                                                             |
| `aws.availabilityZone`                   | none                                         |                                                                                                     |
| `aws.instanceName`                       | `projectman-cloud`                           | also the prefix of the IAM users                                                                    |
| `aws.databaseBucket`, `aws.backupBucket` | required, different                          | S3 names, lowercase, no dots                                                                        |
| `repository.url`                         | `https://github.com/janoist1/projectman.git` | what the machine builds                                                                             |
| `cloudflare.zone`, `.hostname`           | required                                     | the zone (`example.com`) and the board's name in it (`board.example.com`, one label under the zone) |
| `cloudflare.feedbackHostname`            | none                                         | the feedback widget's own name (HYBRID.md); one label under the zone, not the board's               |
| `cloudflare.accountId`                   | the only account the token sees              | needed when the token sees more than one account                                                    |
| `cloudflare.tunnelName`                  | `aws.instanceName`                           | the tunnel's name, and the prefix of the Access applications, policies and service tokens (`<N>`)   |
| `cloudflare.tokenFile`                   | `<secrets store>/cloudflare-token`           | an absolute path or `~/…`                                                                           |
| `access.emails`                          | required                                     | the exact e-mail addresses that may log in; no wildcard, no domain                                  |
| `access.sessionDuration`                 | `24h`                                        | the Access session (`30m`, `24h`)                                                                   |
| `access.integratorServiceToken`          | `false`                                      | make a second service token for the integrator's smoke test                                         |
| `releaseTarget`                          | none                                         | Retired; accepted for compatibility and ignored with a warning                                      |
| `hybrid`                                 | none                                         | Retired; accepted for compatibility and ignored with a warning                                      |
| `route53.hostedZoneId`                   | looked up by name                            | used from PM-537                                                                                    |
| `route53.profile`                        | `aws.profile`                                | independent registrar and retained Route 53 source account; PM-664 uses `i`                         |
| `ses.profile`                            | `aws.profile`                                | the account of the SES identity and sender IAM user (PM-729 uses `i`); not the compute account      |

`cloud.env` is a docker env-file: `NAME=value`, one per line, no quotes. `npm run cloud` sets only
the names it owns and keeps every other line and comment: `aws` writes the S3 names and keys,
`edge` writes `TUNNEL_TOKEN` and `PROJECTMAN_FEEDBACK_PUBLIC_URL`. The machine gets the file with `deploy`.

## The AWS resources

`npm run cloud -- preflight` checks, without changing anything: the `aws` CLI is version 2; the
profile logs in in the region (the account id is printed); the EC2 prerequisites of "EC2 central
account and provisioning" above hold; the modes of the secrets store are right. Then the Cloudflare
part (see "Cloudflare" below): the token is active, the account is found, Zero Trust is on, and one
reading call per right the token needs. It changes nothing, in either cloud.

`npm run cloud -- aws [--dry-run] [--rotate-keys]` creates, in this order, whatever is missing:

1. **The EC2 machine**, its host role and security group (empty inbound, IMDSv2 only), as described
   in "EC2 central account and provisioning" above, step 5. If the machine exists with another
   configuration, the command exits 2 and changes nothing.
2. **The buckets**: created in the region (checked with `--expected-bucket-owner`; a name that is
   someone else's exits 2), all four public-access blocks on, AES256 encryption with a bucket key,
   a rule that aborts unfinished multipart uploads after 7 days (other lifecycle rules are kept).
   Versioning must not be on (Litestream and restic keep their own history): an enabled bucket
   exits 2.
3. **Two IAM users**, `<instanceName>-litestream` (the database bucket) and `<instanceName>-restic`
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

4. **Access keys.** The machine's role has SSM rights only, so the two users have static keys. A new
   key goes straight into `cloud.env` (the secret never appears on the screen or in an argument).
   If the user has a key that `cloud.env` does not hold as an active key, the command exits 2: AWS
   never shows a secret again. `--rotate-keys` makes a new key, writes it, then deletes the old ones
   (an IAM user holds two at most, so with two old keys one is deleted first); afterwards the machine
   needs a `deploy` to get the new `cloud.env`.
5. **`cloud.env`** gets `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT` (`https://s3.<region>.amazonaws.com`),
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

| Command                                 | What it does                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy [--ref <tag\|sha>] [--dry-run]` | installs the machine (idempotent), sends `cloud.env` and the image of the bundle, starts it, waits up to 180 s for health, goes back to the old image if none |
| `rollback [--dry-run]`                  | starts the previous image (the one before the current), waits for health                                                                                      |
| `status`                                | the state of the EC2 machine, the unit, the container and its health, the deploy history, disk and memory                                                     |
| `logs [--lines <n>]`                    | the last `n` lines (default 200, at most 10000) of the unit's log (`journalctl`)                                                                              |
| `ssh`                                   | a shell on the machine, with the same safe connection                                                                                                         |
| `stop [--dry-run]`, `start [--dry-run]` | stop the board (data stays, the unit is disabled); start the current image again and wait for health                                                          |
| `rehearse`                              | the restore rehearsal of HYBRID.md in a scratch container on the machine; passes only on the line `REHEARSAL PASSED`                                          |
| `pull-data --to <new dir> [--dry-run]`  | copies the stopped board's data to a new directory on your Mac                                                                                                |

`--dry-run` reads only and never connects: no SSH.

### What `deploy` does

1. **The ref.** Without `--ref` the newest release tag of `repository.url` (`git ls-remote --tags`):
   tags look like `vYYYY.M.D` and `vYYYY.M.D.N` (the N-th later release of a day); they are ordered
   by number, not by text. `--ref` takes a tag or a 40-digit commit id. The image is tagged with the
   full commit id and is also what the server reports as its version (`PROJECTMAN_VERSION`), the same
   id the engine compares.
2. **`cloud.env`** (from `npm run cloud -- aws`) is read; a missing file or missing bucket keys is
   exit 2. Its secrets are sent on the standard input of `ssh` only, never in an argument, and are
   written on the machine to `/etc/projectman/cloud.env` (root only, mode 600).
3. **`bootstrap`** installs `jq` first and atomically sets
   `/etc/docker/daemon.json` `features.containerd-snapshotter=false` before installing Docker or
   dependencies that might start it (PM-725). It preserves unrelated JSON settings and refuses
   malformed configuration, symlinks and non-regular files. The new file is root:root, mode 0644.
   The host requires the classic `overlay2` image store so immutable image IDs remain config digests.
   Bootstrap checks the actual daemon's `Driver` and `DriverStatus`, restarts an existing unsupported
   store only when the board is provably stopped and neither current nor previous deploy history exists,
   and checks the result. Unavailable or malformed daemon information stops bootstrap; a running classic
   daemon needs no restart. Repeated bootstrap is safe.
   It also installs git, turns on unattended upgrades, makes a 2 GB swap file, and installs the unit file.
4. **`receive-image`** imports the bundle's archive of the commit (see "Prebuilt ARM images"); the
   machine never builds an image. Old images beyond the current and the previous one are removed.
5. **`start`** writes `/etc/projectman/image.env` (`IMAGE=projectman-cloud:<sha>`) and
   `/var/lib/projectman/deploy.json` (`current`, `previous`, `lastStoppedAt`), then restarts the unit.
6. **Health.** The command polls the container's health check every 5 s for 180 s. If it never
   becomes healthy, it prints the last 200 log lines and, when there is an earlier image, starts it
   again (and exits 1 either way).

An older build refuses a database a newer build has migrated. Therefore every `deploy` that has to
go back, and every `rollback`, prints when the board last stopped before the update
(`lastStoppedAt`) and how to restore the database to that moment
([Restoring the database to a point in time](#restoring-the-database-to-a-point-in-time)).

`receive-image` and `start` check the actual classic store under the image lock before import, board
stop, metadata writes or unit start. Unsupported stores are refused (exit 3); unreadable or malformed
daemon information fails (exit 1). Image ID, platform, revision and version checks remain strict.
Changing stores [hides images and containers from the previous store](https://docs.docker.com/engine/storage/containerd/)
without deleting them. After a permitted stopped-host switch, import the approved bundle again through
`receive-image`; the prior import is not available in the classic store. Bootstrap does not migrate or
prune store data and leaves `/var/lib/projectman/data` intact. Hosts with retained deploy history need
an explicit recovery plan instead of an automatic switch. Live cutover stays within PM-675's approved
procedure; this bootstrap change grants no additional live-operation permission.

### The machine's files

| Path                                           | What                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/etc/systemd/system/projectman-cloud.service` | the unit (`deploy/aws/projectman-cloud.service`); no published port, only `/data` is mounted                  |
| `/etc/projectman/cloud.env`                    | the container's environment (root only, 600)                                                                  |
| `/etc/projectman/image.env`                    | the image the unit runs                                                                                       |
| `/etc/docker/daemon.json`                      | explicit classic image store (`features.containerd-snapshotter=false`); unrelated settings preserved (PM-725) |
| `/var/lib/projectman/data`                     | the board's data (`/data` in the container, owner 10001, mode 700)                                            |
| `/var/lib/projectman/deploy.json`              | the deploy history and the time the board last stopped                                                        |

The SSH connection is the EC2 one (SSM and EC2 Instance Connect with an ephemeral key, no inbound
rule); it is described in the EC2 chapter above.

### `pull-data`

The first move of the Mac's data to the machine (`seed`) is done and retired (PM-1116); the last commit
that has it is `358bb7c7` on `main`, tagged `retired-migrate-dns`. The machine keeps its data between deploys.

`pull-data --to <new folder>` is the way back (`npm run migrate -- hybrid back` takes the folder).
The folder must not exist (its parent must), must not be inside a git work tree, and is created with
mode 700. The board must be stopped first (`npm run cloud -- stop`): a copy of a live database is no
copy. A failed download removes the folder. The command prints what in the copy the way back would
refuse.

### Retired release configuration (PM-1113)

The old `releaseTarget` and `hybrid` keys are accepted for existing configuration files,
but ignored with a warning. Deployment strips stale `PROJECTMAN_RELEASE_*` lines from the
environment sent to the host. There is no `release-control` or `release-probe` command.
Use `npm run cloud -- deploy --ref <commit>` and the publication procedure in [DEPLOY.md](DEPLOY.md).

### What was not tried

The team could not run any of this against a real AWS account. `deploy/aws/host.sh` is checked for
syntax and for what it must never do (no published port, no host network, no privileged container,
no Docker socket), and the commands against a fake `aws`, `ssh` and machine. The first real run is
yours: `status` first (it needs only the machine), then `deploy --dry-run`. The least certain part
is the SSH connection through SSM: `status` shows whether it works.

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

`npm run cloud -- edge [--dry-run] [--rotate-engine-token] [--rotate-integrator-token] [--rotate-owner-token <id>]`, in this order:

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

   **Further owners (PM-1065).** Each entry of `access.owners` (`id`, `name`, and an `email` that private
   board mode requires) gets its own pair of service tokens, `<N>-owner-<id>-engine` and
   `<N>-owner-<id>-integrator`, its own two service policies `<N>-owner-<id>-engine-service` and
   `<N>-owner-<id>-integrator-service`, and its own files `owners/<id>/engine-access-token.json` and
   `owners/<id>/integrator-access-token.json` (folder 700, files 600). An owner needs
   `cloudflare.integratorHostname`. The owner's policies are added after the host's on the engine
   application and on the integrator application; the board application is unchanged, and in private
   mode the owner's `email` joins the allow list. The host's token, policy and file never change. A
   token that exists while the host's copy is missing or foreign is _skipped_ (exit 0, with a hint):
   `--rotate-owner-token <id>` makes both of that owner's secrets anew and writes the files (an id that
   is not in `access.owners` is refused). Removing an owner from `access.owners` deletes only that
   owner's objects, in this order: policies, tokens, then the files and the folder (a folder that holds
   other files stays). The file goes to the owner by hand, outside projectman.

8. **The tunnel** `<N>` (managed from Cloudflare, `config_src: cloudflare`; a tunnel that is configured
   from a local file exits 2) and its **ingress**: `/hooks*` and `/mcp/*` answer 404 (the board's
   webhook and member MCP doors stay closed to the world; the bare `/mcp` is the integrator's bearer endpoint, PM-760), the board's name goes to `127.0.0.1:4700` with the
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
  `access.emails` (and the owners' `email`s) and the service policies, the owners' included, exactly
  their token;
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
  their meaning; with `access.integratorServiceToken`, an explicit `cloudflare.integratorHostname`
  is required in public mode. Its `<N>-integrator` application has only the integrator Service Auth
  policy. The token has no rights on the main or engine application.
- **Ingress.** With a feedback name, its `^/feedback/` goes to `127.0.0.1:4700` and the rest of that name
  is 404 (unchanged). On the main name: `^/hooks`, `^/mcp/` and exact `/mcp` answer 404;
  `^/engine(/|$)` goes to the port with `originRequest.access` required, the team
  name and **the audience tag of the engine application only**; everything else on the name goes to the
  port with no audience check (the board's login guards it); the last rule is 404.
- **`cloud.env`** gets `PROJECTMAN_PUBLIC_BOARD=1`; in `private` mode `edge` removes the line.

**Separate integrator host (PM-675).** `cloudflare.integratorHostname` has no default. Choose an
explicit lowercase `<label>.<zone>` distinct from the board and widget; it requires
`access.integratorServiceToken=true`. Private configurations without it remain compatible.
The same tunnel serves only literal `/api/...` and exact `/mcp` there, with only the integrator
application's audience; its catch-all is 404. There is no Host override or path alias.
`edge` writes `PROJECTMAN_INTEGRATOR_HOSTNAME` to `cloud.env`. The server isolates this host in
private mode too: bearer authentication on any other host is 403 `integrator_host_required`,
the board's bare `/mcp` is 404, and the machine host refuses cookie-only requests (401) and
non-machine routes (404). A valid `pmi_` key still needs its existing mode, scope and owner rights.
The board's owner-only key management, audit and human decisions stay on the cookie API.

Stage the new guard in private mode first: private `edge` → new-image `deploy` → `publish` → private
`check`, then change the integrator client's `baseUrl` to the machine origin and prove its REST/MCP
calls. `publish` also publishes this configured hostname, without a new flag, only after verifying
its exact Access application, ingress, environment and running backend. `host.sh public-check
<boardHostname> [integratorHostname]` retains its five fields and adds `integratorHostIsolated` when
the second argument is present. It must be true: a dummy bearer on the board gets the host-required
403, the machine API without a bearer gets 401 and machine `/ws` gets 404. This gate also applies to
private staging; it does not require `publicBoard=true` until the subsequent public switch.

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

## DNS (PM-537, one-off move retired in PM-1116)

The zone moved to Cloudflare once, including mail (SES MX, DKIM and verification TXT) and site
verification. The commands that did it (`dns plan`, `dns import`, `dns verify`, `dns switch [--back]`) are
retired; the last commit that has them is `358bb7c7` on `main`, tagged `retired-migrate-dns`. What stays is the read-only
`npm run cloud -- dns status`: it reads delegation and DS through Cloudflare and Google DoH, reports the
registrar name servers, the DNSSEC key count, the registration expiry and auto-renew, and requests an
activation check for a pending zone. Both public resolver answers are printed; allow cached delegation to
expire. An unavailable registrar API is a warning, and the Cloudflare activation is still reported.
Renewal disabled or expiration within 30 days produces a warning. The registrar API calls use `us-east-1`
irrespective of the machine's region, as required by the
[AWS CLI reference](https://docs.aws.amazon.com/cli/latest/reference/route53domains/get-domain-detail.html).

All imported records are DNS-only (`proxied: false`); `publish` adds the tunnel records separately.
Cloudflare's automatic scan is disabled by `edge`. Test **SES receiving and DKIM** after any change.

**There is no delegation rollback in the tools.** The old Route 53 hosted zone is kept until the owner
deletes it manually (about USD 0.50/month); records changed in Cloudflare since the move are not in it.
If delegation ever has to go back, it is a manual step in Route 53 Domains by the owner, and the same
mail and delivery checks follow. [CLOUD-CUTOVER.md](CLOUD-CUTOVER.md) (the return to the Mac) does
not switch DNS back either.

### `up`

`npm run cloud -- up [--login-json <file>] [--dry-run]` runs `preflight` → `aws` → `edge` → `deploy`.
If the zone is active it continues with `publish`, then `check` when a login file is supplied.
A pending zone prints `dns status` (run it until active) and stops before publish.
It never changes delegation.
The first failure stops the sequence with that command's exit status. Dry-run passes through the provisioning
steps without writes and skips the live login check.

## Verification

`npm run cloud -- check --login-json <file>` verifies the Cloudflare security conditions in
[SECURITY.md](SECURITY.md#public-entrance-through-cloudflare-pm-200-pm-210) and the deployment in
[HYBRID.md](HYBRID.md#smoke-test) against `https://<cloudflare.hostname>`. Before the first run sign in to
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
3. **The integrator boundary** with a configured machine hostname: absent and engine tokens cannot
   enter, the integrator Access token without an application bearer gets 401, and non-machine
   paths get 404. `check.sh` also deliberately sends a valid human cookie to the machine host
   (401), and checks the board's bearer refusal and bare MCP closure. Secrets use protected files
   and child environments, never command arguments. Legacy private configurations without the
   hostname retain `deploy/cloud/smoke.sh`; with no integrator token that group is `skipped`.

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
2. Terminate the broken machine in the EC2 console (or let the new one have another name in
   `aws.instanceName`). `npm run cloud -- aws` creates a new machine and keys; the
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

   Give the restored database a new event generation, so that no reader continues a cursor it got from
   the journal that was lost (the database in place keeps its old one, and its cursors would otherwise
   point into a different history; they are then refused with `event_cursor_expired` and the reader
   starts again from the beginning of the journal):

   ```sh
   sudo sqlite3 /var/lib/projectman/data/db.sqlite \
     "UPDATE instance_meta SET value = lower(hex(randomblob(16))) WHERE key = 'project_change_generation'"
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
3. Terminate the EC2 machine (console, or `aws ec2 terminate-instances --instance-ids <id>
--profile <aws.profile> --region <region>`). Delete the `<instanceName>-cloud` security group
   afterwards; the auto-assigned public IPv4 goes with the instance.
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

**Scripted SES provisioning (PM-678, own account PM-729).** Add the optional version-1 configuration explicitly:

```json
"ses": { "profile": "i", "region": "eu-west-1", "domain": "istvan.io", "from": "login@istvan.io" }
```

Choose the profile, region and sender before running; this is an example, not a default. The address must
belong to exactly `ses.domain`, and that domain must be in the configured Cloudflare zone. Without `ses`,
every SES command refuses (exit 2) and email login stays unchanged. `ses.profile` is optional and names the
AWS account that owns the SES identity, the production access and the narrow sender IAM user; absent, it is
`aws.profile`, so an older configuration resolves to the same account as before (the file is never
rewritten). The PM-729 layout keeps the domain, its mail sending and `ses.profile: "i"` together, while
`aws.profile: "aroom"` stays the account of the server (EC2, S3, host IAM). These are two separate purposes:
the compute/S3/host IAM rights belong to `aws.profile`, the SES identity and the `<instanceName>-ses` user
to `ses.profile`; `route53.profile` is not a SES fallback. The SES commands never move the domain or change
delegation. The EC2 rule that `aws.profile` is explicit and not `i` is unchanged. Every AWS call uses
explicit `--profile <ses.profile>` and `--region <ses.region>` (the SES region may differ from the compute
region). Cloudflare's existing active zone proves the identity; no cross-account sending authorization is
needed. An existing identity and its DKIM tokens in that account and region are recognised and kept;
identities and DKIM records of other accounts or regions are left alone (cleaning them up is a separate
owner action, not part of configure).

**Moving SES to another account (PM-729).** The old SES key in `cloud.env` belongs to the former account, so
`ses configure` refuses it (exit 2, nothing changed) when it finds no matching key in the new account. The
integrator therefore first makes a protected mode-600 copy of the config and `cloud.env`, removes only
`PROJECTMAN_SES_ACCESS_KEY_ID`, `PROJECTMAN_SES_SECRET_ACCESS_KEY` and `PROJECTMAN_SES_SESSION_TOKEN` from the
local env and sets `PROJECTMAN_EMAIL_LOGIN_ENABLED=0` (do not deploy that intermediate env), then runs
`ses plan`, `ses configure --dry-run`, `ses configure` and `ses check` with the new profile. Old-account
resources are removed only after the new path is green and the backend uses the new env.

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

## Receiving e-mail replies (SES receiving → SNS → SQS, PM-945)

The e-mail channel (PM-941, PM-943) lets an AI member write to a consenting human; this part lets the human
answer by mail. The reply goes to a reply address on a **subdomain of its own**, so the zone's and the
login sender's normal mail (MX, SPF, DMARC) stays untouched:

```
reply to <token>@reply.istvan.io
 → MX 10 inbound-smtp.<ses.region>.amazonaws.com (DNS-only, Cloudflare)
 → SES receipt rule set "<instanceName>-email" (spam and virus scan on, TLS optional)
 → SNS topic "<instanceName>-email-in" (the mail as base64 in the message)
 → SQS queue "<instanceName>-email-in" (dead-letter queue "<instanceName>-email-in-dlq", after 5 tries)
 → the hub's queue reader (long poll, 20 s) → the e-mail channel's inbound handling
```

Bounces, complaints and deliveries of the mails the hub sends arrive on the same topic: the hub sends
through the configuration set `<instanceName>-email`, whose event destination publishes BOUNCE, COMPLAINT,
DELIVERY and REJECT to it.

**Settings.** Add the optional field to the `ses` block (the old configuration stays valid; without it the
three receiving commands refuse with exit 2 and the sending side is unchanged):

```json
"ses": { "profile": "i", "region": "eu-west-1", "domain": "istvan.io", "from": "login@istvan.io",
         "inbound": { "replyDomain": "reply.istvan.io" } }
```

`replyDomain` must be a proper subdomain of `cloudflare.zone` and must differ from `ses.domain`. The
receiving commands use the same profile and region as `ses`; SES receiving is available only in some
regions, `ses.region` must be one of them. `receive-configure` writes these lines to the protected
`cloud.env` (no secret among them): `PROJECTMAN_EMAIL_CHANNEL_ENABLED=1`, `PROJECTMAN_EMAIL_REPLY_DOMAIN`,
`PROJECTMAN_EMAIL_QUEUE_URL`, `PROJECTMAN_EMAIL_CONFIGURATION_SET`. The hub starts its queue reader when the
queue URL is set and uses the `PROJECTMAN_SES_*` key it already has (no new key).

**The owner's steps** (each live change approved separately; the AI members run only the first, and the
tests use stateful fakes of `aws` and Cloudflare):

1. `npm run cloud -- ses receive-plan`: read only. Prints, for each resource below, `would create`,
   `would update` or `unchanged`, and the cost estimate. It refuses (exit 2) on a conflict.
2. `npm run cloud -- ses receive-configure --dry-run`, then, after the owner approves the preview,
   `npm run cloud -- ses receive-configure`. Idempotent; creates in this order: the SES identity of the
   reply domain and its DKIM CNAMEs, the SNS topic and its policy, the dead-letter queue, the queue (its
   policy, the redrive to the dead-letter queue after 5 receives, 14 days retention on the dead-letter queue),
   the raw SNS→SQS subscription, the configuration set and its event destination, the receipt rule set
   and rule (recipient: the reply domain), the active rule set, the sender's IAM policy, the `cloud.env`
   lines, and **last the MX record**, so no mail arrives before everything behind it is ready.
3. `npm run cloud -- ses receive-check`: sends no mail. Checks that the reply identity is verified with DKIM
   SUCCESS, the MX, that the active rule set is ours, and that rule, topic, queue, dead-letter queue,
   subscription, policies and `cloud.env` match; prints the number of messages in the dead-letter queue.
   A deviation exits 1, a missing precondition 2. Wait for DKIM to turn SUCCESS (DNS), then run it.
4. Approve `npm run cloud -- deploy` to carry the new `cloud.env` lines to the hub. Approve the first real
   reply trial separately.

**What is refused (exit 2, nothing changed, also in `--dry-run` and `receive-plan`).** Another active
receipt rule set in the region (an account has one active rule set; this command will not replace or change a
foreign one); an existing topic, queue or other resource of the name that does not carry the tag
`projectman=cloud`, or a foreign subscription or rule; a CNAME or a different MX at the reply name; no sender
yet (run `ses configure` first). The sender's IAM user `<instanceName>-ses` has these statements:

- `ses:SendEmail` on the sender domain identity, with `StringEquals ses:FromAddress` equal to `ses.from`.
- `ses:SendEmail` on the reply domain identity, with `StringLike ses:FromAddress` equal to `*@<replyDomain>`.
- `ses:SendEmail` on the configuration set, with `StringLike ses:FromAddress` allowing both `ses.from` and
  `*@<replyDomain>`.
- `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility` on the one queue.

There is no wildcard resource and no `SendRawEmail`. `ses configure` preserves receiving permissions and
upgrades the old PM-945 policy when `ses.inbound.replyDomain` is configured; `ses check` reports that old
policy as drift until upgraded.
The topic admits only `ses.amazonaws.com` of this account (`aws:SourceAccount`), the queue only this topic
(`aws:SourceArn`).

Channel mails go out from the member's own mailbox on the reply domain (PM-1017). Until the sender's
`ses:FromAddress` condition admits those addresses, SES refuses them (`AccessDenied`); the hub then sends the
mail once more from `PROJECTMAN_SES_FROM` and logs a warning naming `ses receive-configure`.

**Cost** (printed by the plan; check [SES pricing](https://aws.amazon.com/ses/pricing/) for the current
figures): receiving about 0.10 USD per 1000 mails plus about 0.09 USD per 1000 chunks of 256 kB of incoming
mail; the SNS and SQS requests of a few hundred mails stay inside the free tier. Sending is unchanged.

**Rollback.** Stop the intake first: delete the MX record of the reply domain (or disable the active receipt
rule set with `aws ses set-active-receipt-rule-set` without a name). Then, if wanted, clear
`PROJECTMAN_EMAIL_QUEUE_URL` from `cloud.env` and `deploy`. The commands delete nothing; the resources are
cheap and can be removed by hand in the owner's account.

**Known limit.** SNS messages are at most 150 kB in the SES action, so a larger incoming mail (attachments)
does not reach the queue: SES bounces such a mail. Replies are short text, so this is accepted; a later card
can switch the rule to an S3 action and read the mail from the bucket if it proves too small.

**Mail to a member (PM-989).** The same rule receives the mail written to an AI member's own address
(`<handle>@<replyDomain>`, no new DNS, rule or queue). The 150 kB limit above counts the attachments of
such a mail too. Members also send from their own address; the system sender remains available for login
codes. After merging PM-1016, the owner runs `npm run cloud -- ses receive-configure --dry-run`, approves
the IAM change, then runs `npm run cloud -- ses receive-configure` and `npm run cloud -- ses receive-check`.
The existing reply identity and DKIM are reused; no new DNS record is needed for member sending.
Replies arrive at the member's own address; In-Reply-To or References headers link them to the
conversation and card (PM-1018). Token reply addresses remain for the shared-sender fallback and
older mail, until their 60-day expiry.

**The reader.** `createSqsInboundSource` (`apps/server/src/services/email-channel/sqs-source.ts`) long-polls
the queue (up to 10 messages, 20 s wait, 60 s visibility), hands a mail or a delivery event to the channel
and deletes the message when it is handled, a duplicate, ignored or dropped. When handling throws, the message
stays and SQS delivers it again (the dead-letter queue takes it after 5 tries). On an SQS error the reader
waits 1 s, doubling to 60 s, and logs only the error name, never the key or the queue URL. Shutdown waits
for the batch being processed.

**Does this work on a remote engine?** Yes. Everything runs in the hub (the cloud board) and in the owner's
provisioning CLI; the engine gets no key, no queue and no protocol change.

## What this does not cover

- A live trial: nothing here was run against a real AWS account by the team. The first real run is
  yours; start with `preflight` and `aws --dry-run`.
- Update the cloud with the owner-requested `cloud deploy` and rebuild/reinstall the Mac engine at the same commit (PM-1113; [DEPLOY.md](DEPLOY.md)).
- Several machines: one machine means one database writer.
- AWS Organizations, SSO session renewal, billing alarms: set them up in your AWS account.
