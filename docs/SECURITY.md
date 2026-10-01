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
the server's checkouts there: until the VM boundary (PM-140) separates the server's account from
the members', they run as the same user the sessions already are. Workspaces are reserved for one
session's process group at a time, so no session can switch the branch under another.

**Publishing from the managed VM (PM-142).** The only way a task branch leaves the VM is the
publishing gate ([GITHUB.md](GITHUB.md#publishing-from-the-managed-vm-pm-142)): the server takes
member, task, repository and branch from its own records, builds the refspec itself and pushes with a
separate GitHub identity whose token only the service reads (a file refused unless group and others
cannot read it). The identity has no administration, workflow, secret, environment or deployment
permission, is no bypass actor, and the repository's rulesets refuse it the default branch, force
pushes, deletion, tags and merging; a deployment sits behind an environment with the owner as required
reviewer. The token is redacted from every log and answer; the git and gh it is given run with a
minimal environment of their own and never inside a worker's clone. The pull request's author is
recorded from the authenticated session, so a shared bot login cannot launder authorship around the
no-self-review rule. Enforcement by GitHub depends on the plan and the repository: it is verified by
the trial script on a throwaway repository, not assumed.

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
  not allowed to ssh). The provider login is made once by a person, as the service account in the
  VM, and no worker home holds a login file: the subscription login is not a standing copy handed
  to every account (a design for worker sessions that need authentication is PM-140's).
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

What it does not establish: the protected launcher that runs sessions as the workers and the
domain-level network gate and publishing gate are PM-140; until then the CLIs still run as the
service account, which holds the login and the data, so a compromised session is the service.
The egress rules do not restrict internet destinations, root or the admin. A mere environment
flag or a VM label never counts: the report schema is strict and a missing check fails.
Decision 24's local-port exception does not apply inside the VM profile beyond what VM.md states
(loopback, with the app's token checks).

## The question-free profile (PM-141)

In the managed VM profile the CLIs run with their own approvals and sandbox off (Claude Code in
`bypassPermissions`, Codex with `danger-full-access` and approval `never`; decision 26), so the whole
protection is the boundary VM.md measures. What keeps that from being a weaker Mac:

- **No way in by assertion.** The profile is an owner-made installation setting, and each start
  additionally needs the machine's own readiness report (Linux host, every required check, the
  launcher and the domain gate passed, current, strict schema). A repository file, an environment
  flag or a member's `permissionMode` never selects it; on the Mac and on a VM without a complete
  report a session does not start at all (`managed_vm_unavailable`), and there is no fall-back that
  would start it more freely. An existing member's mode is read, never rewritten, so leaving the
  profile restores the configured behaviour (decision 19 and 21 stand everywhere else).
- **A CLI version the settings are proven for.** The installed version must be a pinned one; another
  release may read the flags differently, so it is refused, not tried.
- **The VM's own configuration cannot reopen a door.** A managed policy, the provider's user
  configuration or a trusted Codex project file that sets hooks, MCP servers, approval or sandbox
  rules, credentials or endpoints refuses the start (names only in the error); the Claude start
  leaves out the project's settings and MCP file and keeps only this session's team server (PM-49).
  The service's SSH agent and GitHub token variables never reach a worker.
- **No human approval to be tricked into.** A request that arrives anyway is refused, not queued for
  an inbox item a person might approve from a phone without context. Anything that leaves the machine
  is stopped at the network gate or decided as a boundary request (BOUNDARY.md); the owner's
  exceptions apply there, not in the CLI.
- **Nothing carries across a change.** A conversation, a working directory or an "allow for this
  session" of the other profile is never reused, and the session's unconsumed boundary requests are
  revoked.

Limits: the real CLIs are not exercised by the automated tests (fakes only). What the flags do in
the pinned versions, and that a forbidden step really stops at the gate, is the human trial of
VM.md in a throwaway VM. Until the launcher (PM-140) runs sessions as the worker accounts, the
profile cannot be activated (its report check stays `unverified`).

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
