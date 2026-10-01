# The managed VM profile

A reproducible Ubuntu guest that runs projectman apart from the owner's own machine (PM-137,
the first part of PM-135). It is built from files in `deploy/vm/` and measured by a readiness
report. The same files build a rented Ubuntu server later (PM-45): a Mac with Multipass is only
the first place to run them. This is **not** a live migration: it starts from an empty machine,
and the owner's running instance is not touched.

What this part delivers, and what it does not:

| Delivered here                                                                 | Later part of PM-135                                                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinned Node and CLI versions, a root-owned app, a separate service account     | The protected launcher that starts each session as a worker (PM-140)                                                                                              |
| One unprivileged account per member, no sudo, no shared home                   | Domain-level network gate and the limited publishing gate (PM-140)                                                                                                |
| Egress rules that close the private side of the network to the service/workers | Per-member, per-repository workstations (PM-138)                                                                                                                  |
| A readiness report with a strict verdict rule, probes with positive controls   | Delegated exit requests (PM-139); the question-free profile (PM-141, [below](#the-question-free-profile-pm-141))                                                  |
| Backup and restore, a measurement helper, the manual trial steps (below)       | Trial run, data move and rollback: the tool, scripts and procedure are built (PM-143, [MIGRATION.md](MIGRATION.md)); running them on a real VM is a person's step |

Until PM-140 lands, the runner still starts the agent CLIs as the **service** account, so the
workers exist and are measured but do not run sessions yet. The egress rules therefore confine
the service account as well: its CLIs reach the internet and loopback, never the host, the LAN or
the tailnet. Read [SECURITY.md](SECURITY.md) for what this does and does not protect.

## Why Multipass on the Mac

Multipass is already on the owner's Mac, runs the same Ubuntu Server image a rented server uses,
takes a cloud-init file, shares no folder with the Mac unless someone runs `multipass mount`
(never run here), and a throwaway instance is one command to delete. Lima would need installing;
UTM and Parallels are manual GUI work that cannot be reproduced from a file. Docker Desktop is a
container, not the machine the profile describes. The existing `debian-vm` instance and the
`primary` instance (Multipass mounts the home directory into it) are never used.

## Layout: who may do what

| Path                                                  | Owner / mode                | Service | Worker | Notes                                                      |
| ----------------------------------------------------- | --------------------------- | ------- | ------ | ---------------------------------------------------------- |
| `/srv/projectman` (app, `DEPLOYED_COMMIT`)            | root:root 0755              | read    | read   | Built as the service in a staging dir, then handed to root |
| `/opt/projectman/cli` (pinned `claude`, `codex`)      | root:root 0755              | read    | read   | Auto-update off; changes only when the profile changes     |
| `/etc/projectman` (`profile.env`, `gate.nft`)         | root:root 0755 / files 0644 | read    | read   | The boundary settings; no secret in them                   |
| `/etc/systemd/system/projectman*.service`             | root:root 0644              | read    | read   |                                                            |
| `/var/lib/projectman-boundary` (readiness report)     | root:root 0755              | read    | read   | Statuses and evidence only                                 |
| `/var/lib/projectman` (service home, CLI login state) | projectman 0700             | own     | none   | Provider logins, transcripts of service-run sessions       |
| `/var/lib/projectman/data` (`PROJECTMAN_HOME`)        | projectman 0700             | own     | none   | SQLite, cookie secret, attachments, memory, worktrees      |
| `/var/lib/projectman-work/<handle>` (worker home)     | pmw-<handle> 0750           | read    | own    | Group `pmw-<handle>` has the service as its only member    |

- **Accounts.** The service is `projectman` (uid 19000). Each member's worker is `pmw-<handle>`
  (uid from 20000 up, own group, `nologin` shell, locked password, in no other group, not in sshd's
  `AllowUsers`). Nobody but the admin (the human who administers the machine) has sudo; the service
  and the workers have none, and `NoNewPrivileges` holds for the service.
- **A worker cannot change** the app, the CLIs, the service unit, the egress rules, the profile,
  the cookie secret, the SQLite database or any other account's token or home. The service is held
  to the same limit for everything that is root's: it cannot rewrite its own app or the boundary.
- **Launcher / PTY (PM-140, to be built).** The launcher is root-owned and runs as a small
  privileged helper that may only (1) start a session as `pmw-<handle>` for a member the server
  names, in that worker's home or workspace, with a clean environment (no ssh agent socket, no API
  key variables, the member's own hook/MCP token in memory or the environment, never in a file a
  worker can read), and (2) pass the PTY back to the service. It grants the service no shell as the
  worker and the worker nothing of the service. It does not exist yet; verify.sh reports it
  `unverified` instead of passing it.
- **Transcripts.** A CLI writes its transcript in the home of the account that runs it (see
  [PROVIDERS.md](PROVIDERS.md)). Worker homes are group-readable by the service only, so the
  server can read the transcripts of worker-run sessions and a worker cannot read another's.
  Transcripts may hold anything the member typed or a tool printed: they are not secret-free, so
  they live only inside the backed-up trees below and are never copied into readiness evidence.
- **CLI login.** The subscription login is a human step, done once per provider as the service
  account in the VM (`sudo -iu projectman`, then `claude auth login`, `codex login`). The login is
  never typed on the Mac and never copied from it. The profile forbids a standing copy of it in a
  worker home (verify.sh looks for the well-known login files there and for loose modes in the
  service home). How a worker session gets provider authentication without such a copy is the
  launcher's design question (PM-140): until then, sessions run as the service, which holds the
  login. Nothing in this profile hands the login out, and a copy would break the subscription
  rule (decisions 1 and 15).

## Sizing: measured, not decided

The owner's Mac has 16 GB RAM and about 11 GB of free disk. No limit is set here; these are
**estimates for the first trial**, to be replaced by `measure.sh` readings.

- **Disk.** Ubuntu Server 24.04 image ≈ 3.5 GB used; the app's `node_modules` is ≈ 240 MB (measured
  on the Mac; the Linux build is similar plus native modules); toolchain, pinned CLIs and caches ≈ 1.5–2 GB.
  Expect ≈ 5.5–6 GB used after the build, before any project repository, worktree or transcript.
  Multipass disks are sparse files, so a **10 GB** virtual disk takes only what is used, and 10 GB is
  the largest size that still fits the Mac's free space. Every cloned project repository and every
  worker's dependencies add to it: measure with real repositories before depending on it.
