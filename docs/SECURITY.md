# Security

Reviewed 2026-09-30. This is an application security review, not an independent
penetration test or a guarantee of isolation between agent processes.

## Threat model

Protect against unauthenticated local HTTP clients, hostile websites, and tailnet
users attempting actions outside their project membership and access level.
Tailscale connectivity is not authentication. First-run setup is a local operation:
complete it before granting other people access to the machine.

The host owner, project owners, executable paths, repositories and agent CLI
configuration are trusted. Developers can send terminal input and run code as the
server's Unix user. Processes already running as that user can inspect credentials,
PTY arguments and files; HTTP authentication cannot isolate them. Separate hostile
tenants into separate OS accounts or machines.

## Protection

- Signed, HttpOnly, SameSite=Lax cookies; Secure when HTTPS terminates at a loopback
  proxy supplying `X-Forwarded-Proto: https`. Login and invite acceptance replace
  the presented session. Tokens have 256 random bits, are stored as SHA-256 hashes,
  and expire after 30 days without sliding renewal. Logout revokes the session.
- Argon2id passwords: 19 MiB memory, two iterations, one lane. Unknown accounts also
  perform password verification. Login reserves one of ten attempts per peer per
  15 minutes before hashing and gives it back when the login succeeds, so only failures
  count; invitation inspection/acceptance is limited the same way.
- Mutating API requests compare Origin against the exact scheme, Host and port;
  cross-site Fetch Metadata is rejected. Missing Origin supports non-browser
  clients; opaque `null` origins are rejected. WebSockets use the same origin
  comparison, revalidate sessions and check current membership for deliveries and
  terminal operations. API responses are not cached; pages suppress referrers.
- REST and team tools check membership, access, project/resource ownership and
  current gate eligibility. Initial host owner alone creates projects. Account
  rebinding, filesystem locations, admin grants and release approvers are owner-only.
  Owners and admins may invite an existing human seat without an email; acceptance
  binds only that still-unclaimed seat to the invited account, preserving its identity
  and roles. Inviter privileges are checked again under the config lock. Task import
  mode (original dates and bypassed stage gates) is owner-only and starts no work.
- Hook/MCP capabilities have 192 random bits and map to live sessions. Lookup is by
  complete random token, with no prefix comparison; signed cookies use the cookie
  library's signature verification. Hook permissions bind to the token-selected
  session and a unique inbox waiter, never a caller-supplied session identifier.
  Exit revokes capabilities; MCP rechecks after body reception. Hooks reject
  non-loopback peers, nonlocal Host/Origin and proxy headers before body parsing.
  MCP applies equivalent restrictions. Limits: API 5 MiB (JSON), attachment upload 25 MB
  per file (streamed, on its routes only), hooks 32 MiB, MCP 1 MiB, WebSocket frames
  1 MiB. The executable refuses non-loopback listen addresses.
