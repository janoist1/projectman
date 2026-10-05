# Security

Reviewed 2026-09-30. This is an application security review, not an independent
penetration test or a guarantee of isolation between agent processes.

## Threat model

Protect against unauthenticated local HTTP clients, hostile websites, and tailnet
users attempting actions outside their project membership and access level.
Tailscale connectivity is not authentication. First-run setup is a local operation:
complete it before granting other people access to the machine.

The owner's live instance is also reachable from the internet at `https://chopper.istvan.io`
(PM-200). The public entrance adds two attackers to the list: anybody on the internet who finds
the address, and whoever gets into the Cloudflare account or the Access login. It is defended in
layers: Cloudflare Access (an allow list of exact email addresses) in front, `cloudflared`
re-checking the Access token before it passes a request on, only the application's own paths
let through (not `/hooks` or `/mcp`), and projectman's own login, origin check and attempt
limits behind them. See "Public entrance through Cloudflare" below for what it requires and what
risk it leaves.

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
  perform password verification. Login reserves one of ten attempts per client per
  15 minutes, and one of 50 for all clients together, before hashing and gives both back
  when the login succeeds, so only failures count; invitation inspection/acceptance is
  limited the same way (own budgets). The client is the connection's address, which behind
  a loopback proxy is the proxy's. With `PROJECTMAN_CLIENT_IP_HEADER` set (PM-211, e.g.
  `cf-connecting-ip` behind Cloudflare) it is the address in that header, but only for a
  loopback peer and a header holding exactly one valid IP; any other request counts under
  the connection's address. `X-Forwarded-For` is never read. The shared cap bounds guessing
  when a client can change its address; its price is that a flood of failures can refuse
  every login and invitation attempt until the window ends. Both limits are in memory (a
  restart resets them).
- Mutating API requests compare Origin against the exact scheme, Host and port;
  cross-site Fetch Metadata is rejected. Missing Origin supports non-browser
  clients; opaque `null` origins are rejected. WebSockets use the same origin
  comparison, revalidate sessions and check current membership for deliveries and
  terminal operations. API responses are not cached; pages suppress referrers.
  Every response (pages, API, errors, attachments) carries `Content-Security-Policy:
frame-ancestors 'none'` and `X-Frame-Options: DENY` (PM-211), so no other site can frame
  the interface to trick a signed-in user (clickjacking). The interface uses no iframe.
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
  `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`,
  `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store` and an encoded
  `Content-Disposition` (a test asserts the CSP and the frame header on every route).
  Checked in Chrome against a local development server (2026-10-01, before `frame-ancestors`
  and `X-Frame-Options` were added, PM-211): the PDF viewer opens a PDF served with that
  sandbox CSP, as a page of its own and inside an iframe (which these two headers now
  forbid; the interface opens an attachment in a page of its own), a PNG loads in an
  `<img>`, HTML and SVG uploads are not rendered (they are downloads), and every content
  and download response carried exactly the headers listed here. Repeat the check (the PDF
  as a page of its own) after a Chrome major update or a change of these headers: the
  sandbox directive is what a browser may one day refuse to show a PDF under.
- AI members reach attachments through the team tools (PM-113), in their own name and under the
  same rules. `attach_file` never takes a directory from the caller: the server uses the working
  directory it recorded for the session the MCP token names. It opens only a regular file inside
  it (by whole path components, so a sibling with the same prefix is outside), refuses symbolic
  links anywhere on the way, files with several hard links, directories, FIFOs (opened without
  blocking), sockets and devices, and checks the opened handle afterwards: its real location
  must still be inside and be the very file opened, so a path swapped between the checks and the
  open is refused. The session folder (PM-268; the server computes it, the caller never names
  it) is a second root for an absolute path: only the folder the server made for the calling
  session's current process (it remembers it; an older folder of the same session is not it), and only
  while the folder is its own real path (the sandbox lets a session empty its folder and put a
  symbolic link in its place, so a folder or a directory above it that is a link is refused, and
  so is a folder swapped for one before the file is read); every check above applies to it
  unchanged, and a relative path still means the working directory. The content is streamed from that handle and refused when its size or time
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
  endpoint overrides are stripped for every agent provider (Claude, Codex, and the Gemini,
  Antigravity and NanoGPT variables); only a trusted `extra` of the adapter brings one back.
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

