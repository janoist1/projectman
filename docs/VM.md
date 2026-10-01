# The managed VM profile

A reproducible Ubuntu guest that runs projectman apart from the owner's own machine (PM-137,
the first part of PM-135). It is built from files in `deploy/vm/` and measured by a readiness
report. The same files build a rented Ubuntu server later (PM-45): a Mac with Multipass is only
the first place to run them. This is **not** a live migration: it starts from an empty machine,
and the owner's running instance is not touched.

What this part delivers, and what it does not:

| Delivered (PM-137, PM-140, PM-141, PM-143)                                                         | Still a person's step                                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Pinned Node and CLI versions, a root-owned app, a separate service account                         | The real VM trial and the real move, after the owner's concrete approval ([MIGRATION.md](MIGRATION.md)) |
| One unprivileged account per member, no sudo, no shared home                                       |                                                                                                         |
| The protected launcher: every session and workspace command runs as its worker                     |                                                                                                         |
| The egress gate: workers reach the internet only through a checking proxy                          |                                                                                                         |
| Member workspaces in worker homes, commits handed over as bundles (PM-138, PM-140)                 |                                                                                                         |
| A readiness report with a strict verdict rule, which the server enforces                           |                                                                                                         |
| The question-free profile behind the boundary (PM-141, [below](#the-question-free-profile-pm-141)) |                                                                                                         |
| Backup and restore, a measurement helper, the manual trial steps (below)                           |                                                                                                         |
| The move tool, `check-backup.sh`, `rehearse.sh`, the cutover and rollback procedure (PM-143)       |                                                                                                         |

The server runs behind the boundary when its unit names the boundary configuration
(`PROJECTMAN_BOUNDARY_CONFIG=/etc/projectman/boundary.json`, set by bootstrap.sh in a drop-in).
Then it starts nothing itself: every session goes through the launcher, and no session starts
while the newest readiness report is missing, not ready or older than two hours, or while the
launcher or the egress proxy does not answer (`runtime_boundary_not_ready`). Read
[SECURITY.md](SECURITY.md) for what this does and does not protect.

## Why Multipass on the Mac

Multipass is already on the owner's Mac, runs the same Ubuntu Server image a rented server uses,
takes a cloud-init file, shares no folder with the Mac unless someone runs `multipass mount`
(never run here), and a throwaway instance is one command to delete. Lima would need installing;
UTM and Parallels are manual GUI work that cannot be reproduced from a file. Docker Desktop is a
container, not the machine the profile describes. The existing `debian-vm` instance and the
`primary` instance (Multipass mounts the home directory into it) are never used.

## Layout: who may do what

| Path                                                  | Owner / mode                 | Service | Worker | Notes                                                      |
| ----------------------------------------------------- | ---------------------------- | ------- | ------ | ---------------------------------------------------------- |
| `/srv/projectman` (app, `DEPLOYED_COMMIT`)            | root:root 0755               | read    | read   | Built as the service in a staging dir, then handed to root |
| `/opt/projectman/cli` (pinned `claude`, `codex`)      | root:root 0755               | read    | read   | Auto-update off; changes only when the profile changes     |
| `/etc/projectman` (`profile.env`, `gate.nft`)         | root:root 0755 / files 0644  | read    | read   | The boundary settings; no secret in them                   |
| `/etc/systemd/system/projectman*.service`             | root:root 0644               | read    | read   |                                                            |
| `/var/lib/projectman-boundary` (readiness report)     | root:root 0755               | read    | read   | Statuses and evidence only                                 |
| `/var/lib/projectman` (service home, CLI login state) | projectman 0700              | own     | none   | Provider logins, transcripts of service-run sessions       |
| `/var/lib/projectman/data` (`PROJECTMAN_HOME`)        | projectman 0700              | own     | none   | SQLite, cookie secret, attachments, memory, worktrees      |
| `/var/lib/projectman-work/pmw-<handle>` (worker home) | pmw-<handle> 0750            | read    | own    | Group `pmw-<handle>` has the service as its only member    |
| `/var/lib/projectman-spool/<handle>/in`               | projectman:pmw-<handle> 2750 | write   | read   | Bundles the service hands to the worker (PM-140)           |
| `/var/lib/projectman-spool/<handle>/out`              | pmw-<handle> 0750            | read    | own    | Bundles the worker hands to the service                    |
| `/etc/projectman/boundary.json`                       | root:root 0644               | read    | read   | The boundary configuration (paths, uids, ports, base list) |
| `/run/projectman-launcher.sock`                       | root:projectman 0660         | use     | none   | Created by `projectman-launcher.socket`                    |

- **Accounts.** The service is `projectman` (uid 19000). Each member's worker is `pmw-<handle>`
  (uid from 20000 up, own group, `nologin` shell, locked password, in no other group, not in sshd's
  `AllowUsers`). Nobody but the admin (the human who administers the machine) has sudo; the service
  and the workers have none, and `NoNewPrivileges` holds for the service.
- **A worker cannot change** the app, the CLIs, the service unit, the egress rules, the profile,
  the cookie secret, the SQLite database or any other account's token or home. The service is held
  to the same limit for everything that is root's: it cannot rewrite its own app or the boundary.
- **Launcher (PM-140).** `projectman-launcher.service` runs `dist/launcher.js` as root, without
  any capability, network or writable path of its own; its socket (`projectman-launcher.socket`)
  is root's with the service's group, mode 0660. It does two things for the service: start an
  agent session as `pmw-<handle>` and relay its terminal, and run one pinned program (`git`,
  `mkdir`, `rm`, `mv`, `claude`, `codex`, and the app's `claude-trust` and `boundary-probe`
  helpers) as a worker and return its output. The request names a registered member, a provider or
  program and a directory inside that worker's home; the launcher picks the account, the program
  path, the environment (built from nothing: home, PATH, the proxy settings with the session's
  egress token, no key, agent or host variable) and the sandbox. A command line that would set a
  billing variable (Claude Code's inline settings `env` or `apiKeyHelper`, a Codex provider or
  environment override) is refused; a prompt or brief that merely names one is not. Each runs as a
  transient unit (`systemd-run --pty` or `--pipe`, `--expand-environment=no`) with
  `User=pmw-<handle>`, no capability, `NoNewPrivileges`, private `/tmp` and devices,
  `ProtectSystem=strict` with only the worker home and its `out` spool writable,
  `ProtectProc=invisible`, no further namespaces, **its own network namespace**
  (`PrivateNetwork=yes`: only its own loopback) with `IPAddressDeny=any`/`IPAddressAllow=localhost`
  on top, and `InaccessiblePaths` over the system bus, systemd's private and transient unit files
  (they hold other sessions' command lines), the resolver's sockets, container and Tailscale
  sockets and the service's home. Closing the service's connection stops the session's unit; a
  launcher that starts stops every leftover unit.
- **Worker bridge (PM-140).** Every program in a unit runs behind `dist/worker-bridge.js`, which
  listens inside the unit's namespace on `127.0.0.1:4700` (the app's hooks and MCP) and
  `127.0.0.1:4780` (the egress proxy) and carries each connection to the member's own sockets of
  the service, `/run/projectman-bridge/<handle>/{app,egress}.sock` (directory 2750 with the
  member's group, sockets 0660: no other member can open them). The service opens them for every
  worker account when it starts (PM-175), so verify.sh's probe finds them before any session; a
  worker added later gets its sockets with the service restart its group membership needs anyway,
  or before its first unit. So a member's test and dev servers
  are its own, no member reaches another's, and none can take over a port of the service, even
  while the service is down.
- **Egress gate (PM-140).** The units have no network but their own loopback. In the host
  namespace (a worker process a person starts, such as the subscription login) the nft rules let a
  worker reach the egress proxy's port and nothing else. The way out is the egress proxy in the
  service: HTTP CONNECT to a TLS destination, nothing else. It knows the member from the bridge
  socket the connection came through (or, on its loopback port, from the kernel's socket table)
  and the session from its proxy credentials, resolves the
  name itself (IPv4 only, refusing a name with any private, loopback, link-local, CGNAT or reserved
  address in its answer), connects to the address it checked, and closes a tunnel whose TLS server
  name is not the allowed host. It allows the fixed base list (`EGRESS_BASE`) to every worker, and
  an exact destination (host and port) to a member in a project once a lead or the owner allowed
  it (below). A refused destination answers 403 with an operation id; the session lists its
  refusals with the team tool `list_network_denials` and asks with `submit_boundary_request`.
- **Workspaces (PM-138, PM-140).** A member's workspaces live in its home
  (`~/workspaces/<PROJECT>/<handle>/<repo>`); every git command in them runs as the worker through
  the launcher, so hooks, filters and configuration the member controls never run as the service.
  Commits cross accounts as bundles in the spool: the service bundles the project repository into
  the member's `in`; a teammate's worker bundles its branch into its own `out`, which the service
  copies into the receiving member's `in`. Sessions without a workspace run in
  `~/sessions/<PROJECT>`.
- **Transcripts.** A CLI writes its transcript in the home of the account that runs it (see
  [PROVIDERS.md](PROVIDERS.md)). Worker homes are group-readable by the service only, and the
  launcher's units use `UMask=0027`, so the server can read the transcripts of worker-run sessions
  and a worker cannot read another's. The server follows a transcript only when its real directory
  lies in that worker's home, and opens it without following a symlink. Transcripts may hold
  anything the member typed or a tool printed: they are not secret-free, so they live only inside
  the backed-up trees below and are never copied into readiness evidence.
- **CLI login (the owner's choice on PM-140).** Each worker has its own subscription login,
  made once by a person per worker and provider (human steps below); the runner checks that login
  (`claude auth status`, `codex login status`) as the worker before a session starts. The login is
  never typed on the Mac and never copied: verify.sh fails a login file in a worker home that is not
  the worker's own (owner, mode 600) or that has the same bytes as the service's. The service keeps
  its own login for the plan-usage probe. No API key is used anywhere (decisions 1 and 15).

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

1. **Subscription logins**, in the VM (`multipass shell projectman-vm`). The service's own, for the
   plan-usage probe: `sudo -iu projectman`, then `claude auth login` (the Claude subscription, not
   Console/API) and `codex login` (ChatGPT account, not an API key). Then each worker's, through the
   egress proxy (a worker has no other way out), for example for `dev`:

   ```sh
   sudo -u pmw-dev -H env HTTPS_PROXY=http://127.0.0.1:4780 /opt/projectman/cli/bin/claude auth login
   sudo -u pmw-dev -H env HTTPS_PROXY=http://127.0.0.1:4780 /opt/projectman/cli/bin/codex login
   ```

   The service must be running (it holds the proxy). Codex's browser login answers on a local
   port of the VM: use the same login flow you used for the service account (and record which one
   the pinned version needs in the trial notes). `gh auth login` is never run for the VM; its one
   GitHub identity is the separate publishing identity of PM-142, installed by a person as a token
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
The server (PM-140) and PM-143 consume the same report. The checks:

| Group           | Required checks                                                                                                                                 | Reported only |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| versions        | `os`, `node`, `claude-cli`, `codex-cli`, `app-build`                                                                                            |               |
| accounts        | `service-account`, `workers-present`, `workers-unprivileged`                                                                                    |               |
| protected-paths | `paths-owner-mode`, `worker-denied-read`, `worker-denied-write`, `worker-isolation`, `no-credential-copies`, `proc-hidden`, `service-hardening` |               |
| host-isolation  | `no-host-mounts`, `no-agent-forwarding`, `worker-sockets`, `listeners`                                                                          |               |
| network-gate    | `gate-loaded`, `gate-control`, `gate-blocks-host`, `domain-gate`, `launcher`                                                                    | `egress-open` |
| service         | `service-active`                                                                                                                                | `tailscale`   |

`launcher` and `domain-gate` (profile version 2, PM-140) come from the **boundary probe**:
verify.sh runs `dist/boundary-probe.js` as root, which first takes root's positive controls (a
public name resolves, a public address answers on 443, a public DNS server answers, IPv6 when the
guest has it), then asks the real launcher to run the fixed probe program as the first worker in
its real sandboxed unit. From there the probe tries what a session must not manage: see any
network interface but its own loopback, reach a listener root started on the host's loopback (as
another member's server would be), resolve a name, connect directly over TCP, UDP and IPv6, reach
sshd or the resolver on loopback, use the system
bus, the resolver's or the launcher's socket, read systemd's transient units, the service's home or
another worker's home, see other processes, write the app or the configuration; and through the
proxy it checks that a base destination answers while `PROBE_DENIED_DESTINATION` and the metadata
address are refused, and that the app answers 401 without a login. A refusal counts only where
root's control reached the same thing; without one the check is `unverified` (so a guest without
internet is not ready). `launcher` also checks the socket's owner and mode and that no worker can
use it. `domain-gate` also tries, as each worker in the host namespace, a root listener on loopback
and the app's port (both refused; only the proxy's port is open there). `egress-open` is a worker
reaching a base destination through the proxy; `tailscale` is
`unverified` until it is set up. Abstract unix sockets cannot be permission-checked.

The server reads the report itself (`/var/lib/projectman-boundary/readiness.json`): the
`projectman-verify.timer` writes a new one two minutes after boot and every 30 minutes, and a
report older than `READINESS_MAX_AGE_SECONDS` (two hours) stops new sessions, as does any required
check that did not pass.

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

### The VM boundary (PM-140)

Use throwaway fake secrets only (for example a file `/var/lib/projectman/data/fake-secret` with
the text `FAKE-SECRET-1`, mode 0600, owner `projectman`); never a real token. Run the steps after
the human steps above, with two workers logged in. Record each result on the card.

12. **Readiness**: run the readiness commands. Expected `READY`, with `launcher` and `domain-gate`
    passed. `systemctl is-active projectman-launcher.socket projectman-verify.timer` prints `active`
    twice; `stat -c '%U:%G %a' /run/projectman-launcher.sock` prints `root:projectman 660`.
13. **Sessions run as workers**: start a task for an AI developer in the browser. Then
    `systemctl list-units 'projectman-session-*'` shows its unit,
    `ps -o user= -p "$(systemctl show -p MainPID --value projectman-session-<id>.service)"` shows
    `pmw-<handle>`, and the task's workspace is under `/var/lib/projectman-work/pmw-<handle>/workspaces`
    with files owned by the worker. The session's chat shows the transcript; hooks change its
    state; a team tool call (send_message) arrives. Do the same with a Codex member.
14. **Attack probes from a session** (in the session's terminal, Claude Code runs a shell command
    typed after `!`; for Codex ask it to run the command). Each must fail, each with the session
    still working afterwards:
    `cat /var/lib/projectman/data/fake-secret`; `ls /var/lib/projectman-work/pmw-<other>`;
    `ls /run/systemd/transient`; `ps -eo user=` (only the worker);
    `curl --noproxy '*' -m 5 https://github.com` and `curl --noproxy '*' -m 5 https://1.1.1.1`
    (direct: refused); `getent hosts github.com` (no resolver); `nc -u -w2 1.1.1.1 53 < /dev/null`
    or `dig @1.1.1.1 github.com` where installed; `curl -6 -m 5 https://[2001:4860:4860::8888]`;
    `ssh -p 22 127.0.0.1` (refused); `curl -m 5 https://example.com` (through the proxy: 403 with an
    operation id); `curl -m 5 -x http://127.0.0.1:4780 http://169.254.169.254/` (refused);
    `curl -m 5 http://127.0.0.1:4700/api/me` (401); `echo x > /etc/projectman/x`,
    `systemctl stop projectman` and `nft list ruleset` (denied); `docker ps` (no socket);
    `ip addr` (only `lo`). And across members: in one member's session start
    `python3 -m http.server 8123 --bind 127.0.0.1`; from another member's session
    `curl -m 5 http://127.0.0.1:8123/` is refused (and so from the admin's shell as that worker,
    `sudo -u pmw-<other> curl -m 5 http://127.0.0.1:8123/`), while the first session itself reaches
    it. Stop the service and, from a session, try to listen on `127.0.0.1:4700` and `:4780`: it only
    takes its own namespace's port, the service starts again on its own.
    And allowed, through the proxy: `npm view left-pad version` and `git ls-remote https://github.com/git/git HEAD`.
15. **A grant opens exactly one destination**: in a session, `curl -m 5 https://example.com`
    fails with 403; the agent calls `list_network_denials`, then `submit_boundary_request` with that
    operation id. A lead (or the owner in the inbox) allows it. Then the same `curl` works, but
    `curl -m 5 https://example.com:8443` and `curl -m 5 https://www.example.com` are refused, and
    another member's session is refused too. `GET /api/projects/<key>/egress` lists the allowance;
    `POST /api/projects/<key>/egress/<id>/revoke` closes it: a download still running through it
    stops, and the next `curl` is refused. Restart the service: an unrevoked allowance still
    works. With `EGRESS_GRANT_HOURS=1` (bootstrap again), it is refused after an hour.
16. **Fail closed**: `sudo systemctl stop projectman-launcher.socket projectman-launcher.service`;
    a new session start in the browser is refused (`runtime_boundary_not_ready`); start the socket
    again and it works. Move the report away
    (`sudo mv /var/lib/projectman-boundary/readiness.json /root/`): refused within a few seconds;
    move it back. `sudo systemctl stop projectman`: a worker's
    `sudo -u pmw-dev curl -m 5 -x http://127.0.0.1:4780 https://registry.npmjs.org` fails (no
    proxy, no other way out). `sudo systemctl restart projectman-launcher.service` while a session
    runs: the session ends and can be resumed.
17. **Measuring the destinations**: while each provider logs in, starts, works on a task and is
    updated by nothing (auto-update is off), watch
    `journalctl -u projectman -f | grep 'egress destination refused'`. A destination the pinned
    CLIs need belongs in `EGRESS_BASE` (profile.env, then bootstrap.sh); anything else is asked for
    per task. Record the list on the card.

## The question-free profile (PM-141)

In the VM the AI members' Claude Code and Codex run **without local approval questions**
(decision 26): the boundary above, not the CLIs' own prompts and sandboxes, holds the limits.
What each CLI is given, the checks before a start and what is not yet proven are in
[PROVIDERS.md](PROVIDERS.md#managed-vm-profile-pm-141); the rule in [ARCHITECTURE.md](ARCHITECTURE.md).

**Enabling it is the owner's step, and it needs a complete boundary.** The profile runs only behind
the VM boundary above: the service must name the boundary configuration
(`PROJECTMAN_BOUNDARY_CONFIG`, set by bootstrap.sh), and every start needs `launcher` and
`domain-gate` passed in the report, the launcher answering and the egress proxy listening. Once the
VM boundary trial (steps 12–17) passed, the owner sets, in a root-managed drop-in of the service
unit (`systemctl edit projectman`; the CLIs never see these variables):

```
Environment=PROJECTMAN_WORKSPACES=member
Environment=PROJECTMAN_EXECUTION_PROFILE=managed_vm
# optional: the report and its age limit default to the boundary configuration's
# (/var/lib/projectman-boundary/readiness.json, refreshed by projectman-verify.timer)
# Environment=PROJECTMAN_VM_READINESS_REPORT=/var/lib/projectman-boundary/readiness.json
# Environment=PROJECTMAN_VM_REPORT_MAX_AGE_MINUTES=120
```

An unknown profile name, a managed VM without member workspaces or without the boundary
configuration, or a report path on an installation that is not `managed_vm`, stops the server at
start. The report and the boundary are checked at every session start, so a machine that stops being
ready (an old report, a failed check, a stopped launcher) stops starting sessions at once; running
sessions keep running. The VM must carry no administrator policy for the
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
7. **The Mac stays as it was.** On the Mac installation, set the profile variables without a
   boundary configuration: the server does not start. With copies of the boundary configuration and
   the readiness report (and `PROJECTMAN_WORKSPACES=member`) every session is refused (reason
   `platform`, or the boundary not ready); with the variables removed, every member runs exactly as
   before.

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

- The gate does not stop root or the admin. The service reaches any public IPv4 destination (it
  runs the proxy and the server's own requests); only the workers are held to the proxy.
- A session reaches the app's own port through its bridge: the hook and MCP endpoints keep their
  per-session token checks, and the login protects the rest of the app.
- Two sessions of the same member are in different network namespaces: one cannot reach a test
  server the other started (start it in the session that uses it).
- An allowed destination can carry anything the session sends it; a base destination such as
  GitHub can be read anonymously but takes nothing without a login, and no GitHub login is in a
  worker home. Expiry and revocation end the allowance's open tunnels too, not only new ones.
- A session reads its task's attachments through the team tools (`read_attachment`): the
  attachment directory is in the service's data, which no worker unit can see.
- Only TLS goes through the proxy (no plain HTTP, no SSH): a tool that needs another protocol is a
  case for the owner. Programs that ignore the proxy settings fail.
- Points to confirm on the real guest (the trial records them): the exit status `systemd-run --pty
--wait` reports, that a session's arguments reach the CLI verbatim (`%` and `${...}` included,
  `--expand-environment=no`), that `^]^]^]` typed into a terminal does not detach it, and that a
  capability-less root launcher may start units with another `User=`.
- The profile does not defend against a malicious admin, the hypervisor or a kernel flaw.
- An IPv6-only network is not supported: the workers have no IPv6 and the proxy connects over IPv4
  only, so a server needs IPv4 (NAT is enough).
- `hidepid=2` on the main `/proc` is a known risk (step 1 of the trial); the sessions' units hide
  other processes on their own (`ProtectProc=invisible`). `hidepid` and the nftables
  rules were written against Ubuntu 24.04; the pinned CLI versions are the
  ones the team has used, not strict-sandbox certifications (see [PROVIDERS.md](PROVIDERS.md)).
