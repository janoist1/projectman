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

- Engine machine keys (PM-313) start with `pme_` and contain 32 random bytes.
  The cloud stores only their SHA-256 hash and display prefix; the full key is
  returned once at creation and never logged. A key authenticates only
  `/engine/link`, grants no access to the human API, and can be revoked immediately.
  Remote engine connections require HTTPS (`wss://`); plain WebSockets are allowed
  only for requests classified as local. HTTPS termination is trusted only from
  a loopback reverse proxy, using the same protocol check as integrator keys.

- The move to the hybrid mode (PM-318, [HYBRID.md](HYBRID.md)) handles two secrets. The machine key is
  made on the Mac (`newMachineKey`), written to `engine.key` with mode 0600 and the `wx` flag (never
  over an existing file), and shown nowhere; only its SHA-256 hash is in the cloud package, and a test
  searches the whole package for the key. The cloud package is a closed list of six entries (the
  database, the cookie key, `secrets/`, `customization/`, `attachments/`, `memory/`), made with mode
  0700/0600, refused inside the home or a git repository, and re-checked by `verify --hybrid-cloud`; the
  Mac's CLI logins, `github-publish/`, `engine.*` and `instance.json` never enter it. After the move the
  Mac's home keeps the stale single-machine database and cookie key (the way back needs them); the
  `engine` role means no server opens them, and the sandboxes' `sensitivePaths` keep sessions out; the
  same list denies `pre-hybrid/` (where the way back keeps the former database, cookie key, secrets and
  machine key) and its staging folder `.hybrid-back/`. The package and the downloaded cloud copy are in
  folders of the person's choice, which sessions' deny-only reads do not cover: the guide has them
  deleted after the upload and after the way back. The
  launchd job (`deploy/mac/com.projectman.engine.plist`) is given `PATH`, `PROJECTMAN_MODE` and
  `PROJECTMAN_HOME` only: no API key and no integrator key.
- Cloud mode (`PROJECTMAN_MODE=cloud`, PM-315) adds three surfaces for the engine, and an
  engine is trusted only with its own sessions:
  - `GET /engine/files/downloads/:token` and `POST /engine/files/uploads/:token` need the
    machine key, a local request or HTTPS (the same check as `/engine/link`, with the IP limit),
    and a 256-bit token issued for that engine alone. A token lives 5 minutes and works once; an
    expired, used or foreign token answers 404. Uploads are written with `wx` to a 0600 file in a
    0700 spool and stop at the size limit of their purpose; a download reads only the path the
    cloud stored and checks the size. A file name from the engine is sanitized before it is stored.
  - `mcp.relay` runs a team-tool request only when the session behind the token runs on the
    engine that sent it (the `engine_id` in the database); otherwise the answer is 404. The
    request goes through `app.inject` on the loopback `/mcp/:token` route, so the `/mcp` rules are
    unchanged. A resent request id gets the cached answer (memory only, per engine).
  - `secret.nanogpt_key` gives the key only to a NanoGPT member session that this engine is
    starting right now (`session.start` sent, `started` not yet seen), once, never from a cache
    and never to the log. Any other request is `secret_not_allowed`.
  - The `hello` of an engine is its own word and nothing more: a session that the database
    records on another engine is not taken over (no owner change, no mirror entry, no events or
    permission decisions accepted from the reporter), and the reporter is told to stop it.
  - The first setup of a cloud installation (PM-317): behind the tunnel no request is local, so the
    setup from a browser needs a one-time **setup code** printed in the server log (12 base32
    characters, held in memory only, compared in constant time, void after 10 wrong tries in total
    or at a restart, consumed by the first successful setup; it exists only while there is no
    owner). A local request needs no code, and a single-machine installation is unchanged
    (`setup_requires_localhost`). A missing code is not a try. The log is read through the host's
    own access, so whoever reads it is the host's owner. The deployment ([HYBRID.md](HYBRID.md))
    starts each process in a cleared environment with only its own variables, runs as an
    unprivileged user without new privileges, and keeps the database replica and the restic
    repository in separate buckets with separate keys; the replica is not encrypted by Litestream
    (the database holds only hashes; protect it with the bucket's encryption and a bucket-scoped
    key). Residual risk: the processes share one uid, so the environment filter does not protect
    against a compromised server, which could read the tunnel token, storage keys and restic
    password from `/proc/<pid>/environ` of the other processes and delete or read the backups.
    The Access application of the engine covers the path `/engine` (the link and the file
    transfers) with the engine's own service token only; that token is never put on the
    whole-hostname application, which would reach `/api`.