## Claude members: the mode, the approver and the hard denials (PM-165)

Claude Code enforces the member's mode itself (`--permission-mode`); the server adds no mapping.
What the server adds, in every mode and on the legacy (Mac) profile:

- **Deny rules in `--settings`** (they hold in `auto` too): `git push`, `gh pr create`,
  `gh pr merge` where the repository has no GitHub; the built-in file tools may not read or change
  the user's credential files (`~/.ssh`, `~/.config/gh`, `~/.claude/.credentials.json`,
  `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude/hooks`, `~/.claude.json`,
  `~/.codex`, `~/.gemini`, `~/.npmrc`; the rest of `~/.claude` stays open: saved tool outputs and
  the plan mode's plan file are there) and the sensitive parts of the app home (database, cookie
  secret, logs, customization repository, members' memory, publishing identity, spool, `secrets`,
  `providers`); `WebFetch` may not reach
  `localhost` or `127.0.0.1`. The list is `sensitivePaths` and `HARD_DENIED_HOSTS` in
  `domain/session-policy.ts`.
- **A question the CLI still asks** goes through `commandVerdict`, then to the member's approver.
  Approver `none` (the default of a new member) refuses it without an inbox item and tells the agent
  the refusal is final; the refusal is on the timeline (`permission_refused`). So does a refusal of
  the auto mode's classifier (`PermissionDenied` hook). The approver applies to Codex members too
  (the refusal is the same); the deny rules and `autoMode` are Claude's only.
