# projectman — architecture

projectman is a browser app that runs and tracks a team made of humans and AI members.
AI members are real, interactive agent CLI sessions (Claude Code or OpenAI Codex) running
on a human sponsor's subscription. The team works through a configurable pipeline of stages
(for example development → code review → QA → client test → merge → release). Every step is
attributed, and everything that waits for a human lands in one inbox ("Rád vár"). It runs on
the owner's machine, reachable from a phone through Tailscale; [DEPLOY.md](DEPLOY.md) covers
running it on a server.

Documentation map:

| Document                                                                   | What it answers                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| this file                                                                  | concepts, invariants, runtime structure, module map, storage        |
| [DECISIONS.md](DECISIONS.md)                                               | what the owner decided and why (numbered, append-only)              |
| [ROADMAP.md](ROADMAP.md)                                                   | what is built, what comes next, open questions for the owner        |
| [PROVIDERS.md](PROVIDERS.md)                                               | Claude Code and Codex: flags, hooks, permissions, login, plan usage |
| [design/labels.md](design/labels.md), [design/duties.md](design/duties.md) | labels and gates; roles as duty bundles (reference, built)          |
| [design/phase2.md](design/phase2.md)                                       | the phase 2 proposal (meetings, retro loop, "Rendszer", notices)    |
| [GITHUB.md](GITHUB.md), [SECURITY.md](SECURITY.md), [DEPLOY.md](DEPLOY.md) | GitHub integration; threat model and protections; server deployment |
| [VM.md](VM.md)                                                             | the managed VM profile: build, readiness report, trial, restore     |

## Hard constraints

1. **Subscription, never API billing** (decisions 1, 15). Agents run as interactive TUIs in
   a pseudo-terminal, logged in with the sponsor's Claude or ChatGPT plan. No Agent SDK,
   `claude -p`, `codex exec` or app server for member work. The runner strips API keys and
   endpoint overrides from every session, and refuses to start a CLI that is not logged in
   with a subscription. The app never collects or stores agent credentials.
2. **English source code** (decision 10). Identifiers, comments, file names, commit
   messages, prompts for AI members: English. The Hungarian UI lives only in locale files
   (`apps/web/src/i18n/hu.ts`, `packages/templates/src/locales/hu.ts`). Data written by
   people and agents (task titles, notes, messages, label names) is in the project's language.
3. **No real agent or `gh` CLI in automated tests.** Tests use fakes that speak the same
   protocol: `apps/server/test/fixtures/fake-claude.mjs`, `fake-codex.mjs`, and
   `apps/server/src/github/test-fixtures/fake-gh.mjs`.

## Concepts

- **Project** — a workspace directory with one or more git repos (`repos[]`, each optionally
  on GitHub), a team, a pipeline with labels, and limits. Its configuration is YAML in the
  customization repository; its runtime state is in SQLite.