- NanoGPT keys are a narrow exception to subscription-only providers (PM-319, owner
  decision 1; PM-328). The server stores the key only in
  `PROJECTMAN_HOME/secrets/nanogpt.json`: directory 0700, file 0600, atomic replacement
  through a private temporary file. Only a human who owns every project may set,
  replace or clear it. Public status contains only whether it is set and when it was
  set; the value, suffix and length never appear in configuration, SQLite, logs,
  API responses or errors. Save-time checking inspects only NanoGPT's HTTP status,
  without reading or recording balances.
  Key values must be printable ASCII without internal whitespace; the shared schema
  validates writes before checking and stored values before session delivery. Non-regular
  secret files, including symbolic links, are refused on read.
  The `secrets` directory is already denied to member file tools through
  `sensitivePaths` (PM-324). Environment delivery (PM-329) is restricted to NanoGPT
  sessions. The local Codex/NanoGPT permission profile denies these paths to sandboxed
  commands as well (PM-356); explicitly approved host commands remain outside that boundary.
  The adapter excludes the key from
  member shell environments, disables Codex notification commands, and rejects ambient
  configuration that can override provider, permissions, hooks or MCP servers before
  launch and resume. NanoGPT shell requests never receive automatic command-policy
  approval; unconditional publishing and in-place editing denials still apply.
  The inbox approver sees the requested command, not the scripts or hooks it will run.
  Before approving `npm ci`, `npm install`, `npm run` or `git commit` outside the sandbox,
  inspect member-controlled lifecycle scripts and Git hooks: they also run outside the
  sandbox with network access. A human approver is recommended for NanoGPT developers;
  with `approver: 'none'`, requested commits are refused.
  If the approver is `ai`, an AI judgment alone decides whether these scripts or hooks
  may run outside the sandbox and expose the key; this remains a risk, rather than a
  verified secret-isolation boundary.

  NanoGPT disables plugin loading and synchronization, ChatGPT apps and suggestions,
  skill-triggered MCP installation, analytics and feedback. Its ephemeral authentication
  store avoids persisted ChatGPT login and keychain credentials; `CODEX_ACCESS_TOKEN`
  is stripped from all child environments. Children cannot inherit OAuth client-id,
  refresh-endpoint or revoke-endpoint overrides either;
  the filter removes `CODEX_APP_SERVER_LOGIN_CLIENT_ID`, `CODEX_REFRESH_TOKEN_URL_OVERRIDE`
  and `CODEX_REVOKE_TOKEN_URL_OVERRIDE`.
  In the Codex 0.159.1 source, plugin requests
  take authentication from `AuthManager`, not the custom provider's `env_key`;
  `load_auth` reads Codex billing variables and auth storage, never `NANOGPT_API_KEY`.
  This is source verification, not a captured network-header test. See
  [plugin authentication](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/core-plugins/src/manager.rs)
  and [authentication loading](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/login/src/auth/manager.rs).
  The remaining public GitHub announcement request has no authentication attached
  and no disable setting in 0.159.1; the request builder only supplies a URL and timeout
  ([announcement fetch](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/tui/src/tooltips.rs)).
  The owner's next manual probe must verify that ChatGPT requests and plugin downloads
  are gone after clearing the probe's existing plugin cache.

  The owner accepted the following temporary host risks on 2026-10-05 (decision 34,
  PM-329; closure in PM-356):
  PM-356 closes the legacy shell-read exposure of `sensitivePaths`, including the secret
  store and the `providers` directory, using a restricted-read permission profile.
  The native Codex 0.159.1 probe on macOS 14.6 arm64 (2026-10-06) denied credentials,
  secrets, database glob matches and symlink traversal; `view_image` also respected the denial.
  The profile is a deny list: other members' worktrees remain readable (PM-360).
  Commands approved by a human or an AI approver outside the sandbox still execute as
  the host user; NanoGPT has no automatic command approval. The NanoGPT CLI process retains
  the key in its environment: commands approved by a human or an AI approver outside the sandbox may inspect it,
  and CLI-controlled subprocesses outside the shell environment policy need separate
  verification. Workspace configuration changes after the launch-time inspection are
  not a verified isolation boundary (PM-357). Manual testing must distinguish sandboxed
  shell commands from explicitly approved commands outside the sandbox; environment
  filtering alone does not establish host-process isolation.

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

### Message attachments (PM-516, PM-518, PM-520, PM-524)

Message files live in `PROJECTMAN_HOME/message-attachments/<projectKey>/<id>`, in 0700
directories with 0600 files, separate from task attachments. Before sending, only the uploader
can see a file. After sending, access follows `canSeeTeamMessage`: the sender, recipients and
project owners/admins can see it. Unknown, deleted or invisible files return `not_found`.
In an Operator guest conversation, `read_message_attachment` checks the guest's visibility.
An hourly sweep, also run at startup, deletes unsent uploads older than 24 hours.