- Task attachments live only under `PROJECTMAN_HOME/attachments`, behind the same cookie,
  origin and no-store protection and the project, task and attachment id check on every
  list, content, download, HEAD and delete; there is no static route. The size is counted
  from the bytes received (the limit applies to chunked bodies too) and the access is
  checked before the upload and again before it is published. Storage names are generated
  (project key, task key, id), the uploaded name is sanitised metadata only; directories
  are checked not to be symlinks, files are created exclusively and read without following
  links, and only regular files of the recorded size are served. Only a PNG, JPEG, GIF,
  WebP or PDF proven by its content is shown inline; everything else (HTML, SVG, renamed or
  unknown files) is an `application/octet-stream` download. All responses carry
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`,
  `Cross-Origin-Resource-Policy: same-origin` and an encoded `Content-Disposition`.
  Checked in Chrome against a local development server (2026-10-01): the PDF viewer opens a
  PDF served with that sandbox CSP, both as a page of its own and inside an iframe, a PNG
  loads in an `<img>`, HTML and SVG uploads are not rendered (they are downloads), and
  every content and download response carried exactly the headers listed here. Repeat the
  check after a Chrome major update or a change of these headers: the sandbox directive
  is what a browser may one day refuse to show a PDF under.
- AI members reach attachments through the team tools (PM-113), in their own name and under the
  same rules. `attach_file` never takes a directory from the caller: the server uses the working
  directory it recorded for the session the MCP token names. It opens only a regular file inside
  it (by whole path components, so a sibling with the same prefix is outside), refuses symbolic
  links anywhere on the way, files with several hard links, directories, FIFOs (opened without
  blocking), sockets and devices, and checks the opened handle afterwards: its real location
  must still be inside and be the very file opened, so a path swapped between the checks and the
  open is refused. The content is streamed from that handle and refused when its size or time
  changes meanwhile. A task session may read (never edit) only its own task's attachment
  directory without asking: Claude Code gets `Read(//…/**)` allowed and `Edit(//…/**)` denied for
  it, not an extra working directory, and nothing of the rest of `PROJECTMAN_HOME`; Codex gets
  no writable root there. `read_attachment` gives a path (images and PDFs through a hard link
  `<id>.<ext>` next to the file, removed with it), never the content.
- Git/gh and agents receive argument arrays. Task branches are sanitized; default
  branches pass git validation and fetch uses an option terminator. Repository
  paths stay inside their workspace; task worktrees stay inside their project
  folder, including resolved symlinks. Shell forwarder arguments are quoted; curl
  ignores user curl configuration and bypasses proxies. Known billing keys and
  endpoint overrides are stripped for both agent providers.
- Customization keys and version IDs are validated; commits name only the project
  path. Symlinked project paths are rejected. Git hooks/signing are disabled for
  customization commits. YAML is limited to 1 MiB per file, 50 levels and no aliases;
  parse errors do not echo source text. The application home is owner-only (0700).
- Request logging omits bodies, credentials and query strings, and redacts hook,
  MCP and invitation URL tokens. Unknown-route/parser errors do not echo request
  secrets. Authentication records are not broadcast. Markdown builds escaped React
  elements, permits HTTP(S) links only, and uses `noopener noreferrer`.

## Automatic command decisions

PM-126 has not certified a strict agent boundary. Its revised [verification procedure](SANDBOX-PROBE.md)
separates shell isolation, built-in file-tool permissions and trusted runner hooks/MCP. The
earlier sibling-directory probe does not prove an exact worktree exception under the app home.
Neither HTTP authentication nor a native Bash sandbox establishes that all agent tools are
unable to read app data or connect to app ports. Decision 24's local-binding exception conflicts
with the strict PM-87 requirement; its scope remains unresolved.

The temporary-repository tests in `apps/server/test/sandbox-probe.test.js` reproduce host
execution through shared `post-checkout`, `core.hooksPath` and `core.fsmonitor` using the actual
worktree manager. This proves the host trigger if planting is possible, not native sandbox
planting. PM-131 removed the normal Codex shared-git writable root, but the host git wrapper
still trusts repository executable configuration and hooks. A root grant must not be restored
to work around denied git operations. Narrow trusted git operations need their own validation;
blanket hook disabling alone would leave other executable git settings to review.

When the server auto-allows a Codex escalation (the routine git steps of a developer, lockfile
installs), that command runs outside Codex's sandbox with the server user's rights, including
the repository's git hooks and npm lifecycle scripts. The same holds for the read-only rule's
check commands (`npm test`, `npm run typecheck`, `npx vitest run`, `npx tsc --noEmit`): when a
Codex member's run escalates, for example because its tests listen on localhost, and the rule
allows it, it runs the project's own scripts outside the sandbox. Even a read-only `git` command
runs the programs the repository's configuration names (`core.fsmonitor`, diff and text
conversion drivers). The historical shared-git root grant allowed config writes; removing
that grant does not make host execution a sandboxed operation. The allowed
forms are narrow, and a command the strict parser (`domain/shell-words.ts`) does not fully
understand always goes to a human. The read-only rule reads the command's text only: it cannot
see where a symbolic link in a worktree points. `xargs` takes names only from a lister
(`git ls-files`, `git diff --name-only`, `grep -l`, `find`, `ls`) through whole-line filters, and
runs only commands whose options cannot write or run anything (`cat`, `grep`, `wc`, …) or that
get the names after `--` (`git`, `rg`, `sort`), because a file named like an option would be
one. The names are taken as found, so a file whose path holds a blank or a newline can still
split into two items. A Codex member never runs in `bypassPermissions`, where nothing would be
asked at all.

## Findings