- **Member** — human or AI, identified by a unique **handle** (`fe-1`, `qa`, `owner`) and a
  display name. Humans have an **access level** (`owner`, `admin`, `developer`, `client`,
  `viewer`) that governs what they may do in the app, and may hold several roles. An AI
  member holds exactly one role and has a provider (`claude` or `codex`), a model and effort,
  an optional **cheap subagent** (PM-179: a Claude Code member's sessions get a `reader-<model>`
  subagent on Sonnet or Haiku, passed with `--agents`, for text-heavy, logic-light work; it has
  no rights of its own), a permission mode, a capacity, optional instructions, an optional **schedule** (cron in the
  project's time zone, e.g. a daily worker) and a **sponsor**: the human whose subscription
  runs it. Colleagues can be added as unclaimed seats and invited with single-use links.
  An AI member can be sent **on leave** (decision 23, the optional `onLeave` flag of its
  configuration; `isOnLeave` in `packages/shared`): nothing starts a session for it, its running
  sessions stop (their conversations stay, so a call-back resumes them), it is not picked or named
  as an assignee, a stage hand-over goes to another owner, and the messages for it wait.
- **Duties and roles** (decision 16, [design/duties.md](design/duties.md)) — a fixed,
  code-backed catalogue of 27 duties (implementation, code review, testing and acceptance,
  release approval, …) defines who may hold them, the English prompt fragment an AI holder
  receives and its tool policy. A **role** is a named bundle of duties: 21 built-in roles with
  default bundles (`team.roleOverrides` replaces one) and custom roles defined in `team.yaml`.
  Release approval and final decision are human-only.
- **External operation requests** — a protected adapter supplies exact, credential-free target
  metadata for an opaque operation id. The server derives owner exceptions and routes other
  requests to independent holders of `boundary_authorization` (the `lead_developer` bundle),
  when the owner enables delegation. A persisted lead deadline escalates to owners, never
  automatically allows; requests/grants and attributed audit survive restart. CLI permission
  hooks and human gate/release decisions stay separate. See [BOUNDARY.md](BOUNDARY.md) for the
  contracts, adapter integration and single-operation grant consumption.
- **Pipeline** — ordered **stages** grouped into **board columns**. A stage has a kind:
  `queue` (waiting to start), `work` (the assignee builds it), `step` (the owners do one thing
  — review, deploy, test, client test, merge — as the stage's duty says, and record the result
  with a label), `release` (always behind a human approval) or `done` (decision 18). A stage's
  owners are the holders of its duty unless it lists members explicitly. A **gate** is a list
  of label conditions (`has_label`, `lacks_label`) that must hold before a task may enter the
  stage.
- **Labels** (decision 17, [design/labels.md](design/labels.md)) — the one way to state facts
  about a task. The pipeline defines each label once: name, colour, meaning (given to AI
  members), group (mutually exclusive states), who may set it, no self-review, comment
  required, notify the assignee, cleared when the task moves back or its PR gets new commits,
  and blocking. A missing label only humans may set is an **approval**: the move opens an
  inbox decision, and approving puts the label on. `pr-merged` is a system label kept by the
  GitHub integration. Labels without a definition are plain tags.
- **Task** — key (`AR-21`), title, markdown description, stage, status, assignee (the work
  stage owner), repo, labels, links (PRs with their attributed authors, branches, issues,
  prerequisites), visibility (`internal` or `shared` with clients), optional parent (one level
  of subtasks), comments with @mentions and **attachments**. Tasks can be imported with their original dates.
  **Relations between cards** (PM-192/PM-202): part of (`parentKey`), prerequisite, related and
  duplicate of. The last three are `task_links` rows (`prerequisite`, `related`, `duplicate_of`;
  `ref` is the other card's key) stored once on the card that set them; the other direction is read
  (`task_links_ref` index), never stored. `packages/shared/src/domain/relations.ts` is the one place
  for the view (`taskRelations`), the rules (`relationRefusal`: itself, missing, other project, loops,
  duplicate chains; `duplicateMarkRefusal`: who may mark a duplicate) and the planning of a change
  (`planRelations`, shared with the web's fake backend). `UpdateTaskRequest.relations` /
  `CreateTaskRequest.relations` change them all or nothing with the rest of the call; both cards'
  timelines get `task_relation_added/removed`. A card marked a duplicate is cancelled (cards that have
  not started: anyone who can edit; started ones: admin or owner only).
  A task works in one repository: its own `repo`, else the project's only one when it has
  exactly one (`effectiveRepo`, the one rule in `packages/shared` that placement, the command
  policy, the context pack and the web read). The repo can be set later (task drawer, REST
  `PATCH`, `update_task`), but not while a session of the task runs.
- **Attachment** — a file (at most `MAX_ATTACHMENT_BYTES`, 25 MB) attached to a task, kept in
  `PROJECTMAN_HOME/attachments` and reached only through the protected REST routes
  (`routes.taskAttachments` and its `content`/`download` children, a multipart upload of one
  file per request, never buffered whole); there is no public static route. Who may read, upload
  and delete is one rule in `packages/shared` (`canReadAttachments`, `canUploadAttachment`,
  `canDeleteAttachment`, with `canSeeTask` underneath): project membership always; a client only
  on a shared task; a viewer only reads; AI members and the other workers upload; the uploader or
  a human owner or admin deletes. The attachments service (`domain/attachments`, the contract in
  `contracts/attachments.ts`) takes a stream, so REST and the team tools share one size,
  storage and access check, and judges the member against the current roster and the task's
  current visibility again just before an upload is published. The media type is proven from the
  file's content (PNG, JPEG, GIF, WebP and PDF may be shown inline; HTML, SVG, a renamed or an
  unknown file is always an `application/octet-stream` download); every response is `nosniff`,
  sandboxed by CSP and has a safely encoded `Content-Disposition`; the uploaded name is
  sanitised metadata and never a path. The file system and SQLite share no transaction, so a row
  has a durable state: `pending` (being written), `ready` (the only readable one) and `deleting`
  (the recorded intent to delete, with who asked). A deletion removes the file first and then
  the row and the audit event together, a failure leaves it `deleting` (not readable, finished by
  the next try or the next start), and the start of the server finishes what a stop left half
  done. `attachment_added` and `attachment_deleted` stay in the task's timeline with the file
  name; the websocket event `task_attachments_changed` carries only the task key and reaches a
  client only while the task is shared with them. Cancelling a task keeps its attachments, and
  no task is ever hard-deleted (deleting one for good would have to remove its files too).
- **Work item and session** — every AI member works in a **fresh session per work item**:
  member × task, member × meeting or member × general chat (decision 5). A task session lives
  through the whole pipeline; later messages about the task resume it. Persistent identity
  and durable memory carry over between sessions. A task session of a role that changes files
  runs in a git worktree of the task's repository and never in the workspace root; with several
  repositories and none chosen it does not start (`repo_required`). Roles that only read run in
  the workspace root. A conversation belongs to the directory it ran in: when the task's
  worktree is elsewhere (its repo changed since), the session starts a new conversation there.
- **Member workspace** (PM-138, server option `memberWorkspaces`, `PROJECTMAN_WORKSPACES=member`;
  off by default until the switch-over, PM-143) — in place of a worktree per task, every AI member
  gets one durable workspace per repository, `workspaces/<KEY>/<handle>/<repo>/`: an independent
  clone (`--no-local`: its own `.git`, no shared objects, alternates or worktree link, no remote)
  with its own `cache/` and `tmp/`. A role that changes files works there on the task's branch: a
  new task gets its own branch from the freshly fetched default branch (a failed fetch refuses the
  start, `workspace_fetch_failed`), a continued task keeps its branch as it was (never reset or
  rebased), a task taken over from a teammate fetches their committed branch. A reviewer or tester
  (code review, security review, testing duties) works on a pinned commit of the handed-over branch
  and a review base pinned with it (`review_copy` placement), per round: a round starts when the
  task enters a stage or its assignee writes to the reviewer (the owner's answer on PM-138), and a
  resume continues the same round; a reviewer in a turn when its round ends gets the waiting
  messages after it idles and restarts on the new commit. The handed-over work is the assignee's
  workspace branch (another developer's later copy may be stale), else the last other one. Only committed work travels; the server fetches by explicit
  path. A workspace serves one task session at a time, for the life of its process group, idle or
  not (the reservation in `member_workspaces`): every start (admission, a person's resume, a
  message wake-up) checks it, a session of another task gives way only when it idles on a task it
  no longer works on (it is stopped; its conversation stays), and otherwise the start waits
  (`workspace_busy`). A branch switch needs a clean workspace with no unfinished git operation
  (`workspace_dirty`); nothing is stashed, reset, cleaned or removed, and done or cancelled tasks
  leave the workspace, its branches and dependencies in place. A conversation of an older
  generation of the workspace (made again or moved) is not resumed. Memory stays per project and
  member (`memory/<KEY>/<handle>.md`).
- **Context pack** — built when a session starts: the project's own `CLAUDE.md`/`AGENTS.md`
  (read by the CLI from the working directory), the member's identity, duty fragments and
  instructions, the team roster, the project's labels, how to use the team tools, the rules
  of the current stage, for tasks the shell commands the server runs without asking (generated
  from the command rules in `domain/`, `unattended-commands.ts`, so that a member writes them in
  a form that passes), the member's memory, and for tasks a kick-off brief (title,
  description, links, relations to other cards, attachments, recent timeline) sent as the first message.
- **Team tools** — an MCP server (`/mcp/:token`) through which AI members message teammates,
  read and update tasks (labels, notes, stage moves, subtasks), create tasks, link PRs, ask
  humans, save memories and work with attachments (list, read by local path, attach a file of
  their own working directory, delete their own; PM-113, see [SECURITY.md](SECURITY.md)), and
  in the managed VM publish their own task branch (`publish_task_branch`) and read the remote
  (`get_remote_state`; PM-142, [GITHUB.md](GITHUB.md)). Text
  an agent writes in its own session reaches nobody.
- **Team messages** — a message about a task goes to the recipient's session for that task
  (typed in when idle, queued otherwise; a stopped session is started or resumed through
  admission); messages to humans go to the web app. A message never goes to its sender.
  Injected messages carry the prefix `[team message from <handle> about <KEY>]` so
  transcripts can be parsed. Where an AI recipient gets it is decided when it is sent
  (`Messaging.place`, PM-182): its running session on the card; else on an open card its running
  session on an open family card (parent of a subtask, subtasks of a parent; siblings do not
  count; the most recently active wins; not for an owner of the card's current stage); a closed
  card's message goes to its general chat. The receipt keeps that `route` when it is not the
  default (`messageRoute` in `packages/shared`), so the message is found there while it waits;
  the prefix always names the message's own card.
- **Admission** — every automatic session start (task start, stage hand-over, message
  wake-up, schedule run) passes the same checks, in this order: the project's AI master
  switch (`team.limits.aiEnabled`), that the member is not on leave (`member_on_leave`), for a
  task that a role which changes files has a repository
  to work in (`repo_required`), with member workspaces that no other task's session holds the
  member's workspace for that repository (`workspace_busy`; `workspace_dirty` and
  `workspace_fetch_failed` from the start itself wait the same way), for a schedule run that the member's previous run ended, the
  member's capacity (what it works on now, decision 19: the open tasks it has a running
  session for that are mid-turn or waiting for an answer, or sit in a stage it works in, plus
  its other running chats; a session idling after the task moved on, a finished session and a
  bare assignment do not count; a temp worker also keeps one open assigned task at a time),
  `maxConcurrentAi` (optional: without it there is no project-wide cap, decision 23, and only
  the members' capacities and the plan usage limit the work), and the provider's plan usage
  against `pauseAbovePlanUsagePercent`. A refused hand-over or message wake-up is retried every 30 s
  while it is still valid; the task shows why it waits. Such a deferred start is kept in
  SQLite (`deferred_starts`) as well as in memory: the server loads the table back when it
  starts and retries what it finds, under admission as usual (decision 19); nothing is inferred
  from the state of tasks, so imported or idle tasks start nothing. While the master switch is
  off, no AI session starts or resumes and schedule runs are skipped; running sessions keep
  running, the retry timer leaves the starts that wait for the switch alone, and they continue
  once it is back on (or at startup with it on). Starts that wait for a member on leave are left
  alone the same way, and are retried the moment the member is called back; a person writing into
  the stopped session of a member on leave is refused (`member_on_leave`). When every eligible holder is busy, an
  optional **temp worker** of the configured role is hired for one task and retired when it
  is done. `repo_required` is the one refusal that is not retried, because only a person's
  choice clears it: the start fails and nothing is kept; the board shows the task of an AI
  developer that cannot start for that reason ("Válassz repót a feladathoz", derived from the
  task, see `TaskStore`).
- **Stage hand-over** — when a task enters a later stage owned by AI members, by anyone's
  move, the least loaded free owner (never the task's assignee) gets a session for the task.
  An owner that already has a session for the task gets a notice instead.
- **Inbox ("Rád vár")** — everything waiting for a human: tool permission requests (the
  agent's PermissionRequest hook, answered from the browser), approval decisions for gates,
  and questions from AI members (`ask_human`). The answer to a question returns to the asking
  session as a team message. A question is written for a non-specialist owner: one plain
  sentence that names the decision, each option described by what happens if it is picked, a
  recommended option with a one-sentence reason (marked "Javasolt") and the technical
  background folded away ("Részletek").
- **Timeline** — append-only, attributed events per task and project ("who did what").
- **Customization repository** (decision 8) — project configuration (project, team, roles,
  pipeline, labels, limits) is YAML in a separate git repository. Every change is a commit
  with author and reason; admins can revert to any version. Older configuration shapes are
  migrated on load (`apps/server/src/config`).

## Invariants

Enforced on every configuration change, whoever makes it
(`packages/shared/src/config/invariants.ts`; the changes only an owner may make are in
`packages/shared/src/config/owner-only.ts`):

- handles are unique; at least one human owner exists; AI sponsors are humans;
- repository names, board column ids, stage ids and label ids are unique;
- stage owners and members named by labels refer to existing members; every role a member
  holds exists and suits the kind of member; custom role ids are unique and never reuse a
  built-in id; a role cannot be removed while anyone holds it;
- every label a gate requires is defined and can be set by someone; stage and gate duties
  have holders (a missing recommended duty is only a warning);
- every release stage requires an approval: a label only humans may set, and only the holders of
  the release approval duty may set it (decision 19), so a release happens only on an explicit
  decision of a release approver; an AI member never sets a human-only label;
- a label marked "not by the author" is refused for the assignee and the linked PRs'
  attributed authors (no self-review); system labels are the integrations' alone;
- changing who may approve releases (approval labels, release bundles and their membership,
  `team.releaseFourEyes`) is owner-only; so are account bindings, admin grants and
  filesystem locations.

Real installations hold configurations written before a rule existed. They keep loading: the
migrations (`apps/server/src/config/migrations.ts`) rewrite older shapes in memory, and a release
approval that more than the release approval duty may give is narrowed to the duty (with a logged
warning) when someone holds it. The few errors no migration can repair without guessing (a
repository name or a column id used twice, a release approval while nobody holds the duty) do not
stop a load: the store logs each one, the settings page lists them, and every change, a revert
included, is refused until they are fixed (`isToleratedOnLoad`).

## Runtime architecture

```
browser (React) ── REST /api, websocket /ws ──▶ server (Fastify, Node, 127.0.0.1:4700)
                                                 ├─ domain services ─▶ SQLite (runtime state)
                                                 ├─ config store ────▶ customization git repo (YAML)
                                                 ├─ github ──────────▶ gh CLI (owner's login, read-only)
                                                 │                  └─ publisher: git + gh as the VM's own identity (PM-142)
                                                 └─ runner ──▶ node-pty ──▶ claude | codex (interactive TUI)
claude ── HTTP hooks  POST /hooks/:token ─────▶ runner (state machine, permission broker)
codex ─── command hooks ─▶ forwarder ─▶ POST /hooks/:token ─▶ runner
claude | codex ── MCP (http)  /mcp/:token ────▶ team tools ─▶ domain
claude | codex ── transcript JSONL ────────────▶ runner transcript tailer ─▶ chat events
```

- One HTTP port, bound to loopback. `/hooks` and `/mcp` accept only local connections with a
  per-session random token. Everything under `/api` and `/ws` requires a login cookie.
  Remote access goes through `tailscale serve` ([SECURITY.md](SECURITY.md)).
- Session states come from hooks: SessionStart → idle, UserPromptSubmit → working,
  PermissionRequest → waiting_permission (a blocking call answered by the inbox decision,
  with a timeout), Stop → idle, SessionEnd or exit → exited; a lost login → failed.
- Messages are typed into the PTY with bracketed paste only while the session is idle;
  otherwise they queue.
- Sessions do not survive a server restart; conversations do (the CLI's transcript), and a
  later message resumes them. A resumed task session gets a first input so that it does not
  sit at its prompt: the messages that caused the resume, else a short continue message (it was
  restarted; the task and its stage; check where it left off). A new conversation gets the
  messages that woke it after its brief, in full: typed in later they would wait for the end of
  the first turn, and the member would work from the timeline's excerpts (up to 24 000
  characters; the rest is typed in once it runs). Codex has it on the command line
  of `codex resume`, Claude Code has it typed once SessionStart arrives ([PROVIDERS.md](PROVIDERS.md)).
- The server's composition root is `apps/server/src/app.ts` (`buildApp`); the domain's is
  `apps/server/src/domain/index.ts` (`createDomain`), which builds the services (the board,
  member profiles and invitations included) and wires their reactions to the domain events.
- Services tell each other what happened through typed domain events (`ctx.events`:
  configuration changes, resolved inbox items, stage moves, cancellations, label and mention
  notices, sessions starting and ending, messages waiting for a recipient); a failing listener
  is logged and never stops the others. The event bus carries only what goes to clients (the
  websocket). Background work (hand-overs, message wake-ups, plan usage probes) is drained
  when the server stops.
- Only `apps/server/src/index.ts` reads configuration from the environment; it passes it to
  the modules as options. The git and gh commands the server runs inherit its environment.
- Writes that belong together run as one unit of work (`ctx.unitOfWork`): one SQLite
  transaction, whose websocket events are published only once it commits. Task writes read
  the task inside it and write only the columns they change.

## Module map

**Packages** (TypeScript source, used directly by both apps):

- `packages/shared` — the contracts: domain types, configuration schema and invariants, the
  duty catalogue, label and gate rules, owner-only changes, REST DTOs, routes, error codes and
  the websocket protocol (zod).
- `packages/templates` — factory project templates, role defaults and role views, standard
  label sets, member naming, legacy-configuration helpers, template locales.

**Server** (`apps/server/src`):

- `contracts/` — interfaces between server modules (runner, team tools, GitHub, context,
  config store, event bus).
- `runner/` — PTY sessions (input queue, permission gate), provider adapters
  (`providers/claude`, `providers/codex`), hooks and the hook forwarder, transcripts, plan
  usage, login checks.
- `mcp/` — the team tools MCP server (`/mcp/:token`): tool definitions and the text the model
  reads.
- `context/` — the context pack: system prompt, kick-off brief, work-item rules, member memory.
- `agent-text/` — AI-facing wording shared by the context pack and the team tools: timeline
  events, links, the repository of a task, one-line text.
- `worktree/` — git worktrees and branches for tasks; member workspaces (independent clones,
  safe branch switches, pinned review checkouts; PM-138).
- `github/` — `gh`-based pull request lookups and polling (the owner's read login); the publisher
  with the VM's separate identity (PM-142).
- `runtime-boundary/` — the VM boundary (PM-140): the boundary configuration, the launcher
  (root daemon, protocol, client), the worker bridge (inside each unit's own network namespace)
  and the service's per-member bridge sockets, the egress proxy, the worker workspace access, the
  readiness verdict and the boundary probe verify.sh runs.
- `http/` — request guards shared by the internal endpoints (local-only checks).
- `config/` — the customization repository: YAML load and save, git history, revert,
  configuration migrations.
- `db/` — SQLite schema, migrations and repositories.
- `domain/` — domain services: projects and roles; tasks (`tasks/`: CRUD, labels, stage moves
  and approvals); members and profiles; sessions; admission (`admission/`: checks, deferred
  starts, task starts with temp workers, stage hand-overs, message wake-ups); schedules;
  messaging (`messaging/`: send, delivery, receipts); attachments (`attachments/`: the service,
  file storage, content check, file names); inbox; invitations; the board; GitHub
  sync and pull request records; the team tools handler; domain events.
- `api/`, `auth/`, `ws/` — REST routes, login and invitations, the websocket hub.
- `app.ts` builds the application; `index.ts` reads the environment and starts it.

**Web** (`apps/web/src`): React UI (board, task drawer, team and profiles, session chat and
terminal, inbox, messages, settings) with `api/` (typed client, queries, websocket cache),
`features/`, `components/`, `lib/` and `i18n/`; `mocks/` is the in-memory fake backend behind
the UI tests.

Pure rules (label refusal and label changes, gates, duty resolution, invariants, owner-only
changes) belong in `packages/shared`, so the server and the web's test fake use the same code.

## Storage

`PROJECTMAN_HOME` (default `~/.projectman`, mode 0700):

```
db.sqlite                 runtime state
secret                    cookie signing key
customization/            git repo: projects/<KEY>/{project,team,pipeline}.yaml
memory/<KEY>/<handle>.md  AI member memory (durable learnings)
worktrees/<KEY>/…         git worktrees created for tasks
workspaces/<KEY>/<handle>/<repo>/{repo,cache,tmp}
                          member workspaces (PM-138, when on): durable independent clones,
                          never removed by projectman
workspaces/<KEY>/<handle>/.home
                          the member's own directory without a repository (PM-141, managed VM
                          profile only: chats, schedule runs, tasks without a repository)
instance.json             role of this copy (PM-143): absent = the active instance, `standby` or
                          `retired`; written only by a person with the move tool
migrated/                 what a move left (PM-143): the apply report, the old machine's pending
                          work, the carried transcripts; never read by the server
attachments/<KEY>/<TASK>/<id>   task attachments: private (0700 directories, 0600 files),
                          named by the generated id (the uploaded name lives only in SQLite);
                          a file still being written is <id>.part; an image or PDF
                          an agent asked for also has <id>.<ext> (a hard link)
```

SQLite tables: `users`, `auth_sessions`, `invitations`, `projects`, `counters`, `tasks`,
`task_links`, `timeline_events`, `sessions`, `team_messages`, `inbox_items`, `member_state`,
`schedule_runs`, `deferred_starts`, `attachments`, `member_workspaces` (one per project x member x
repository, with its reservation), `task_workspace_bindings` (a member's branch or review round of
a task in it), `task_review_pins` (PM-183: the commit handed over with the task's current review or
test stage); `sessions.execution_profile` (PM-141) is a column, not a table. Schema changes are numbered migrations in `apps/server/src/db/migrations.ts`;
the server refuses a database a newer build migrated.

## Permission settings of an AI member (PM-164, part of PM-162)

An AI member has two permission settings, following what Claude Code and Codex do themselves.
The **mode** is the existing `AiMemberConfig.permissionMode`, now editable (Kérdez `default`,
Szerkesztést elfogad `acceptEdits`, Auto `auto`, Tervezés `plan`; `SelectablePermissionMode`):
the runner passes it to the CLI as before, nothing is derived, and a read-only placement still
narrows it in `sessionPermissions`. New members start in `auto`, whatever the role or provider
(`DEFAULT_PERMISSION_MODE`). The **approver** is the new optional `AiMemberConfig.approver`
(`human`, `ai`, `none`), who answers when the CLI asks: a person (the sponsor, else an owner),
the AI decider, or nobody (the request is refused). Absent reads as `human`, today's behaviour
(`approverOf`); a new hire gets `DEFAULT_NEW_MEMBER_APPROVER` (`none`, decision 28), the one place
for that default. No migration rewrites configurations
(decision 26): existing members keep their mode and read `human`. `bypassPermissions` is not a
choice any more; an existing one shows as a legacy setting (`MemberView.permissionLegacy`) until
an owner picks a mode.

Only an owner changes either setting: `ownerOnlyChanges` category `permissions` compares the mode
and the approver of every AI member (a new one against the defaults), runs on the commit of every
configuration change, the member PATCH included, and so also stops an admin who writes a freer
mode into the configuration. The approver `ai` is selectable only with `team.boundary.enabled`
and another AI member at work that holds `boundary_authorization` (`aiApproverBlocker`); the
PATCH refuses it otherwise (422 `approver_unavailable`, `details.blocker`), the roster
(`MemberView.aiApproverBlocker`) says why, and the Team page warns when a member keeps `ai` after
its decider drops out. The timeline events `permission_refused` (PM-165) and
`permission_escalated` (PM-169), and `delegated`/`reason` on `permission_resolved` (PM-169), are
part of the contract and render from PM-164 on.

For Claude members (PM-165) the mode goes to the CLI as it is, and `InboxService.decide` answers
what the CLI still asks: `commandVerdict`, then the approver (`human`: the inbox; `none`: an
immediate refusal with no inbox item, a `permission_refused` event `by: 'approver_none'`; `ai`: the
AI decider of PM-169, below). The auto mode's own refusals arrive as the
`PermissionDenied` hook, through `PermissionBroker.refused`, as `permission_refused` `by:
'classifier'`. The hard denials (credentials, the live instance's data, `WebFetch` of localhost,
publishing) are deny rules computed in `domain/session-policy.ts` and rendered in `--settings` by
the Claude adapter; see `PROVIDERS.md` for the server-side decisions and their reasons.

**The AI decider on the host (PM-169).** With approver `ai` (and the owner's `team.boundary.enabled`) a
question the CLI still asks goes to the AI members holding `boundary_authorization`, not to the sponsor:
the routing rule (`routePermissionRequest`), the owner's categories it never delegates
(`permissionOwnerCategory`: publishing, release, live instance, credentials, lasting host changes) and
the one rule for who may answer (`canDecidePermission`) are pure rules in `packages/shared`; the item is
a `permission` inbox item whose `payload.delegation` carries the decider(s) and the lead deadline. The
decider is woken by a team message and answers with `decide_permission_request`
(`InboxService.resolveDelegated`: `allow` and `deny` close the item in its name and answer the waiting
hook, `escalate` hands it to the sponsor or owners). A deadline, a decider on leave or delegation
switched off do the same in `sweepDelegations`; nothing is ever an allowance by itself. The `managed_vm`
profile has no local approvals and is untouched.

An owner may set both settings for one session, as Claude Desktop switches the mode per session
(PM-170): `PATCH /api/projects/:key/sessions/:id` (`UpdateSessionRequest`, owner only; `null`
goes back to the member's). They are stored on the session row (`sessions.permission_mode`,
`sessions.approver`, NULL for the member's), so a resume keeps them and a new session starts with
the member's; the member's own settings never change. `effectiveSessionPermissions` (shared) is
the one rule for what applies: every start and resume (the policy, the CLI's mode, the context
pack's approver text), `InboxService.decide` (the refusal of `none`, and the approver it hands
`routePermissionRequest`, so a session's own `ai` or `human` routes like a member's) and the session
header. A new approver applies to the next question. A new mode needs the CLI's process to start again: a running session is marked
`permissionRestartPending` and restarts with `--resume` (Codex `resume`) once it is idle and
`SessionRunner.hasPendingInput` says no message is on its way in; messages for it wait meanwhile
and are typed in after the restart, which gets no continue message. Behind the managed VM profile
only a change into or out of `plan` restarts it. Grants "for this session" die with the process:
`permissionGrantsLost` says so in the header. Each change is a `session_permission_changed`
timeline event (the owner, `field`, `from`, `to`, `reset`, `restart`).

## Session policy migration (PM-87 / PM-127)

`contracts/session-policy.ts` is the provider-neutral session intent: placement, semantic team,
file and shell tool grants, roots, protected paths, denied operations, network intent and
outside-sandbox handling. Pure duty/access rules and the historical `permissionMode` mapping
live in `packages/shared/src/config/session-policy.ts`. The domain builds a fresh policy from
the actual placement on every start/resume and supplies the same object to the context pack
and runner. Claude renders its tool syntax; Codex consumes team tool names directly.

The active enforcement remains `legacy`; this migration does not enable strict isolation or
remove the command broker. `strict` intent is refused by both adapters until their verified
implementation is available. A reading placement (`read_only`, a review copy without the test
opt-in; `placementReadsOnly`) keeps the member's own mode, Auto included (PM-167, decision 28),
never receives a writable root, and keeps Codex's sandbox `read-only`. A review-copy placement carries its independent
git directory, source commit and round id; with member workspaces (PM-138) it is the reviewer's
own durable workspace, and also names the handed-over branch and the pinned review base. A
`task_worktree` placement in a member workspace has no shared `gitDir` (the clone's `.git` is its
own) and names the task branch and its start commit.

Review copies have a separate `reviewCopyMode` intent (`inherit`, `read_only`, `test`;
absent means `inherit`). Historical `permissionMode` values never opt a copy into writes.
Only `test` with strict enforcement intent grants its own repository, independent git,
cache and temporary roots; `plan` and explicit `read_only` remain read-only. This is a
synthetic policy capability, not activation: both current adapters refuse strict starts.
Configuration/UI wiring and verified provider activation belong to PM-130; no old member
permission is rewritten or classified as implicitly versus explicitly chosen.

The existing PM-134 Claude shell sandbox remains a separate legacy setting. This migration
preserves it and does not certify it as the strict filesystem and network boundary.

The CLI's own sandbox of a legacy session (PM-167, decision 28) is `sessionSandbox(policy, …)` in
`domain/session-policy.ts`, from the policy's actual paths; the runner gets it as
`StartSessionSpec.sandbox` and the context pack as `ContextPackInput.sandbox`. A developer's
worktree session (PM-134) gets one computed per session from `SandboxPaths` too (PM-153: the user's
home, the app home, the repository's default branch): `denyRead` closes the user's home and the
app home, `allowRead` re-opens only its own directories (the worktree, the task's attachments, its
`memberSandboxDir` with its npm cache and development data, PM-193), the shared git directory and
git's own files, `allowWrite` and `env` (`npm_config_cache`, `PROJECTMAN_HOME`) send npm and the
development instance to that member directory instead of the host's `~/.npm` and
`~/.projectman-dev`, `denyWrite` keeps the default branch and
the integrating checkout's `HEAD`, `index` and `packed-refs` (with their lock files) in the shared
git directory unwritten, and `deniedEnvVars` unsets the publishing tokens and the SSH agent. In a
member workspace (its own clone) nothing is shared, so the git part is left out. A reading
placement gets a sandbox that writes only the temp directory, with its working directory, every
`--add-dir` directory and the installation's other checkouts (the project's workspace, the app
home, the server's own checkout `installDir` from `index.ts`; PM-188) in `denyWrite`, and
`gh pr view`/`gh pr diff` outside it only for a repository on GitHub. Both have the credentials
and the live data (`deniedPaths`) in `denyRead`. The Claude adapter also denies `Edit` of the
`denyWrite` paths (and everything below them) with rules, since the sandbox does not bind the
built-in file tools. Codex ignores the spec's sandbox (its own is `read-only` for readers); the
managed VM profile gets none.

## Managed VM profile (PM-137, part of PM-135)

The running boundary of the VM direction (decisions 25, 26) is **outside** the app and measured:
`deploy/vm/` builds a Linux guest from a root-managed profile (`profile.env`, one source for
`bootstrap.sh` and `verify.sh`), and the app only consumes a result. The pieces:

- **Protected side**: the service account (`projectman`, uid 19000), the app and CLIs owned by root,
  `PROJECTMAN_HOME` (database, cookie secret, attachments, memory, worktrees), the logs, and the
  boundary settings (`/etc/projectman`, the nftables egress table `projectman_gate`, the units).
  None of it is writable by the workers; the data is not readable by them.
- **Free side**: one unprivileged account per member, `pmw-<handle>` (uids 20000–20999, own group
  and home under `/var/lib/projectman-work`), where that member's sessions and workspaces live.
- **Contract**: `packages/shared/src/deploy/vm-readiness.ts` lists the checks (version, worker
  privileges, protected paths, host isolation, network gate, launcher, service), which are
  required, and the one verdict rule `evaluateVmReadiness()`. `verify.sh` writes a report in that
  shape; `scripts/vm-readiness.ts` prints the verdict and the server enforces it (below); PM-143
  consumes it for the move. A flag such as `VM=true` is never an input; the report is strict and a
  missing check fails.

**The runtime boundary (PM-140, `src/runtime-boundary`).** `index.ts` reads nothing from the
environment: `index.ts` of the server loads the root-owned boundary configuration
(`PROJECTMAN_BOUNDARY_CONFIG`, `BoundaryConfig`), and `app.ts` builds from it:

- the **launcher client** (`SessionLauncher`): the runner starts every session through it as the
  member's worker (`RunnerModuleOptions.launcher`), the member workspace manager runs every
  workspace command through it (`WorkspaceAccess`), and the session orchestrator prepares a
  worker's session directory with it. The launcher itself (`launcher/daemon.ts`, entry
  `dist/launcher.js`) runs as root behind a socket only the service's group reaches and turns a
  narrow, validated request into a `systemd-run` unit with a fixed sandbox;
- the **egress proxy** (`egress/proxy.ts`, in the service process): the workers' only way out;
  it asks the domain's `EgressService` for every connection, which allows the base list and
  allowances and turns allowed PM-139 grants into allowances (DB migration 16);
- the **verdict** (`RuntimeBoundary.status()`): the readiness report, the launcher's answer and the
  proxy's listener. `SessionOrchestrator` refuses every start while it is not ready
  (`runtime_boundary_not_ready`). The question-free profile (PM-141, `managed_vm`) needs this
  configuration (the server does not start without it), and its per-start proof
  (`ManagedVmBoundary.verify()`) also requires `status().ready`, so question-free sessions only ever
  run through the launcher as the member's worker.

Without the configuration the boundary is `off` (`disabledRuntimeBoundary`), nothing changes for
other installations, and `status().ready` is always false.

Details, the manual trial and backup/restore are in [VM.md](VM.md).

## Execution profile (PM-141, part of PM-135)

An installation runs in one of two **execution profiles** (`ExecutionProfile` in
`packages/shared/src/deploy/managed-vm.ts`): `legacy`, the Mac installation as it always was, or
`managed_vm`, the owner's choice for the verified managed VM. In the managed VM profile the boundary
is outside the CLIs, so Claude Code and Codex run without local approval questions (decision 26);
[PROVIDERS.md](PROVIDERS.md) lists what each CLI is given and what is not yet proven by hand.

- **Selection is not proof.** `PROJECTMAN_EXECUTION_PROFILE=managed_vm` (read in `index.ts`, with
  `PROJECTMAN_WORKSPACES=member`, `PROJECTMAN_BOUNDARY_CONFIG` and optionally
  `PROJECTMAN_VM_READINESS_REPORT`, which defaults to the boundary configuration's report) only
  selects. Every start, resume included, asks a `ManagedVmBoundary` (`contracts/runner.ts`): the
  report boundary needs a Linux host, a ready, current report with the launcher and the domain gate
  passed (`evaluateManagedVmActivation`), and `app.ts` adds the runtime boundary's verdict (launcher
  answering, egress proxy listening). Otherwise the start fails with `managed_vm_unavailable`, before
  any workspace is prepared or process spawned, and never falls back to a legacy start. An unknown
  profile, or a managed VM without member workspaces or the boundary configuration, stops the
  server; a readiness report on a legacy installation does too. On the Mac the profile cannot be
  entered by a file or a flag.
- **The policy** (`SessionPolicy.execution`, placement `member_workspace`, built by
  `buildManagedVmPolicy` in `domain/session-policy.ts`) keeps `enforcement: 'legacy'`: it neither
  claims strict isolation nor migrates a `permissionMode` (`managedVmPermissions` reads the member's
  mode; `plan` stays research-only). It has no tool grants to render, no denied operations and no
  sandbox; the business rules and owner exceptions apply at the domain, network and operation gate
  (BOUNDARY.md). Sessions without a repository (chats, schedule runs, a task without one) work in a
  directory of the member's own worker account (behind the launcher) or in the member's own
  `<workspaces>/<KEY>/<handle>/.home`, never a shared directory.
- **No local approval path.** A permission request that arrives anyway is refused at once in the
  runner (and in the inbox broker): no inbox item, no `commandVerdict`, no command-form rules; the
  context pack drops the "Commands that run without asking" section. The legacy path keeps all of it.
- **Profile changes.** `sessions.execution_profile` (migration 14) records the profile a session last
  ran in. A conversation of the other profile is not resumed; the session starts a new one in the new
  placement and its unconsumed boundary requests are revoked (`BoundaryService.invalidateSession`).
- **Checks before each spawn** (runner, `runner/managed-vm.ts`): the installed CLI version is one the
  question-free settings are proven for, and the VM's own provider configuration (managed policy, user
  files, Codex's project file) sets nothing that overrides the protected start (PM-49); behind the
  launcher the user files are read from the member's worker home without following links; the Claude
  start also leaves out the project's settings and `.mcp.json`.

The fake CLIs model this (`FAKE_*_VERSION`, bypass modes, `FAKE_*_FORCE_*` for a request where none is
expected); the real CLIs are only run in the human trial of [VM.md](VM.md).

## Instance role and the move (PM-143, part of PM-135)

Moving an installation, or restoring a backup beside it, makes **copies of one home**. Only one copy may run the
scheduler and start AI sessions, so a home has a role (`packages/shared/src/deploy/instance-role.ts`,
`apps/server/src/instance`): no `instance.json` is the **active** instance (every earlier installation),
`standby` shows its data and refuses every session start (`instance_standby`; `DomainOptions.standby` stops the
scheduler, the GitHub polling, the retry timers and the usage monitor), and `retired` stops the server before it
creates or opens anything in the home. The marker is read in `buildApp`, once; an unreadable one stops the
server (no role is never read as active), and the server never writes it: only a person does, with
`scripts/migrate/cli.ts instance …`. An older build ignores it, which is why the live Mac checkout has to be
updated to a build that knows it before the old home is called retired.

The move tool (`scripts/migrate/`) is outside the server and uses it only for the schema version, the marker and
the configuration loader. It reads a **stopped** source (its database from a scratch copy of the main file and
its log, never in place), writes a checksummed secret package (the home without worktrees, workspaces and the
publishing identity; a git bundle per repository; the dirty files of every checkout; the transcripts the
database names), and `apply` turns it into a standby home: the database migrated by this build, the stored
paths translated by explicit mappings, the workspace paths committed in the copy's customization history, the
repositories rebuilt from their bundles, the old machine's uncommitted work kept as pending items. The procedure,
the rollback and the evidence are in [MIGRATION.md](MIGRATION.md).

## Review at a pinned commit (PM-183, part of PM-176 rule 1)

A task that enters a step or release stage a reviewing or testing duty belongs to
(`stageHandsOverForReview`, the set that gets the `review_copy` placement) is **handed over**: before the move,
`TaskMoves.prepareHandover` reads the head of the developer's branch through `SessionOrchestrator.sourceHead`
(the member workspace's `sourceHead`, or the task worktree's `head`, both in `apps/server/src/worktree`). A
working directory with uncommitted work refuses the move for everybody (`handover_uncommitted`); otherwise the
commit is pinned (`task_review_pins`, one row per task, shown as `Task.reviewPin` while the task is in that stage,
named in the reviewer's brief and "Review round"). A task without a repository or a branch is neither checked nor
pinned. A move completed by a human approval (`decide`) is handed over the same way: uncommitted work leaves the
task where it is (`gateBlocked.reason` `handover_uncommitted` on the timeline).

`ReviewWatch` (every 30 s, `DomainOptions.reviewWatchMs`; a pull request's new commits check the task at once)
compares the branch with the pin of every task in its stage. If the branch moved and nobody asked for it, the
system moves the task back to the work stage before it (`task_stage_changed.branchMoved`; the labels that expire
when a task goes back come off), then the stage's reviewers' sessions stop (their conversations stay), and the
assignee is told. Not while the review already gave the work back (`reviewReturnedWork`: a result label of a
reviewing or testing duty that needs a note, such as "changes needed" or "failed"): the fixes are the expected
commits, and the developer's message to the stage's reviewers is a new round (PM-138) that
`TaskService.repinReview` answers by pinning the new head. An approved or not yet judged branch that moves is
sent back.

## GitHub

Tasks live in our database (decision 9); GitHub is used for pull requests, reviews, checks
and merges. projectman reads from GitHub: it polls the PRs linked to tasks, keeps the
`pr-merged` label, clears `pr_updated` labels when new commits land, and attributes PR authors
to members (`githubLogin`). The one writing path is the managed VM's **publishing gate** (PM-142,
decision 26): the team tool `publish_task_branch` (`domain/publishing.ts`) takes member, task,
repository and branch from the server's records, and `GithubPublisher` (`github/publisher.ts`)
pushes that branch (never the default branch, never forced) and opens its pull request once, with a
separate GitHub identity whose token only the service holds. The pull request's author is recorded
from the authenticated session (`task_links.author_source = 'published'`, migration 15), so polling
by the shared bot login never rewrites it and no-self-review keeps holding. `get_remote_state` lets
the integrator and reviewers read the remote. See [GITHUB.md](GITHUB.md).