The `attachments` paths of `send_message` use the same file reader as `attach_file`: only
regular files inside the recorded working directory or the calling process's own session
folder, with the same symlink, hard-link and unchanged-handle checks described above. The
server uploads them and binds them to the message when sending; a refused send removes the
unsent files, with the sweep as fallback.

`read_message_attachment` returns a bounded image or small UTF-8 text as MCP content. When
that cannot represent the file (for example a PDF or large text), or the provider cannot show
an MCP image, a session with its own folder receives an authorized copy at
`<session folder>/message-attachments/<id>-<sanitized name>`. The server identifies the session
from its MCP token and checks visibility again before obtaining the source. Its engine
materializes the file only in that session's recorded folder, checking size and SHA-256;
a remote engine receives it through a single-use download token. Guest Operator sessions have
no folder and receive content only. If materialization fails, the tool returns without a path.

The entire app-home `message-attachments` directory is in `sensitivePaths`: member file tools
and sandboxed shell commands cannot read the shared store directly and bypass message
visibility. Authorized copies in session folders remain readable. This is a sandbox policy
restriction, subject to the host-user trust boundary described in the threat model.

### Codex project configuration (PM-357)

Codex trusts the workspace and bypasses hook trust for projectman's own hooks. Its project
layer must therefore not introduce subprocesses or sandbox exemptions. Starts and resumes
allow only `.codex/config.toml` with model and project-document keys (the exact list is in
`runner/ambient-config.ts`). Every layer from the nearest `.git` ancestor to the canonical cwd is
checked, rejecting symlinked folders, symlinked/nonregular/multiply-linked files and every
other entry, including hooks, MCP servers, rules, agents and skills. The domain checks before
recording the session or creating its folder; the adapter checks again before building arguments.
Automatic starts wait with `workspace_codex_config`, retrying every 30 seconds. Errors and
deferral logs contain only file/key names.