| Severity | Finding                                                                                                                  | Status                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| High     | Missing API CSRF checks; WebSocket origin comparison ignored scheme/port                                                 | Fixed: exact origin checks, including login/logout                                                                             |
| High     | Logged-out, expired or removed members retained WebSocket streams                                                        | Fixed: live session/membership checks and serialized commands                                                                  |
| High     | Invited users could select arbitrary host workspaces by creating projects                                                | Fixed: initial host owner creates projects                                                                                     |
| High     | Admin configuration edits could rebind privileged accounts or grant admin access                                         | Fixed: owner-only bindings, grants and filesystem changes; invite acceptance rechecks inviter                                  |
| High     | Hook bearer tokens appeared in request logs                                                                              | Fixed: capability-path redaction and generic request errors                                                                    |
| High     | Hook guards lacked rebinding checks; MCP accepted a token revoked during body reception                                  | Fixed: early local guards and late capability check                                                                            |
| High     | Repository paths and existing worktrees could escape project boundaries; customization parent symlinks redirected writes | Fixed: canonical containment and symlink rejection                                                                             |
| Medium   | Missing Secure cookies behind HTTPS and old sessions surviving login rotation                                            | Fixed: proxy-aware flag and presented-session revocation                                                                       |
| Medium   | Concurrent login attempts bypassed the failure counter                                                                   | Fixed: reserve attempts before hashing; explicit Argon2id parameters                                                           |
| Medium   | YAML parsing lacked explicit resource limits; local curl/git configuration influenced internal operations                | Fixed: bounded YAML, disabled customization hooks/signing and curl config/proxy bypass                                         |
| Medium   | Additional provider endpoint/billing overrides survived environment filtering                                            | Fixed: common OpenAI/Azure overrides stripped for all providers                                                                |
| High     | Shared Unix identity permits agent/terminal users to access host files and credentials                                   | Accepted for a trusted team only; requires OS isolation for hostile tenants                                                    |
| Medium   | Arbitrary transcripts, tool input and terminal output can contain user/repository secrets                                | Accepted: these are intentionally visible to internal project members; no general secret detector is claimed                   |
| Medium   | Proxy users share an in-memory login throttle, and a restart resets it                                                   | Accepted locally: conservative shared limit avoids trusting spoofable client IP headers; add proxy-level limits before hosting |

Regression coverage includes cookie rotation/expiry, concurrent login attempts,
origin checks, revoked terminal access, project privileges, isolated permission
waiters, expired capabilities, body limits, path escapes, YAML limits, URL redaction,
provider environments and hostile markdown. Integration tests use fictional data,
temporary repositories and fake CLIs only.

## Provider-neutral policy preparation (PM-87 / PM-127)

The policy contract records access intent, including the distinction between an original
developer worktree and an independent disposable review copy. It is not yet an OS isolation
boundary: current starts explicitly use legacy enforcement and retain the broker's existing
automatic decisions and remembered permissions. Both adapters reject strict enforcement
until it can be implemented and verified; listing protected paths or network domains alone
does not enforce them. Codex consumes semantic team-tool grants without interpreting Claude
allow rules. Shared git metadata is not granted as an extra writable root (PM-131).

A review-copy placement alone grants no writes, even with historical `acceptEdits`.
The separate `reviewCopyMode: test` requires strict intent, and grants only the copy's own
repository/git/cache/temp roots. `plan` and explicit `read_only` cap it to reading. Strict
provider verification is still required before any such policy can run; the current
adapters reject it. The original worktree and other members' copies do not become writable
merely because they are listed as readable roots.

Member workspaces (PM-138, off by default) are independent clones without a remote and without
shared objects, so a member's repository configuration, hooks and objects never reach the project
repository or a teammate; only committed branches travel, fetched by the server by explicit path.
The server's git commands in a member workspace (or reading a teammate's) run with
`core.hooksPath=/dev/null`, no fsmonitor, no system or global configuration and only the local
`file` transport. Clean/smudge filters that a repository's own configuration names still run on
the server's checkouts there: outside the VM they run as the same user the sessions already are;
behind the VM boundary (PM-140) every command in a workspace runs as its member's worker instead,
and commits cross accounts only as bundles. Workspaces are reserved for one
session's process group at a time, so no session can switch the branch under another.

The model and fake CLI regression tests prove rendering and compatibility only. PM-126's
corrected manual macOS subscription probe and the PM-130 adversarial matrix must establish
the real filesystem/network boundary, hook/lifecycle confinement and publishing protection.
The accepted local-port exception is recorded in decision 24; Linux is not certified by the
macOS probe.

## Managed VM profile (PM-137)

[VM.md](VM.md) describes a machine whose boundary is **measured**, replacing the earlier plan to
certify each CLI's own sandbox (decision 25). What it establishes, with the report that proves
it (`deploy/vm/verify.sh`, verdict `evaluateVmReadiness()`):

- The app, the pinned CLIs and the boundary settings (`/etc/projectman`, the egress rules, the
  units) are root-owned and neither the service account nor any worker can write them. The data
  directory, the SQLite database, the cookie secret and the service home are the service's alone
  (0700); a worker cannot read them, cannot read another worker's home and cannot see other
  accounts' processes or arguments (`hidepid`). No account of the profile has sudo, and the service
  runs with `NoNewPrivileges`.
- Workers are per-member unprivileged accounts (uids 20000+, own group, `nologin`, locked password,
  not allowed to ssh). Each worker's subscription login is made once by a person for that worker
  (PM-140); no worker home holds a copy of another account's login, a GitHub login or an SSH key.