- **Approver `ai`** (PM-169, only with the owner's switch `team.boundary.enabled`) sends the question
  to an AI member holding `boundary_authorization` instead of the sponsor; see PROVIDERS.md. The AI
  never decides publishing, a release or `main`, credentials, the live instance or a lasting
  widening of the host, the decider's own requests, or anything once the lead deadline
  (`team.boundary.leadTimeoutSeconds`) has passed or the decider is gone: those go to the sponsor or
  an owner, an error or a timeout never means permission, and the owner may answer any item at any
  time. Gates and release approvals stay human-only (`resolve` refuses an AI; the one other way an AI
  closes an item, `resolveDelegated`, takes only a delegated permission item).
  **Residual risk:** the decision is about free text, and the pre-filter in front of it
  (`permissionOwnerCategory`) is pattern matching a command can hide from; a mistaken `allow` of the
  decider is a lasting one for that call. The decider's duty text tells it to escalate doubtful
  requests, and the routing itself sends a request whose input is longer than 4,000 characters, a
  tool of another MCP server (email, shared documents, ...), an unknown tool, and a file write or
  patch outside the session's directories (Codex `apply_patch` included) to a person. Waking the
  decider uses subscription capacity and competes with its own work.
- The `autoMode` prose in `--settings` only guides the classifier; it is not a boundary.
- The managed VM profile is unchanged: its limits are outside the CLI.

**The CLI's sandbox (PM-167, decision 28).** Every legacy Claude session runs its shell in Claude
Code's own sandbox: a developer's in its worktree, every reading session (the
reviewer, QA, security, analyst, architect, designer, devops, chats, scheduled runs) in one that
writes only the temp directory, with its working directory (the project's main checkout or its
review copy), every extra directory (the developer's worktree) and the installation's other
checkouts (the project's workspace, the app home with every member's worktree and workspace, the
server's own checkout such as `~/projectman-live`; PM-188) in `denyWrite`. Both put the
same `sensitivePaths` in `denyRead`, so a shell command cannot read the credential files or the
live data either (the database as the glob `db.sqlite*`, with its `-wal` and `-shm` files; see
PROVIDERS.md for the Linux caveat). The built-in file tools are outside the sandbox: `Edit` deny
rules keep each of a reader's `denyWrite` directories read-only for them, and the PM-165 `Read`
rules keep the credentials out of reach. A reader runs in its own mode (Auto too) and asks nothing
for what the sandbox allows. On a repository on GitHub, `gh pr view` and `gh pr diff` with any
arguments (`gh pr view:*`) run outside the sandbox (`excludedCommands`), pre-approved by the
reader's allow list, because they need the GitHub CLI's login; Claude Code 2.1.284 does so only for
a command of their own, so a chain, a pipe, a substitution or a redirection into a file keeps the
whole command inside. That is the CLI's behaviour, read in its code, not a rule of ours: a later
version must be checked again (SANDBOX-PROBE.md). A local-only repository gets no exception.

**The session folder (PM-268).** A Claude session in the legacy profile, a reader too, writes one
more place: its own session folder, for the screenshots and reports it attaches. It is outside
every checkout and the app home (`<tmp>/projectman-sessions/<hash of the app home>/<session id>.<random>`),
nothing outside a sandbox runs or loads from it, and it is removed with the process (and the whole
root when the server starts). Only the server computes the path; the session gets it in
`PROJECTMAN_SESSION_DIR` and names no other. The name is new at every start: a command that
outlived an earlier run (a detached one is not killed with the process) holds the old path in its
sandbox, may empty the old folder, and could try to leave a symbolic link there for the next start
to write through; the next start has another, unpredictable path, made exclusively and checked
(a real directory of the server's user), so the old rule never covers it. The old folder is
renamed to a `.trash-<random>` name before it is removed, so a survivor cannot swap a directory
in it for a link while the removal walks it. A process group left running is not killed (the
runner stops the main process only; a separate card). The root is checked before use: a real directory (not
a symbolic link, nor below one), the server user's, mode 0700, else the folders are off and the
server logs the reason and runs on (the sweep must never empty a directory somebody else pointed
the predictable path at; a symbolic link in it is removed as a link). Every Claude session of the
instance reads every member's folder below the root, and writes only its own (PM-333, the owner's
decision): nothing secret goes into a session folder. Another instance's root (another home hash)
is not opened. Codex and the
managed VM profile get none. Playwright's browsers directory is read-only for every sandbox
(`PLAYWRIGHT_BROWSERS_PATH`); it is left out when it is the user's home or the app home or above.

**A developer reads only its own work (PM-153).** A developer's sandbox reads nothing below the
user's home and the app home but its worktree, its task's attachments, its own npm cache and
development data (below), the shared git directory, `~/.gitconfig`, `~/.config/git` and Claude
Code's shell snapshots (`~/.claude/shell-snapshots`, sourced before every command; they hold the
shell's functions, aliases and options) and the one file the user's git configuration names as
`core.excludesfile` (PM-216; git warns about it in every command otherwise; only an existing
regular file, never the home or a directory above it, nor one in a denied path or the app home).
Its git settings are a system-level file in its sandbox directory (`GIT_CONFIG_SYSTEM`, readable
but not writable, rewritten at every start; not `GIT_CONFIG_COUNT` entries, which would replace a
session's own): `gc.auto=0` and `maintenance.auto=false` (no automatic `pack-refs` at the
denied `packed-refs`) and `core.packedRefsTimeout=0`. A `git commit` still prints "Unable to create
'…/packed-refs.lock'" after it: its last step deletes the `CHERRY_PICK_HEAD` pseudo-ref, and every
ref-deleting transaction locks the shared `packed-refs`. The commit exists; the message is known
and harmless, and no git setting avoids it. The lock is not writable on purpose: a sandbox could
change the lock file while the host holds it, or leave one behind and stall the integrator; the
timeout only removes git's one-second wait. Other worktrees, the app's data, the integrating checkout and the
credentials stay closed; a credential path stays in `denyRead` as well, and the narrower path
wins, so nothing re-opens it. Its commands never write the default branch and the integrating
checkout's `HEAD`, `index` and `packed-refs` (with their lock files) in the shared git directory,
neither from the shell nor with the file tools (`Edit` rules), and never see `GH_TOKEN`,
`GITHUB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN` and `SSH_AUTH_SOCK`. Claude Code still asks for a
command with a here-document it cannot analyse (PM-142, 12:44), sandbox or not; the context pack
tells the member to write files with the editing tools instead.

**A developer writes nothing the host runs or loads (PM-193).** Before PM-193 a developer's
sandbox wrote the user's `~/.npm` and `~/.projectman-dev`. The host runs code from
`~/.npm/_npx/<hash>/node_modules` on its next `npx <package>` (the owner, the integrating
session, sessions outside a sandbox), unchecked; `~/.npm/_cacache` keeps package metadata without
an integrity check; the host's `npm run dev` loads `~/.projectman-dev` (members' settings,
permission modes). A planted package or setting would have run or applied with the owner's
rights. Now each developer has its own `<app home>/member-caches/<KEY>/<handle>/npm-cache` and
`…/projectman-dev`, made by the server; the sandbox writes only those, and `npm_config_cache` and
`PROJECTMAN_HOME` (Claude Code's `env` setting) point there. Nothing outside that member's
sandboxed sessions uses them; readers get none, and the host's `~/.npm` and `~/.projectman-dev`
are neither written nor read.

**Residual risk (owner's decision, decision 24 and PM-156).** Sandboxed commands may listen on
local ports, so they also reach the live instance's port 4800, readers included; the owner decided
that port stays reachable up to the VM (PM-156). A reader's sandbox reaches the npm registry. A
Codex member is not bound by the Claude rules at all before the VM; its own sandbox (`read-only`
for a reader) is its limit. A developer's file tools have no such `Edit` deny rules outside its
worktree (its own worktree is inside the app home, and a deny rule wins over an allow rule): there
the CLI's own questions and Auto's classifier hold. The sandbox's denials were checked on the
owner's machine in the PM-167 manual run; its result and what is still to run (PM-153) are in
PROVIDERS.md.

**Residual risk (PM-153, accepted until per-member workstations or the VM).** The shared git
directory of the worktrees is the integrating checkout's `.git`, and the sandbox lets a developer
write everything in it but `hooks`, `config` and the PM-153 files. So a developer's commands can
still change other tasks' branches and their `worktrees/<name>` metadata, other refs (tags,
remote-tracking refs), the reflogs and the object store (a `git gc` or `git prune` there acts on
the shared objects). They cannot move the default branch, which is what reaches the public
repository, change the integrating checkout's `HEAD` and `index`, or add replacements
(`refs/replace`) and grafts (`info/grafts`). **The content seen locally can still be forged:** the
object store is writable, so an existing loose object of the default branch can be overwritten,
and a local checkout, diff or merge reads it without checking its hash. The `main` ref does not
move, but what the integrating session sees and tests on the host under that ref may not be what
was committed; a push of `main` sends those objects as they are. Accepted until per-member
workstations or the VM; a per-member workstation has its own clone and nothing shared. What the host's own git does in a developer's worktree (its
`.git` file, which the developer can rewrite) stays the host-git risk of PM-126/PM-131
(PROVIDERS.md); PM-193 closed the npm cache and the development data, not that.

`~/.claude` is not denied as a whole, because the members run with the user's own `~/.claude`
(the runner sets no `CLAUDE_CONFIG_DIR`) and Claude Code saves large tool outputs under
`projects/<cwd>/<session>/tool-results/` and the plan mode's plan under `plans/`; a deny rule wins
over an allow rule, so no exception could be made. The consequence is a residual risk: the
conversation transcripts of other sessions under `~/.claude/projects/` can be read by a member's
file tools. Only the login and settings files are denied (`.credentials.json`, `settings.json`,
`settings.local.json`, `hooks`). A separate configuration directory per member would close it.

## Findings

| Severity | Finding                                                                                                                  | Status                                                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Missing API CSRF checks; WebSocket origin comparison ignored scheme/port                                                 | Fixed: exact origin checks, including login/logout                                                                                                                                                                                                                                             |
| High     | Logged-out, expired or removed members retained WebSocket streams                                                        | Fixed: live session/membership checks and serialized commands                                                                                                                                                                                                                                  |
| High     | Invited users could select arbitrary host workspaces by creating projects                                                | Fixed: initial host owner creates projects                                                                                                                                                                                                                                                     |
| High     | Admin configuration edits could rebind privileged accounts or grant admin access                                         | Fixed: owner-only bindings, grants and filesystem changes; invite acceptance rechecks inviter                                                                                                                                                                                                  |
| High     | Hook bearer tokens appeared in request logs                                                                              | Fixed: capability-path redaction and generic request errors                                                                                                                                                                                                                                    |
| High     | Hook guards lacked rebinding checks; MCP accepted a token revoked during body reception                                  | Fixed: early local guards and late capability check                                                                                                                                                                                                                                            |
| High     | Repository paths and existing worktrees could escape project boundaries; customization parent symlinks redirected writes | Fixed: canonical containment and symlink rejection                                                                                                                                                                                                                                             |
| Medium   | Missing Secure cookies behind HTTPS and old sessions surviving login rotation                                            | Fixed: proxy-aware flag and presented-session revocation                                                                                                                                                                                                                                       |
| Medium   | Concurrent login attempts bypassed the failure counter                                                                   | Fixed: reserve attempts before hashing; explicit Argon2id parameters                                                                                                                                                                                                                           |
| Medium   | YAML parsing lacked explicit resource limits; local curl/git configuration influenced internal operations                | Fixed: bounded YAML, disabled customization hooks/signing and curl config/proxy bypass                                                                                                                                                                                                         |
| Medium   | Additional provider endpoint/billing overrides survived environment filtering                                            | Fixed: common OpenAI/Azure overrides stripped for all providers                                                                                                                                                                                                                                |
| High     | Shared Unix identity permits agent/terminal users to access host files and credentials                                   | Accepted for a trusted team only; requires OS isolation for hostile tenants                                                                                                                                                                                                                    |
| Medium   | Arbitrary transcripts, tool input and terminal output can contain user/repository secrets                                | Accepted: these are intentionally visible to internal project members; no general secret detector is claimed                                                                                                                                                                                   |
| Medium   | Proxy users share an in-memory login throttle, and a restart resets it                                                   | Fixed (PM-211) for a trusted entrance: `PROJECTMAN_CLIENT_IP_HEADER` counts per client address (loopback peer, one valid IP only, never `X-Forwarded-For`), plus a shared cap of 50 per 15 minutes; unset (`tailscale serve`) all users still share one address, and a restart still resets it |
| Medium   | No clickjacking protection: another site could frame the interface                                                       | Fixed (PM-211): `frame-ancestors 'none'` and `X-Frame-Options: DENY` on every response                                                                                                                                                                                                         |

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
  writable, other processes invisible, no further namespaces, a network namespace of its own (only
  its own loopback; a bridge carries the app's and the egress proxy's ports to the member's own
  unix sockets of the service), a loopback-only IP filter, and no access to the
  system bus, the resolver, systemd's transient unit files, container or Tailscale sockets or the
  service's data. The launcher takes no shell, environment or uid from the service: a registered
  member, a pinned program and a directory in that member's home. Its socket is the service's
  group's only; it holds no secret and writes no audit. A repository's hooks, filters and
  configuration run only as its member (workspace git goes through the launcher; commits cross
  accounts as bundles), never as the service.
- **Workers reach the network only through the egress proxy**: their units have no network but
  their own loopback and the bridge; in the host namespace the nft rules give a worker the proxy's
  port only (no other member's server, no service port, no resolver, no sshd). No member can bind a
  port of the service. The proxy allows the base list and exact, expiring allowances.
  Direct IP, IPv6, UDP and DNS, QUIC, another proxy, an SSH tunnel, a DNS answer pointing inside
  (rebinding), a redirect to another host (a new CONNECT, checked again) and a TLS name other than
  the allowed host do not get through. The service's own egress keeps the baseline rules (no
  private side).
- **The service reads a worker's files only defensively**: transcripts and hand-over bundles are
  opened without following a symlink, without blocking on a FIFO, as regular files only, checked
  against their real path in the worker's home (transcripts, on every read) or their owner (bundles),
  and read from the checked descriptor.
- **A grant is an authorization, not a widening**: an allowed boundary request for an egress
  operation opens one host and one port for one member in one project until its expiry; the proxy
  consumes the grant (PM-139's single-operation consumption) and records the allowance in the same
  transaction; an owner can revoke it. A refused destination registers an operation once per session
  and destination and never asks anyone by itself. An allowed domain is not permission to pay,
  create secrets or deploy: those stay operations of the protected adapters (PM-142 and later).
- **Fail closed**: an invalid boundary configuration stops the server; a missing, failing, foreign
  or stale readiness report, an unreachable launcher or a proxy that does not listen refuses every
  new session (`runtime_boundary_not_ready`); a session whose service connection drops is stopped.
- **Identity**: the proxy takes the member from the bridge socket a connection came through (on its
  loopback port, from the kernel's socket table) and the session from its proxy credentials (a
  per-session token, not the MCP token, revoked when the session ends); a token presented by
  another member is refused. The hook and MCP endpoints keep their per-session tokens.

What it does not establish:

- A worker reads its own login and the tokens of its own sessions (the CLI runs as the worker), in
  every project: all of a member's sessions share its uid, and `ProtectProc=invisible` hides only
  other accounts' processes, so one session can read another live session's egress token from
  `/proc` and use that session's project allowances. A handle's worker is shared by every project
  of the instance (one `pmw-<handle>`): accounts per member and project are an open question for
  the owner ([ROADMAP.md](ROADMAP.md)).
- A CLI can still read a billing variable from a file the member controls (its own
  `~/.claude/settings.json`); the launcher refuses one only on the command line. The subscription
  check of the login and the provider profile (PM-141) cover that.
- Data can leave to an allowed destination. The readiness report is at most two hours old, so a
  change of the rules made in between shows on the next report (the units' own IP filters and
  network namespaces hold meanwhile). `/api/providers` reports the service's own CLI logins, not
  each worker's (a session start checks the worker's). Codex plan usage is not read from worker
  transcripts.
- The boundary does not defend against root, the admin, the hypervisor or a kernel flaw.

Each worker has its own subscription login (the owner's choice on PM-140, 2026-10-01).

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

## The move to the VM (PM-143)

[MIGRATION.md](MIGRATION.md) moves the owner's data to the VM. What it keeps safe, and what it does not:

- **The package is the most sensitive file the project makes.** It holds the database (accounts and their password
  hashes, every task and message), the cookie signing key, conversations and the owner's unpushed work. It is
  created mode 0700/0600, refused inside the source home or any git repository, and must be encrypted before it
  leaves the machine; it is never a task attachment, a message or a repository file. Checksums in its manifest
  detect damage and accidental change, not a malicious one: a package is trusted because the owner made it and
  carried it.
- **Nothing of the owner's identity moves.** No personal CLI home, no provider login and no `gh` login are
  copied; the VM has new subscription logins and the separate publishing identity (PM-142). A remote URL that
  carries credentials is neither recorded nor restored. The inventory, the cutover sheet and the reports print
  names, counts, modes and commit ids, never file contents or secrets (tested).
- **A copy never works by accident.** A restored or migrated home starts as `standby` (no scheduler, no GitHub
  polling, no session) and a retired one does not start; going active is a person's command that needs the other
  copy to be shown or stated retired. A damaged marker stops the server. The live Mac checkout ignores the marker
  until it is updated, so for that machine the safeguard is the procedure (the instance stays stopped).
- **No automatic rollback of a schema.** A database a newer build migrated is refused by an older one, by
  `verify` and by `check-backup.sh`/`restore.sh` (nothing is restored over a healthy installation first). The
  rollback goes to the untouched old database.
- **Old work is carried, not applied.** Dirty files wait as pending items; `work apply` writes them only into a
  clean checkout of the same commit a person names, and its archive paths come from `git status`, so they cannot
  point outside that checkout (and `tar` refuses `..`). Package contents are otherwise not authenticated.

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

### Public entrance through Cloudflare (PM-200, PM-210)

The Cloudflare variant of points 2 and 3, for the live instance on the owner's Mac (set-up and
verification: [DEPLOY.md](DEPLOY.md), [deploy/cloudflare](../deploy/cloudflare)):

1. HTTPS ends at Cloudflare; `cloudflared` reaches the app over loopback and the edge sends
   `X-Forwarded-Proto: https`, so cookies are Secure. The Host is preserved (no `httpHostHeader`
   or other rewrite in the tunnel): the origin check and "is this request local" both depend on
   it. The first-setup endpoint refuses the request because its Host is `chopper.istvan.io`,
   not a loopback name (`isLocalRequest`): with a Host rewritten to `127.0.0.1` the peer
   (`cloudflared`, loopback) and the Host would both look local, and only Cloudflare's
   `X-Forwarded-For` with the visitor's public address would still tell the difference, a second,
   weaker reason. `check.sh` verifies the Secure cookie, both origin cases and
   the refusal of `POST /api/setup` against the real entrance.
2. The Access application covers the whole hostname with one Allow policy of **exact email
   addresses**. "Emails ending in", "Everyone" and service-token or bypass policies are not
   allowed. The tunnel's `originRequest.access` makes `cloudflared` check the Access token (team
   name and AUD tag) too. Login is by Google or a one-time code, with a stated session length.
3. The tunnel answers 404 for `/hooks` and `/mcp` and for everything but the one hostname. The
   only service is `127.0.0.1:4800`; the development ports are not served.
4. Edge: Always Use HTTPS and HSTS on; nothing cached; Rocket Loader, Email Obfuscation, the
   automatic Web Analytics beacon and every other script injection off; a response-header rule
   sets `X-Frame-Options: DENY` (Set) and **adds** `Content-Security-Policy: frame-ancestors
'none'` (Add, never Set) on every response. The server sends both too (PM-211), and its
   attachment routes send a stricter CSP of their own (`default-src 'none'; sandbox;
frame-ancestors 'none'`) for uploads shown inline: a Set rule would replace it and drop the
   sandbox on the public address.
5. Set `PROJECTMAN_CLIENT_IP_HEADER=cf-connecting-ip` (PM-211) so the attempt limiters count
   per real client.
6. The tunnel's credentials file, its token and the account certificate stay at mode 600 outside
   every repository and are never put into text, notes or messages. The Cloudflare account has a
   passkey or hardware key.

**Residual risks** (known when the owner chose this entrance, PM-200; they do not go away):

- **Cloudflare sees all traffic in clear.** TLS ends at its edge, so it can read the terminal
  (code, secrets typed or printed there, passwords), the pages and the API calls. For client
  projects the owner decides, project by project, whether the contract allows that, before
  work on it goes through this entrance.
- **The Cloudflare account is equivalent to access to the Mac.** Whoever controls it can edit
  the Access policy, add themselves, and reach projectman and from there a terminal running as the
  Mac's user (see the threat model). The passkey or hardware key, a short Access session and a
  review of the account's members and API tokens are the defence; there is no second one.
- **The login limiter sees everyone as `127.0.0.1` until the client-address header is set.**
  Without `PROJECTMAN_CLIENT_IP_HEADER` (or on a build from before PM-211) all remote clients
  share one per-client budget (the shared cap of 50 still holds) and one failing client can lock
  out the others. With it set, the address is Cloudflare's `cf-connecting-ip` for requests that
  come from the loopback proxy. If `tailscale serve` stays on next to the tunnel, a tailnet client
  reaches the same port through a loopback proxy and can send its own `cf-connecting-ip`, so it
  can pick its own address and get a fresh per-client budget each time (the shared cap of 50
  still holds); turn `tailscale serve` off, or accept that.
- A mistake in the Access policy (a wildcard rule, an extra policy) opens the second lock; the
  login and the origin and attempt limits are then the only barrier. Re-read the policy after
  every change and rerun `check.sh`.