Residual risks: the [0.159.1 release notes](https://github.com/openai/codex/releases/tag/rust-v0.159.1)
mention model-catalog changes, not configuration or hook reloads. This is not proof that reloads
cannot happen; the policy assumes startup loading and checks the next start/resume after a
running session changes files. A short check/load race remains, writable by a human or a leftover
process, as accepted in the plan. The owner's `project_root_markers`, home/system configuration
(PM-49, PM-214) and `.agents` skills/plugin marketplaces are outside this check. Legitimate
project `.codex` skills and rules also stop Codex members; expanding the allowlist needs another
card. NanoGPT retains its launch-time `any` refusal; its failed-row-per-retry behavior (PM-329)
is outside this change. On remote engines inspection must run beside the CLI, returning only
relative file/key names to the server.

## Operator actions and approvals (PM-464)

System signals (PM-476) permit one narrow write without an open owner request: the
Operator may use `send_message` with `signal_id`, addressed only to the owners, to
present this project's delivered, not yet presented `pending` or `open` signal once.
The server revalidates the signal and recipients transactionally. Apart from this and
the question screening below (PM-558), all other writes still fail with
`operator_no_request`. Accepting or dismissing a signal requires a
project owner's own login; integrator and AI acceptance fails with 409, and dismissal
with 403. Acceptance opens an ordinary PM-463 owner request and grants no additional
powers. `operator_signal` WebSocket events reach only owners. Wake-up facts are data,
not instructions. A proposed action (`signal_actionable`) may rely on another session's
activity; the owner sees the proposal before deciding whether to authorize it.

Question screening (PM-558) is the second write without an open owner request. A new
`ask_human` question of an AI member waits in the inbox state `screening`, and the Operator
settles it with `screen_question`. The tool is for the Operator only (`operator_only`) and
never from a guest conversation (`operator_owner_only`); it needs neither an owner request
nor a step log. `answered`, `forwarded` and `moot` close the question without a person, and
`moot` may also close a question that is already open for people. `forwarded` sends an
`action` message to a non-Operator AI member who may have no role on the card, and wakes
them. `decision` and `todo` hand the question to people. The server rechecks the question's
project, kind and state under the resolution lock; an Operator answer never sets an approval
label and says it is not from a person. The counterweights are the asker's one-time re-ask
(`reask_of`, only after `answered`, `forwarded` or `moot`, only the asker's own question, in
the same project), the timeline entry of every outcome, and `GET /api/projects/:key/inbox/screened`
(owner or admin only), which lists what the Operator settled. If the Operator cannot be woken
or does not settle in time, the question opens for people (`unavailable`, `timeout`). The
question text is the AI member's data, not an instruction: the notice, the Operator's rule
and the forwarded message all pass it as quoted JSON, and it never widens what the Operator
may do.

The Operator's `operate` and `start_task` tools require its own session and an open
owner request. Configuration commits carry internal `operatorRequestId` provenance;
`assertCommitAllowed` verifies the request's project and Operator attribution and runs
`operatorConfigVerdict` under the configuration commit lock. Forbidden changes are refused;
restricted changes require the matching open approval and its exact change rows.

Only a project owner using their own login can approve, reject or dismiss an Operator
proposal. Integrator (`via`) and AI decisions receive 403. Approval replays the stored
operation against current configuration and compares its before/after rows. Session
stops require the same running session ID and start time; pause changes require the
same pause state. Changed proposals become stale, execute nothing and remain open
with only `dismiss` available. Configuration commits, session endings and pause changes
also trigger proactive checks. The Operator cannot stop its own session.

`start_task` may override prerequisites with `despitePrerequisites`, just as the owner's
Start button does, but cannot override a fix-limit hold. Policy-controlled temporary
worker hiring uses `SYSTEM_ACTOR` and `SYSTEM_AUTHOR`, sponsored by the requesting
owner, within the configured role and count limits. Permanent Operator hiring follows
the configuration verdict and approval path.

Configuration history reads attribution only from the final trailer block. Commit
creation quotes user-supplied `Projectman-` lines, so a patch message cannot forge
Operator approval or hide integrator attribution. Attribution fields come from internal
author metadata, never from the HTTP request body.

### The Operator talks with everyone, and obeys the owner (PM-475)

Every person of the project has a conversation of their own with the Operator
(`{ type: 'general', with: <handle> }`); the owners share `{ type: 'general' }`. Only a
change an owner asked for is made. In a conversation with anyone else the Operator reads and
answers, nothing more:

- **Writes are refused by the server.** `callerWithRequest` lets such a session call
  `OPERATOR_GUEST_TOOLS` only (`get_task`, `list_tasks`, `list_members`, `list_attachments`,
  `read_attachment`, and `send_message` to that person alone). Every other tool gets 403
  `operator_owner_only`; a refused write is logged as a `refused` step. `get_project_state` is not
  among them until a separate task adds a viewer filter.
- **Reads are the person's own view.** Cards, details, timeline excerpts and attachments go through
  `canSeeTask` / `visibleTaskDetail` / `humanActor`, so a client sees only what is shared with them.
- **No other way to data.** The session starts with the team tools alone (`SessionPolicy.teamToolsOnly`).
  The Claude Code adapter then renders: `--tools ToolSearch` (the one built-in tool that reaches the
  deferred team tools), the deny rules `Bash`, `Read`, `Edit`, `Write`, `WebFetch`, `WebSearch` and `Agent`,
  the allow rule `mcp__team__*` and nothing else (no session-folder rule, no read-only path, no command),
  no `--add-dir`, and the sandbox (kept as a second wall) with `autoAllowBashIfSandboxed: false`. The
  working directory is an empty directory of its own (`guestSessionDir`), the permission mode is `default`,
  so it neither reads the workspace, the worktrees, the attachments, the git history or the owner's
  transcripts, nor shares a transcript with the owners' conversation. A permission request from it is
  refused at once and never reaches the owner's inbox. It has no memory section, and an AI member's
  message does not wake it. The other CLIs (Codex, Gemini, NanoGPT) cannot be limited this way, so a
  guest conversation with an Operator on one of them is refused (`provider_unsupported`); the owners'
  conversation is unaffected. `apps/server/test/operator-guests.test.ts` and `claude/args.test.ts` pin
  the rendered settings and arguments.
- **Who sees the sessions.** The Operator's sessions (REST, the websocket, the terminal, the member
  profile) are visible to owners and admins only (`canSeeOperatorSessions`). Raw terminal input into
  the Operator's session is the owner's alone: an admin may watch, not type.
- One guest conversation runs at a time and closes after five idle minutes; the owners' one is
  outside that capacity.

## Automatic command decisions

### Merge-fix worktrees (PM-471)

The nominated merger can receive a writable `merge-fix/<KEY>` worktree without a
file-changing duty (`files: []` and `DEVELOPMENT_SHELL_TOOLS`). This exception applies
only while the card's merge is `fixing`, on the card's engine, in `task_worktree` mode.
The placement and current member must match the recorded fixer and branch.

`git merge <fix.base>` is automatically allowed only with the exact recorded commit
SHA. For Codex, this executes outside its sandbox like the other routine developer
steps, with the server user's rights and the repository's hooks and configuration.