- Nothing of the host is shared in (no 9p, virtiofs, sshfs or similar mount), ssh agent forwarding is
  off, no worker can write a control socket outside a short list (Tailscale's LocalAPI socket
  included: its directory is root-only), and only loopback, the SSH port and tailscaled's own
  tailnet-address listener listen (the ingress rules drop everything but SSH and HTTPS from
  `tailscale0`). The system-managed egress rules (nftables, loaded by a root unit at boot) refuse
  the service account and the workers any private, link-local, CGNAT (tailnet) or multicast IPv4
  address and all non-loopback IPv6, so the host behind the NAT, the LAN, the metadata address and
  the tailnet are unreachable to them, over IPv4 and IPv6. NAT alone does not do this, which is why
  a probe with a positive control proves it. A guest without IPv6 connectivity cannot be probed over
  IPv6; the rule is then checked as loaded.
- Remote access stays as before: loopback listener, SSH port forwarding from a Mac, Tailscale
  Serve (HTTPS only, never Funnel) from a phone, and the unchanged login, Origin, hook and MCP
  protections.

A mere environment flag or a VM label never counts: the report schema is strict and a missing check
fails. Decision 24's local-port exception does not apply inside the VM profile beyond what VM.md
states (loopback, with the app's token checks).

## The VM boundary (PM-140)

The server behind the boundary (`PROJECTMAN_BOUNDARY_CONFIG`) starts nothing as itself. What holds,
and how the readiness report proves it on the real guest (the `launcher` and `domain-gate` checks
run a fixed probe as a worker in its real unit, with root's positive controls):

- **Sessions and workspace commands run as the member's worker**, through the root launcher, each in
  a transient unit with no capability, `NoNewPrivileges`, a read-only system, only the worker's home
  writable, other processes invisible, no namespaces, a loopback-only IP filter, and no access to the
  system bus, the resolver, systemd's transient unit files, container or Tailscale sockets or the
  service's data. The launcher takes no shell, environment or uid from the service: a registered
  member, a pinned program and a directory in that member's home. Its socket is the service's
  group's only; it holds no secret and writes no audit. A repository's hooks, filters and
  configuration run only as its member (workspace git goes through the launcher; commits cross
  accounts as bundles), never as the service.
- **Workers reach the network only through the egress proxy**: the nft rules give them loopback
  without the resolver and sshd, and the proxy allows the base list and exact, expiring allowances.
  Direct IP, IPv6, UDP and DNS, QUIC, another proxy, an SSH tunnel, a DNS answer pointing inside
  (rebinding), a redirect to another host (a new CONNECT, checked again) and a TLS name other than
  the allowed host do not get through. The service's own egress keeps the baseline rules (no
  private side).
- **A grant is an authorization, not a widening**: an allowed boundary request for an egress
  operation opens one host and one port for one member in one project until its expiry; the proxy
  consumes the grant (PM-139's single-operation consumption) and records the allowance in the same
  transaction; an owner can revoke it. A refused destination registers an operation once per session
  and destination and never asks anyone by itself. An allowed domain is not permission to pay,
  create secrets or deploy: those stay operations of the protected adapters (PM-142 and later).
- **Fail closed**: an invalid boundary configuration stops the server; a missing, failing, foreign
  or stale readiness report, an unreachable launcher or a proxy that does not listen refuses every
  new session (`runtime_boundary_not_ready`); a session whose service connection drops is stopped.
- **Identity**: the proxy takes the account from the kernel's socket table and the session from its
  proxy credentials (a per-session token, not the MCP token, revoked when the session ends); a token
  presented by another worker is refused. The hook and MCP endpoints keep their per-session tokens.

What it does not establish: a worker can read its own session's tokens and its own login (the CLI
runs as the worker), and reach other workers' loopback listeners; data can leave to an allowed
destination; a revoked allowance does not cut a tunnel already open; the readiness report is at
most two hours old, so a change made in between shows on the next report; the boundary does not
defend against root, the admin, the hypervisor or a kernel flaw. Each worker's subscription login
is the owner's choice pending on PM-140 (per-worker logins as implemented).

## Before server hosting

1. Use a dedicated Unix account and private application home. Separate mutually
   untrusted users' agent processes, repositories and credentials at the OS boundary.
   Worktrees and role checks are not a filesystem sandbox. Review repository hooks,
   CLI configuration and permission modes before trusting a workspace.
2. Terminate HTTPS with Tailscale Serve. Preserve the public Host, overwrite
   `X-Forwarded-Proto`, and keep forwarding/identity headers so hook/MCP requests
   through the proxy are rejected. Prefer denying `/hooks` and `/mcp` at the proxy.
   Verify Secure cookies and the browser's exact origin against the deployed proxy.
3. Apply tailnet ACLs and proxy connection/body/rate limits. Keep the app bound to
   loopback; do not expose the development server. Provision the first owner locally.
4. Protect backups of SQLite, the signing secret, transcripts and customization
   history. Rotate exposed capabilities, review log retention and redact secrets
   before sharing transcripts. Audit dependencies and installed CLI versions during
   deployment; dependency vulnerability scanning was outside this source review.