- **Memory.** [DEPLOY.md](DEPLOY.md) estimates 2 GB base plus 1–1.5 GB per concurrent AI developer.
  The first trial: **4 GB**, which holds the base and about one or two sessions; the production build
  needs about 2 GB. Raise it only from measured peaks, leaving the Mac enough for itself.
- **CPU.** 2 cores for the trial. Parallelism is measured, not capped: run `measure.sh` with 1, 2 and
  3 sessions and read the peaks.

## Build it on a Mac with Multipass

From a clean, committed checkout of this repository on the Mac (the script refuses a dirty tree,
because the VM must run a recorded commit). `~/.ssh/<name>.pub` is a public key you choose; the
private key never leaves the Mac.

```sh
bash deploy/vm/mac-multipass.sh create --ssh-key ~/.ssh/<name>.pub     # default: projectman-vm, 2 CPUs, 4G, 10G
bash deploy/vm/mac-multipass.sh deploy --workers "dev codex qa"        # bootstrap.sh + install-app.sh --smoke
```

`deploy` copies the commit with `multipass transfer` (nothing is mounted), runs `bootstrap.sh` and
`install-app.sh --smoke` (the production build and `npm run smoke:prod` with fake CLIs) inside the
guest, and starts the service. The worker handles are the members' handles; add a worker later with
`bootstrap.sh --workers "..."` again (idempotent).

On a rented Ubuntu 24.04 server the same machine comes from the same files: copy the checkout's
`git archive` output there, then

```sh
sudo bash deploy/vm/bootstrap.sh --workers "dev codex qa" --admin-user <your login>
sudo bash deploy/vm/install-app.sh --archive projectman.tar.gz --commit <40-hex sha> --smoke
```

### Human steps (not scripted, on purpose)