The owner decided that mechanical conflict fixes may enter the default branch without
a separate code review of the fix commit. The resolution note and ancestry checks
record the explanation and require the approved commit and conflict base to be present;
they do not restrict the contents of the fix commit. Behavioral conflicts must be sent
back to the developer with a reason.

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
still trusts repository executable configuration and hooks. The whole shared git directory must
not be restored as a writable root to work around denied git operations: PM-399/PM-411 grant only
the narrow set of the paragraph on the Codex profile (objects, refs, logs, packed-refs.lock, and the worktree's own
admin directory, with the configuration, hooks and links read-only). Other narrow trusted git
operations need their own validation; blanket hook disabling alone would leave other executable
git settings to review.

When the server auto-allows a Codex escalation (the routine git steps of a developer, lockfile
installs), that command runs outside Codex's sandbox with the server user's rights, including
the repository's git hooks and npm lifecycle scripts. The same holds for the read-only rule's
check commands (`npm test`, `npm run typecheck`, `npx vitest run`, `npx tsc --noEmit`): when a
Codex member's run escalates, for example because its tests listen on localhost, and the rule
allows it, it runs the project's own scripts outside the sandbox. Even a read-only `git` command
runs the programs the repository's configuration names (`core.fsmonitor`, diff and text
conversion drivers). The historical shared-git root grant allowed config writes; removing
that grant does not make host execution a sandboxed operation. The allowed
forms are narrow, and a command the strict parser in `runtime/permissions` (`shell-words`) does not fully
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
  `~/.codex`, `~/.gemini`, `~/.npmrc`, `~/.aws`, `~/.cloudflared` (the owner's AWS and Cloudflare
  logins, PM-533); the rest of `~/.claude` stays open: saved tool outputs and
  the plan mode's plan file are there) and the sensitive parts of the app home (database, cookie
  secret, logs, customization repository, members' memory, publishing identity, spool, `secrets`,
  `providers`); `WebFetch` may not reach
  `localhost` or `127.0.0.1`. The lists are `sensitivePaths` in `contracts/sandbox.ts` and `HARD_DENIED_HOSTS` in
  `runtime/sessions` (`session-policy`).
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
is not opened. Read-only Codex sessions get none. Playwright's browsers directory is read-only for every sandbox
(`PLAYWRIGHT_BROWSERS_PATH`); it is left out when it is the user's home or the app home or above.

**A Claude developer reads only its own work (PM-153).** A developer's sandbox reads nothing below the
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
that port stays reachable (PM-156). A reader's sandbox reaches the npm registry. A
Codex member uses its own permission profile: it denies `sensitivePaths`
and its Codex home, but reads other paths broadly (PM-356; the wider boundary is PM-360).
A developer's file tools have no such `Edit` deny rules outside its
worktree (its own worktree is inside the app home, and a deny rule wins over an allow rule): there
the CLI's own questions and Auto's classifier hold. The sandbox's denials were checked on the
owner's machine in the PM-167 manual run; its result and what is still to run (PM-153) are in
PROVIDERS.md.

The official Codex standalone installation beneath a denied home is reopened read-only
so the CLI can re-execute its binary (PM-356). The runner resolves the executable on the
session PATH, then grants only its `packages/standalone` ancestor, never the whole
`packages` or home. A root containing a denied path gets no exception. Unknown installations
inside denied directories remain blocked; install outside them or use the official standalone
layout. A Codex member in a task worktree writes a narrow part of the shared Git directory
(PM-399, PM-411): `git add` and `git commit` write the worktree's index and the objects and refs, and
without a grant they failed with EPERM in v2026.10.7 (the PM-356 profile had no write root for
them). Writable: the shared `objects`, `refs` and `logs`, only `packed-refs.lock`, and the worktree's own admin
directory (`worktrees/<name>`, `WorktreeInfo.worktreeGitDir`). Not writable: the rest of the
shared directory, including **every other worktree's admin directory**, and, inside the
writable ones, `config`, `config.lock`, `hooks`, `objects/info` (alternates), the own admin
directory's `commondir`, `gitdir`, `config.worktree` and `hooks`, and the integrating
checkout's files of `sharedGitDenials` (the default branch, `HEAD`, `index`,
`refs/replace`, `info/grafts`, with their lock files), and `packed-refs` itself. The reason is the host's git, which reads
these outside the sandbox: a rewritten `commondir` (pointing into the worktree) or `config`
(`core.fsmonitor`) would run a program there (PM-131). It is given only in a writing sandbox,
only for a task worktree that has both directories, and not when they lie in a denied path. A
member workspace is an independent clone, whose `.git` is inside the workspace. The residual
risk: refs of other tasks' branches and the object store are writable (as for a Claude
developer, below). PM-411 lifts only the `packed-refs.lock` denial in the Codex profile for
rebase pseudo-ref deletion and loose branch deletion; Claude's shared denials remain in place.
The profile marks `packed-refs` read-only, including packed replacement refs and the packed
default branch. Deleting a packed branch can require rewriting `packed-refs` and is not granted
by this lock-only exception. Two residual risks remain: a leftover lock blocks the host's ref
deletions until removed, and a session can replace the writable lock while the host rewrites
`packed-refs` (gc/pack-refs or packed-ref deletion), injecting content into that host rewrite.
On 2026-10-08, the owner explicitly accepted these two risks on PM-411, conditional on a
follow-up card ("Elfogadom, utókártyával"). PM-413 tracks their mitigation.
Existing sessions need a restart with the updated runner to receive the new profile.
The live Codex probe must use a task worktree's actual shared git directory outside the
worktree, in a session started by the updated runner: a disposable repository inside an
already writable workspace does not exercise this specific file-path grant. The owner chose
release followed immediately by this probe (PM-411, 2026-10-08). Record the `packed-refs`
checksum before and after rebase/continue, loose branch deletion and the hard-link probe.
Creating a hard link from the read-only `packed-refs` to the writable `packed-refs.lock` must
fail with EPERM. If the link is created, do not open or write through it, even for a zero-byte
write. Immediately remove `packed-refs.lock`, verify the `packed-refs` checksum is unchanged,
and record the failure on the task and notify security and the architect. The security approval
is withdrawn, and the released grant must be revoked by reverting the PM-411 merge in a corrective
release, then restarting the Codex sessions, according to the architect's rollback plan.
The actual `packed-refs` must remain
unchanged. A later link-count check cannot detect a link removed after a malicious write.
The native sandbox's link rejection remains unverified on macOS and Linux. This possibility is not covered
by the owner's acceptance of the two lock risks above.
The profile semantics (a nested `read` under a `write` root) must be checked
in that live Codex session. macOS MDM-managed Codex preferences (`com.openai.codex`) are not inspected by the startup
checks; administrator-managed configuration through that channel remains a follow-up (PM-375).