1. **Subscription logins**, in the VM, as the service account: `multipass shell projectman-vm`, then
   `sudo -iu projectman` and `claude auth login` (choose the Claude subscription, not Console/API),
   `codex login` (ChatGPT account, not an API key). `gh auth login` is never run for the VM; its
   one GitHub identity is the separate publishing identity of PM-142, installed by a person as a token
   file the service alone reads ([GITHUB.md](GITHUB.md#one-time-setup-by-the-owner)). Then
   `sudo systemctl restart projectman`.
2. **First owner**: forward the port and open the app locally, as in [DEPLOY.md](DEPLOY.md):
   `bash deploy/vm/mac-multipass.sh forward --ssh-key ~/.ssh/<name>` (agent forwarding is off), then
   `http://127.0.0.1:4700`. On a **throwaway** VM, a new account or token is created by a person here,
   never copied from the live instance. On the VM that takes over the owner's installation the accounts
   come with the moved data ([MIGRATION.md](MIGRATION.md): the database, with its password hashes and the
   cookie secret), and the provider logins and the publishing identity are still new.
3. **Phone**: install Tailscale in the VM with the vendor's instructions, `sudo tailscale up`, then
   `sudo tailscale serve --bg 4700` (never Funnel) and run the HTTPS checks of
   [DEPLOY.md](DEPLOY.md). The server stays on loopback; login, Origin, hook and MCP protections are
   the app's own and unchanged. Only HTTPS from `tailscale0` is let in by the guest's rules.
   Two things differ from a plain install, both set by `bootstrap.sh`: tailscaled's runtime
   directory is root-only (mode 0700), so its LocalAPI socket, which is world-writable by default
   and shows the tailnet's peers and addresses to whoever uses it, is closed to the service and the
   workers; every `tailscale` command therefore needs `sudo`. And tailscaled's own listener on the
   guest's tailnet address (its peer API) is expected: nothing reaches it, because the ingress rules
   drop everything from `tailscale0` but HTTPS, and `verify.sh` accepts it only from `tailscaled`.

## The readiness report

```sh
sudo bash /srv/projectman/deploy/vm/verify.sh --out /var/lib/projectman-boundary/readiness.json
cd /srv/projectman && npx tsx scripts/vm-readiness.ts /var/lib/projectman-boundary/readiness.json 60
```

`verify.sh` measures; it decides nothing. Each check has a status (`pass`, `fail`, `unverified`) and
a line of evidence (a path, a mode, a count, a version, an error name; never file content). The
verdict is `evaluateVmReadiness()` in `packages/shared/src/deploy/vm-readiness.ts`: **ready only if
the report is for this profile version, is not older than the limit given, and every required check
passed**. A missing check is a failure, the report schema is strict, and a flag such as `VM=true` is
neither read nor accepted. Every probe that expects a denial also runs a positive control (the
service reads its own data, root reaches a listener a worker is refused), so a typo cannot pass.
PM-140 and PM-143 consume the same report. The checks:

| Group           | Required checks                                                                                                                                 | Reported only                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| versions        | `os`, `node`, `claude-cli`, `codex-cli`, `app-build`                                                                                            |                                          |
| accounts        | `service-account`, `workers-present`, `workers-unprivileged`                                                                                    |                                          |
| protected-paths | `paths-owner-mode`, `worker-denied-read`, `worker-denied-write`, `worker-isolation`, `no-credential-copies`, `proc-hidden`, `service-hardening` |                                          |
| host-isolation  | `no-host-mounts`, `no-agent-forwarding`, `worker-sockets`, `listeners`                                                                          |                                          |
| network-gate    | `gate-loaded`, `gate-control`, `gate-blocks-host`                                                                                               | `egress-open`, `domain-gate`, `launcher` |
| service         | `service-active`                                                                                                                                | `tailscale`                              |

`domain-gate` and `launcher` are always `unverified` here: they are PM-140's. `egress-open` is
`unverified` when the network has no internet or the gate is too tight; `tailscale` when it is not
set up yet. Abstract unix sockets cannot be permission-checked.

IPv6: the egress rules close **all** non-loopback IPv6 for the service and the workers (the Mac and
the LAN machines have global IPv6 addresses at home, a rented server has an IPv6 route); the
internet stays reachable over IPv4 and clients fall back at once. `verify.sh` probes it when it can:
the control listener also runs on the guest's global IPv6 address if it has one, the IPv6 gateway is
tried, and if root itself reaches a public IPv6 address the confined accounts must not. A guest
without IPv6 connectivity cannot be probed that way: the evidence then says so, and the rule is
checked as loaded (`gate-loaded`).

## Manual trial protocol (the real VM)

A throwaway VM, run by a person; the results go on the card. Replace `<gw>` with the guest's
default gateway (`ip route show default`; on Multipass/macOS the Mac itself) and `pmw-dev` with a
worker.

1. **Build**: `create`, `deploy` as above. Expected: both end without error, `install-app.sh`'s
   smoke passes, `systemctl is-active projectman projectman-gate` prints `active` twice.
   Risk to watch: `bootstrap.sh` mounts the main `/proc` with `hidepid=2` and gives systemd-logind
   the group that may still see everything. On systemd 255 (Ubuntu 24.04) this is not an officially
   supported setup (logind, polkit, `user@` may be affected). Check right after the bootstrap and again
   after step 6: a **new** `ssh`/`multipass shell` login works, `loginctl list-sessions` and
   `systemctl status` answer, `systemctl is-system-running` is `running`. If not, report the
   symptom; the fallback is to drop `hidepid` and keep the sessions' processes private through the
   launcher's own unit (`ProtectProc=invisible`, PM-140), which makes `proc-hidden` fail until then.
2. **Readiness**: run the two commands above. Expected: `READY: every required check passed.`,
   `domain-gate` and `launcher` listed as not passed.
3. **Browser**: forward the port, open `http://127.0.0.1:4700`, create the first owner, log in,
   open the board, change something in a second browser tab and see it appear without a reload
   (websocket). Or with curl over the forward, the `/ws` handshake of DEPLOY.md: expect `101`.
4. **Phone**: set up Tailscale Serve, run DEPLOY.md's HTTPS checks from a tailnet client (login 200
   with `Secure`, websocket 101, foreign Origin 403), then log in from the phone and watch a live
   update. `sudo tailscale serve status` shows no Funnel. Then run step 2 again: the report is
   still `READY`, now with `tailscale` passed. And the LocalAPI is closed: `sudo runuser -u pmw-dev --
tailscale status` and `... -- ls /run/tailscale` are denied, as for `projectman`.
5. **Stop and restart**: `multipass restart projectman-vm`. Expected: both units `active`, the
   readiness report is again ready (the gate rules came back from the unit, not from memory), the
   browser login still works, a stored conversation is resumable.
6. **Mac files and shares**: in the VM, `ls /Users` fails; `cut -d' ' -f3 /proc/mounts | sort -u`
   lists no `9p`, `virtiofs` or `fuse.sshfs`; on the Mac `multipass info projectman-vm` shows no
   mounts.
7. **Host and LAN** (positive control first). On the Mac, in an empty temporary directory, start
   `python3 -m http.server 8099 --bind 0.0.0.0`. In the VM: the admin reaches it,
   `bash -c 'exec 3<>/dev/tcp/<gw>/8099' && echo reached` prints `reached`; then
   `sudo runuser -u pmw-dev -- timeout 3 bash -c 'exec 3<>/dev/tcp/<gw>/8099'` and
   `sudo runuser -u projectman -- timeout 3 bash -c 'exec 3<>/dev/tcp/<gw>/8099'` must both fail
   (non-zero status). Repeat for the Mac's LAN address and another LAN machine, and for
   `169.254.169.254`. Stop the Mac's server afterwards. IPv6: if the guest has an IPv6 default
   route (`ip -6 route show default`), start the same server on the Mac (`--bind ::`), try the
   Mac's global IPv6 address from the admin (reaches it) and from `pmw-dev` and `projectman`
   (`/dev/tcp/<address>/8099`, both fail), and the same for a public one such as
   `2001:4860:4860::8888` on port 443.
8. **Agent socket**: with an ssh agent running on the Mac, connect with `ssh -A` once: in that shell
   `env | grep SSH_AUTH_SOCK` prints nothing and `sudo sshd -T | grep -i agentforwarding` says `no`.
9. **Control data**: as a worker, `sudo runuser -u pmw-dev -- ls /var/lib/projectman/data` and
   `... -- test -r /var/lib/projectman/data/secret` are denied (do not print the file);
   `... -- sh -c 'echo x >> /etc/projectman/gate.nft'` and `... -- nft list ruleset` are denied;
   `sudo runuser -u pmw-dev -- ps -eo user=` lists only `pmw-dev`; `sudo -l -U pmw-dev` shows
   no rights. The same writes are denied to `projectman`.
10. **Measure**: `sudo bash deploy/vm/measure.sh 10 60 > measure.csv` while 1, 2, 3 AI sessions
    work; report the peaks of memory, load and disk.
11. **Backup and restore**: see below; then readiness and the browser check again.
12. **The scripted rehearsal**: `sudo bash deploy/vm/rehearse.sh all` (readiness, the whole test suite with the
    pseudo-terminal files, a restart, a backup that passes `check-backup.sh`) writes a log with one PASS or
    FAIL line per step: put it on the card. The steps that need a person are in
    [MIGRATION.md](MIGRATION.md#acceptance-matrix-the-evidence).

## The question-free profile (PM-141)

In the VM the AI members' Claude Code and Codex run **without local approval questions**
(decision 26): the boundary above, not the CLIs' own prompts and sandboxes, holds the limits.
What each CLI is given, the checks before a start and what is not yet proven are in
[PROVIDERS.md](PROVIDERS.md#managed-vm-profile-pm-141); the rule in [ARCHITECTURE.md](ARCHITECTURE.md).

**Enabling it is the owner's step, and it needs a complete boundary.** Until PM-140 delivers the
launcher and the domain-level network gate, `verify.sh` reports `launcher` and `domain-gate` as
`unverified`, and the profile refuses to start any session: that is by design. Once they pass, the
owner sets, in a root-managed drop-in of the service unit (`systemctl edit projectman`; the CLIs
never see these variables):

```
Environment=PROJECTMAN_WORKSPACES=member
Environment=PROJECTMAN_EXECUTION_PROFILE=managed_vm
Environment=PROJECTMAN_VM_READINESS_REPORT=/var/lib/projectman-boundary/readiness.json
# optional, default 1440 (a day): refresh the report with verify.sh at least that often
Environment=PROJECTMAN_VM_REPORT_MAX_AGE_MINUTES=1440
```

An unknown profile name, a managed VM without member workspaces or a report path, or a report path on
an installation that is not `managed_vm`, stops the server at start. The report is read at every
session start, so a machine that stops being ready (an old report, a failed check) stops starting
sessions at once; running sessions keep running. The VM must carry no administrator policy for the
CLIs (`/etc/claude-code/managed-settings*`, `/etc/codex/*.toml`) and no hooks, MCP servers, approval
or sandbox settings in the CLIs' user configuration: such a file refuses the start, naming the file
and the setting (not its value).

**Human trial in a throwaway VM** (interactive, on the subscription logins, never in automated
tests). Build and verify as above, with `launcher` and `domain-gate` passing (or the report written by
hand for the throwaway only, on a copy that is deleted afterwards), enable the profile, then for both
a Claude and a Codex member (a developer, QA, a reviewer and a general chat each):

1. **First start.** The session reaches its prompt with no dialog waiting in the terminal (no trust
   screen, no bypass confirmation, no hook review) and the inbox shows nothing. If a dialog appears,
   note its text: the adapter, not the contract, needs the change (PROVIDERS.md lists the settings
   that are guesses until now).
2. **Routine work without a question.** Ask the member to run, in its workspace: a command with
   shell substitution (`echo "$(date)"`), a redirection into a file (`ls > out.txt`), `npm install`
   (registry reachable), every test the project has including the ones that open a pseudo-terminal
   (`npm test`), `git add` and `git commit -m "…"`. None may ask: no inbox item, no question in the
   terminal. Writes to `.git` and to `.claude` of the workspace are the ones most likely to still
   prompt in `bypassPermissions`: note it if they do.
3. **Resume.** Stop the session, send a message, and see the same conversation resume, still without a
   question. Change the member's `permissionMode` in the configuration and restart: the profile does
   not change (and the configuration is not rewritten); `plan` stays research-only.
4. **The boundary still stops what must stop.** From the session: reach the host and the LAN
   (`/dev/tcp/<gw>/8099`, as in the manual trial), a private address, the metadata address, another
   worker's home, `/var/lib/projectman/data`; try `git push` to a GitHub remote and an unlisted
   domain. Each must fail at the gate or the file permissions, not at a prompt. A refused step is
   reported by the member and shows no inbox item.
5. **A request that arrives anyway.** Not reproducible on purpose; the fake CLIs cover it.
6. **No local override.** Put a `.claude/settings.json` with a `hooks` entry and a `.mcp.json` in a
   test repository and a `hooks` table in `~/.codex/config.toml` of a worker: Claude ignores the
   repository files (the team server is the only MCP server), and the Codex start is refused with the
   file and key named.
7. **The Mac stays as it was.** On the Mac installation, set the same variables with a copy of the
   readiness report (with `PROJECTMAN_WORKSPACES=member`): the server starts, and every session is
   refused (`managed_vm_unavailable`, reason `platform`); with the variables removed, every member
   runs exactly as before.

Record the CLI versions, the settings that needed a change and every prompt that appeared on the
card. The same facts decide whether `MANAGED_VM_PROVIDER_VERSIONS` may name a newer release.

## Backup and restore

```sh
sudo bash /srv/projectman/deploy/vm/backup.sh /root/projectman-backup.tar.gz   # stops the service, archives, restarts
sudo bash /srv/projectman/deploy/vm/restore.sh /root/projectman-backup.tar.gz  # on a machine built by bootstrap.sh + install-app.sh
```

The archive holds the service home (SQLite and its WAL, the cookie secret, `customization/` with
`.git`, attachments, worktrees, memory, the CLI login state and transcripts) and the worker homes.
It is a secret: it is created mode 0600, must be encrypted before it leaves the machine and never
goes into the repository, a task or a message. Restore needs the same worker handles to exist; it
sets ownership by name, so other uids are fine, and it keeps what was there as
`*.before-restore-<time>`. The cookie secret comes back, so browser logins stay valid. The app, the
CLIs, `/etc/projectman` and the Tailscale identity are rebuilt, not restored. To test it: back up,
`mac-multipass.sh destroy --yes`, create and deploy again, restore, run verify and log in.

`restore.sh` first runs `check-backup.sh` on the archive (the data is extracted to a private scratch directory
and checked by the move tool's `verify`: integrity, the schema against this build, the secret, attachments
against their rows, the customization repository) and restores nothing when it does not pass: a database a
newer build migrated is never put under an older one. `sudo bash deploy/vm/check-backup.sh ARCHIVE` alone
proves an archive restorable without touching the running installation. A restored home must not run beside
the original: only one copy is the active instance (`instance.json`, [MIGRATION.md](MIGRATION.md)).

## Updating

Back up, then `mac-multipass.sh deploy` again (or `install-app.sh` with a new archive and commit): it
builds in a staging directory, hands the tree to root, swaps it in, keeps the previous tree as
`/srv/projectman.prev` for a rollback, and never touches the data. Changing a CLI version means
changing `profile.env`, the shared `VM_PROFILE_VERSION` if a check changed, and running `bootstrap.sh`.

## Known limits

- The baseline gate stops the service and workers reaching private IPv4 addresses and all
  non-loopback IPv6 addresses; it does not limit
  _which internet destinations_ they reach (PM-140's domain gate), and it does not stop root or the
  admin. A worker may still use loopback, including the app's own port (its hook and MCP endpoints
  keep their token checks; the login protects the rest).
- A worker's own listener on `0.0.0.0` is not reachable from outside (inbound is closed except SSH and
  HTTPS from `tailscale0`), but it is reachable from loopback by every account of the machine.
- The profile does not defend against a malicious admin, the hypervisor or a kernel flaw.
- The question-free profile (PM-141) reads a task's attachment directory only as a read-only
  _intent_ (`filesystem.readOnlyPaths`): the attachments live under `PROJECTMAN_HOME`, which a
  worker cannot read, so how a worker session receives an attachment file is the launcher's design
  (PM-140), not solved by the CLI settings.
- An IPv6-only network is not supported: the confined accounts have no IPv6. Until PM-140 names the
  allowed destinations, a server needs IPv4 (NAT is enough).
- `hidepid=2` on the main `/proc` is a known risk (step 1 of the trial). `hidepid` and the nftables
  rules were written against Ubuntu 24.04; the pinned CLI versions are the
  ones the team has used, not strict-sandbox certifications (see [PROVIDERS.md](PROVIDERS.md)).