**Residual risk (PM-355, outbound network, accepted by the owner).** The member's "Outbound
network" setting is on by default for every AI member (decision 41). With it on, a member's
commands can reach any address except the blocked hosts (the live instance's own addresses), so a
command can send the contents of the working copy, including what the member could read, to a
server outside. The owner judged the risk no greater than using Claude Desktop. The protections
that do not depend on the network stay: the secrets and denied paths cannot be read, the billing
and secret variables are removed from the environment, `git push`, `gh pr create` and
`gh pr merge` are refused, and the blocked hosts stay closed. The blocked hosts are only the
live instance's own addresses (`localhost`, `127.0.0.1`): with the network on, the other devices
of the local network (the router, a printer, a NAS, other machines of the tailnet) are reachable
through the proxy as well. With the setting off, only the npm registry is reachable.

**Residual risk (PM-153, accepted until per-member workstations).** The shared git
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
workstations; a per-member workstation has its own clone and nothing shared. What the host's own git does in a developer's worktree (its
`.git` file, which the developer can rewrite) stays the host-git risk of PM-126/PM-131
(PROVIDERS.md); PM-193 closed the npm cache and the development data, not that.

`~/.claude` is not denied as a whole, because the members run with the user's own `~/.claude`
(the runner sets no `CLAUDE_CONFIG_DIR`) and Claude Code saves large tool outputs under
`projects/<cwd>/<session>/tool-results/` and the plan mode's plan under `plans/`; a deny rule wins
over an allow rule, so no exception could be made. The consequence is a residual risk: the
conversation transcripts of other sessions under `~/.claude/projects/` can be read by a member's
file tools. Only the login and settings files are denied (`.credentials.json`, `settings.json`,
`settings.local.json`, `hooks`). A separate configuration directory per member would close it.

**Claude Code's shared temporary root (PM-353).** Claude Code keeps its scratchpad, the output of
background commands and subagents, and `bash-edit-diff` under `<TMPDIR>/claude-<uid>`
(`/tmp/claude-<uid>`, also `/tmp/claude`), one folder for every Claude Code process of the user, and
the sandbox of its commands has always allowed writing it. So a member's commands could read the
command outputs of other sessions and other projects, and the server's full-test sandbox read them too.
Now every legacy Claude session has its own root: the server makes a 0700 directory `<tmp root>/<12 hex>`
(PM-339 folders) and the adapter starts the CLI with `CLAUDE_CODE_TMPDIR` set to it. The shared roots
(`sharedClaudeTmpRoots`, also the server's own `CLAUDE_CODE_TMPDIR`) are denied for reading and
writing in a developer's and a reader's sandbox, to the file tools (`deniedPaths`), to Codex
and in the full-test sandbox; the session tmp root's parent is unreadable to Claude sessions and to
the full test, and only the session's own directory is re-opened. The directory is removed when the
process ends, so a background command's output does not survive a restart.

Remaining risks: a Claude session without a safe tmp root (folders or tmp off, an unusable root) keeps
the shared root and does not get it denied (fail-open: the CLI would otherwise fall back to a
path it cannot use); a session that is already running gets the rule at its next start; a
reader's file tools still read the user's home and the other PM-339 folders (PM-425); Codex on the
PM-339 base still reads what its profile opens (PM-360); NanoGPT members (PM-365) and Gemini (no OS
sandbox) are not covered by the sandbox rules.

## The feedback tool's public API (PM-506, PM-509)

The tool is a script (`/feedback/widget.js`) that runs on a customer's page and calls
`/feedback/api/v1` across origins. It is the one surface of the server that a page of another
site may call, so it has its own guard instead of the `/api` one (cookies and CSRF origin checks
do not apply: nothing here uses a cookie).

- **Entry.** The app gives a person a single-use launch code (two minutes, 256 bits, kept as a
  SHA-256 hash, bound to the person, the project and the surface). The page swaps it for a session
  with `POST /sessions`. A code is used up by the first attempt that names it, also when the
  `Origin` is wrong. Every refusal is the same `401 feedback_code_invalid`, so nothing tells a
  guess from an expired or foreign code. Wrong attempts are counted per client address (10 in 15
  minutes, then `429`; the address comes from `PROJECTMAN_CLIENT_IP_HEADER`, as for the login).
- **The session token** is 256 random bits, returned once, stored only as a hash. The widget keeps
  it in the page's `localStorage` and sends it as `Authorization: Bearer`.
- **Risk: XSS on the customer's site.** Script on the page (the site's own or an injected one) can
  read that token and act as the person until it ends. The token is therefore narrow: one person,
  one project, one surface (one site address), only marking and reading. It cannot reach
  anything a person sees in the app: the widget API leaves out a mark's environment, its
  screenshot, the reason of a forward and `canProcess` (always false), and shows only the marks
  of the session's own surface. Internal cards stay hidden as in the app (`visible: false`).
- **Origin.** Every request (also a refused one) needs an `Origin` that is the address of some
  project's surface, else `403 feedback_origin_not_allowed` with no CORS header. A session works
  only from the address it was made for. `Access-Control-Allow-Credentials` is never sent;
  answers are `no-store` and vary on `Origin`. The check and the session check run in an
  `onRequest` hook, before the body is read, so an unauthorised request cannot make the server
  take a 3 MiB body.
- **Revocation.** The session is checked on every request, not trusted from its issue: it ends at
  once when the person signs it out (`DELETE /sessions/current`), an owner or admin signs the
  person out of the tool (`Kiléptetem`) or switches the person's "may mark" off, the person is
  removed or becomes a viewer, or the surface is changed or deleted. It expires after 30 days
  without use and 90 days in any case. Every failure is `401 feedback_session_invalid`. These
  endings are for good: every change of the project's configuration revokes the sessions whose
  person may no longer mark or whose surface is gone or has another address (and the first request
  after a missed change does too), so a handle that is given to someone else later, or a switch that
  is turned on again, does not bring an old token back; the person needs a new code. A configuration
  that cannot be read only refuses that request.
- **Limits.** Per session and hour: 30 marks, 120 comments (in memory, so a server restart
  resets them); per project and day: 500 marks (counted from the database). Over a limit: `429`
  with `Retry-After`. Request bodies: 3 MiB for a mark (screenshot), 64 KiB for everything else.
  A screenshot is checked by its content (a real PNG or JPEG of bounded size), not by its label.
- **Remaining risks.** A stolen token works until it ends (up to 30 days idle) from the same site
  address; there is no per-device binding. A page can send an `Origin` only from a browser, so a
  script off the browser (curl) with a stolen token can send any `Origin` it likes: the token,
  not the `Origin`, is the credential there. The in-memory hourly limits are per server process.

## Files the server puts into a session folder (PM-518, PM-523)

`SessionFolders.materializeFile` (`engine-host/session-folders.ts`; the local and every remote
engine run it) copies a message attachment into the session's own folder, as the server's user,
outside the agent's sandbox. The agent writes inside its folder, so the folder's contents are
hostile input. The boundary:

- The target is `<folder>/<name>`, directly in the folder the registry recorded for the session. There
  is no subdirectory: a directory inside the folder could be renamed away and replaced by a link
  between the server's check and its use, and the server would then write and remove through the link
  (PM-523: a `LaunchAgents` plist or any file the sandbox forbids, and any file deleted).
- The folder itself is made in the folders root, which no sandbox writes, so the agent cannot rename
  or replace it. It is checked once (a real directory of the server's user) and its path is never
  re-resolved from a name the agent controls, other than the last element.
- The last element is safe by itself: `link` fails for an existing name and never follows a link. A
  name that is not the same file is renamed into the root as a `.trash-*` entry and removed there, so
  a link or a directory the agent keeps changing is moved as itself, never walked in its place. No
  recursive removal runs on a path in the agent's folder. The "same file" check opens the name with
  `O_NOFOLLOW|O_NONBLOCK`, takes `fstat` of that descriptor (a regular file of the expected size) and
  reads at most `size + 1` bytes through it, so a FIFO, a link to a device or a file that keeps
  growing cannot stop or stretch the server's read.
- The content is staged in the root, checked against the size and checksum, and hard-linked in, so
  the agent never sees a half-written file and the file is made exclusively (0600).
- What this does not cover: the agent can delete or replace the file after the call, and it can
  fill the folder; both stay inside its own folder.

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
allow rules. The shared git directory is not granted as a writable root as a whole (PM-131);
only the narrow set for `git commit`, rebase and branch updates/deletion is (PM-399, PM-411,
Codex profile).

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
the server's checkouts there: they run as the same user the sessions already are. Workspaces are reserved for one
session's process group at a time, so no session can switch the branch under another.

The model and fake CLI regression tests prove rendering and compatibility only. PM-126's
corrected manual macOS subscription probe and the PM-130 adversarial matrix must establish
the real filesystem/network boundary, hook/lifecycle confinement and publishing protection.
The accepted local-port exception is recorded in decision 24; Linux is not certified by the
macOS probe.

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

7. The marking widget has its own hostname on the same tunnel, outside Access (PM-513, next
   subsection).

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

### The widget's public hostname (PM-506, PM-513)

The marking widget runs on a customer's page, so it cannot pass Access. It gets **a hostname of
its own on the same tunnel with no Access application** (setup: [DEPLOY.md](DEPLOY.md) step 7).
The Access application of the application's hostname is not weakened and no Bypass policy is
added. What is reachable without Access is exactly `/feedback/widget.js` and `/feedback/api/v1/*`;
their session, origin and limit rules are in "The feedback tool's public API".

1. **The tunnel passes only `^/feedback/`** on that hostname, and answers 404 to the rest of it
   (`deploy/cloudflare/config.example.yml`). Like the application's rules it has no
   `httpHostHeader`.
2. **The server's host guard is the second lock** (`src/http/feedback-host-guard.ts`, registered
   as the first `onRequest` hook, before the auth hook). It is on when
   `PROJECTMAN_FEEDBACK_PUBLIC_URL` is set to a non-loopback address. For a request whose `Host`
   (lower-case, with its port, without a trailing dot) is that address, anything outside the
   list gets the same 404 an unknown server route gets, so a wrong or missing tunnel rule does
   not expose `/api`, `/ws`, `/hooks`, `/mcp` or the web app there. A websocket upgrade is
   refused and its socket closed.
3. **The list is strict and read from the raw request target**, the text before the `?`, with no
   decoding and no normalization: exactly `/feedback/widget.js`, or `/feedback/api/v1/` followed by
   segments of `[A-Za-z0-9_-]` separated by single `/`. `..`, `.`, `%`-encoding, `\`, `//`, a
   trailing `/` and other letter case are all outside it. The reason is that Cloudflare's
   `^/feedback/` rule passes `/feedback/../api/setup` on, and a router may read such a path
   differently from the way the proxy did. `app.inject` normalizes URLs, so the tests write the
   raw request to a socket.
4. **A wrong `PROJECTMAN_FEEDBACK_PUBLIC_URL` stops the server at start**: `https` is required
   (`http` only on a loopback host), and no user name, path, query or `#`.
5. The guard keys on the `Host` header, so it guards the tunnel's traffic, not local callers: a
   process on the machine can send any `Host` to the loopback port, and it is already the machine's
   own user. Requests for the application's hostname are not changed by the guard.

**Residual risks.** The guard protects the public hostname, not the application's hostname: if the
tunnel's rules for the application's hostname were lost, Access would still be the lock there, as
before. The widget's token on the customer's page is the risk described in "The feedback tool's
public API" (XSS on that site). Cloudflare sees this traffic in clear like the rest.
