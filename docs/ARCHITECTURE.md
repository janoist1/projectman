# projectman — architecture

projectman is a browser app that runs and tracks a team made of humans and AI members.
AI members are real, interactive agent CLI sessions (Claude Code or OpenAI Codex) running
on a human sponsor's subscription. The team works through a configurable pipeline of stages
(for example development → code review → QA → client test → merge → release). Every step is
attributed, and everything that waits for a human lands in one inbox ("Rád vár"). It runs on
the owner's machine, reachable from a phone through Tailscale; [DEPLOY.md](DEPLOY.md) covers
deployment and operation.

Documentation map:

| Document                                                                   | What it answers                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| this file                                                                  | concepts, invariants, runtime structure, module map, storage        |
| [DECISIONS.md](DECISIONS.md)                                               | what the owner decided and why (numbered, append-only)              |
| [ROADMAP.md](ROADMAP.md)                                                   | what is built, what comes next, open questions for the owner        |
| [LESSONS.md](LESSONS.md)                                                   | what building projectman taught us: challenges and lessons          |
| [PROVIDERS.md](PROVIDERS.md)                                               | Claude Code and Codex: flags, hooks, permissions, login, plan usage |
| [design/labels.md](design/labels.md), [design/duties.md](design/duties.md) | labels and gates; roles as duty bundles (reference, built)          |
| [design/phase2.md](design/phase2.md)                                       | the phase 2 proposal (meetings, retro loop, "Rendszer", notices)    |
| [GITHUB.md](GITHUB.md), [SECURITY.md](SECURITY.md), [DEPLOY.md](DEPLOY.md) | GitHub integration; threat model and protections; server deployment |

## Hard constraints

1. **Subscription, with a narrow NanoGPT exception** (decisions 1, 15, 34). Agents run as interactive TUIs in
   a pseudo-terminal, logged in with the sponsor's Claude or ChatGPT plan. No Agent SDK,
   `claude -p`, `codex exec` or app server for member work. The runner strips API keys and
   endpoint overrides from every session, and refuses to start a CLI that is not logged in
   with a subscription. NanoGPT alone receives the projectman-managed key from its secret
   store, in a dedicated Codex home without ChatGPT login or OpenAI billing fallback
   (PM-328, PM-329). The app never collects or stores subscription login credentials.
2. **English source code** (decision 10). Identifiers, comments, file names, commit
   messages, prompts for AI members: English. The Hungarian UI lives only in locale files
   (`apps/web/src/i18n/hu.ts`, `apps/feedback-widget/src/i18n/hu.ts`,
   `packages/templates/src/locales/hu.ts`). Data written by
   people and agents (task titles, notes, messages, label names) is in the project's language.
3. **No real agent or `gh` CLI in automated tests.** Tests use fakes that speak the same
   protocol: `apps/server/test/fixtures/fake-claude.mjs`, `fake-codex.mjs`, and
   `apps/server/src/services/github/test-fixtures/fake-gh.mjs`.

## Repository structure map (PM-683)

`projectman.structure.yaml` at the repository root on its default branch describes areas,
modules, directed links and ignored paths. The version 1 schema and longest-path placement
rules live in `packages/shared/src/domain/structure-map.ts`. The internal-only
`GET /api/projects/:key/structure` uses `services/structure` to read tracked files and the
descriptor at the same commit through engine git reads (PM-682).
Active cards use their review pin or latest branch link; completed cards use merge commits
from the last 14 days. Reads group cards by engine in batches of 25, with at most 300 cards
per repository, 20,000 tracked files and 1,000 changed files per card. Unmapped examples are
limited to 10. Missing, invalid and unavailable repositories retain their own status;
failed card batches omit only their cards. Project views are cached for 30 seconds and
concurrent requests share a read; immutable merge paths have a 5,000-entry FIFO cache.
Placement is recalculated from the current descriptor after each project cache expiry.
This works on remote engines: git runs on the engine and only file names and descriptor
text cross the boundary. No new machine-dependent operation is added beyond the engine git reads.

## Concepts

- **Project** — a workspace directory with one or more git repos (`repos[]`, each optionally
  on GitHub), a team, a pipeline with labels, and limits. Its configuration is YAML in the
  customization repository; its runtime state is in SQLite.
- **Member** — human or AI, identified by a unique **handle** (`fe-1`, `qa`, `owner`) and a
  display name. An AI member's state on disk and on its engine (workspace, `.home`, sandbox
  cache, memory file, snapshot refs) is kept under its **storage handle**
  (`memberStorageHandle`, PM-1024): the first of its `formerHandles` (earlier handles, oldest
  first, written by a rename), else the current handle. Renaming a member therefore moves
  nothing on disk, and the agent's conversations keep their working directory. The task and
  session comparisons (assignee, `session.member`, bindings) use the current handle.
  **Renaming an AI member** (PM-1025) is an owner-only operation (REST `POST
/api/projects/:key/members/:handle/rename`, the Operator's `member_rename` with an approval):
  `MemberService.rename` holds the member's starts (`StartHolds`, `member_renaming`), refuses with
  `member_session_live` while a session, a held workspace reservation, a `processing` queue item or
  a deferred start of the member exists, and commits one configuration change carrying
  `renames: {from: to}`. In that commit the configuration listeners see the previous configuration
  with the rename applied (so nothing is retired or hired), the handle columns of the database are
  rewritten in the same step (`apps/server/src/db/member-handles.ts`, `REWRITTEN_HANDLE_COLUMNS`),
  and a `member_renamed {from, to, version}` event is appended. The timeline's earlier events keep
  the old handle; viewers and the agents' text resolve it through `formerHandles` (the **alias**: a
  message to the old handle reaches the member, the context pack lists "formerly `x`"). The e-mail
  mailbox follows the new handle (see "E-mail"). Humans have an **access level** (`owner`, `admin`, `developer`, `client`,
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
- **Permission request delegation** — when the owner enables `team.boundary`, the server routes
  a permission request to independent holders of the `boundary_authorization` duty (the
  `lead_developer` bundle) unless it is an owner exception. A persisted lead deadline escalates
  to owners, never automatically allows. Human gate/release decisions stay separate. The
  external operation requests and grants (PM-1035, PM-1019 B1) are removed: no adapter was ever
  wired in.
- **Pipeline** — ordered **stages** grouped into **board columns**. A stage has a kind:
  `queue` (waiting to start), `work` (the assignee builds it), `step` (the owners do one thing
  — review, deploy, test, client test, merge — as the stage's duty says, and record the result
  with a label), `release` (always behind a human approval) or `done` (decision 18). A stage's
  owners are the holders of its duty unless it lists members explicitly. A **gate** is a list
  of label conditions (`has_label`, `lacks_label`) that must hold before a task may enter the
  stage; a condition with `when: <label>` binds only the cards carrying that label (never on a
  release gate).
- **Labels** (decision 17, [design/labels.md](design/labels.md)) — the one way to state facts
  about a task. The pipeline defines each label once: name, colour, meaning (given to AI
  members), group (mutually exclusive states), who may set it, no self-review, comment
  required, notify the assignee, cleared when the task moves back or its PR gets new commits,
  and blocking. A missing label only humans may set is an **approval**: the move opens an
  inbox decision, and approving puts the label on. `pr-merged` is a system label kept by the
  GitHub integration. Labels without a definition are plain tags.
- **Task** — key (`AR-21`), title, markdown description, stage, status, assignee (the work
  stage owner), repo, labels, links (PRs with their attributed authors, branches, issues,
  prerequisites), optional parent (one level
  of subtasks), comments with @mentions and **attachments**. Tasks can be imported with their original dates.
  Cards have no per-card visibility: clients read the same cards as viewers (PM-79, PM-987).
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
  The web (PM-203): the drawer's "Kapcsolatok" section (`TaskRelations`, replacing the subtasks row)
  lists them by kind from the board's cards, closed ones included (no request of its own), and the
  "+" dialog (`RelationDialog`) pre-checks a choice with `relationRefusal`; a card with an open
  prerequisite (`openPrerequisites`) says "Előfeltételre vár: PM-xxx" in its status line when it stands
  on it, and as a small chip when something else is happening to it (`lib/taskState.ts`).
  **Themes** (PM-192/PM-205): a card of `kind: 'theme'` (`tasks.kind`, default `task`) groups other
  cards. It has a key, title, description and timeline, and is open or closed (closed = `cancelled`,
  through the close route, by a human of developer access; reopened with `reopen`, which asks admin
  access for any other card). It is in no stage (it carries the first stage's id because the field is
  required), has no assignee or repository, is never moved or started, has no session (messages about it
  go to the recipient's general chat) and is no part, whole, prerequisite or prerequisite-of of a card;
  it duplicates only a theme and is related to anything. The one `isTheme` predicate in
  `packages/shared` is how every pipeline path leaves it out (moves, starts, assignment, `stage_in_use`,
  load, review watching). A card that is not a theme belongs to at most one theme (`tasks.theme_key`,
  `themeRefusal`: the theme exists, same project, open; a subtask gets none of its own); a subtask
  _reads_ its parent's theme (`Task.themeKey` is computed in `db/tasks.ts` by a join), so a collecting
  card changing theme writes nothing to its subtasks, which are only announced again. A card that becomes
  a subtask loses its own theme. `task_theme_changed {themeKey, previous}` is recorded on the card and on
  both themes. A theme's cards (collecting cards with their subtasks) and its progress (done of not
  cancelled cards) are `themeCards` / `themeProgress` in [`core/tasks`](modules/core-tasks.md).
  A task works in one repository: its own `repo`, else the project's only one when it has
  exactly one (`effectiveRepo`, the one rule in `packages/shared` that placement, the command
  policy, the context pack and the web read). The repo can be set later (task drawer, REST
  `PATCH`, `update_task`), but not while a session of the task runs.
- **Attachment** — a file (at most `MAX_ATTACHMENT_BYTES`, 25 MB) attached to a task, kept in
  `PROJECTMAN_HOME/attachments` and reached only through the protected REST routes
  (`routes.taskAttachments` and its `content`/`download` children, a multipart upload of one
  file per request, never buffered whole); there is no public static route. Who may read, upload
  and delete is one rule in `packages/shared` (`canUploadAttachment`,
  `canDeleteAttachment`): every project member reads (a client like a viewer, PM-79); a viewer and a
  client only read; AI members and the other workers upload; the uploader or
  a human owner or admin deletes. The attachments service ([`core/attachments`](modules/core-attachments.md), the contract in
  `contracts/attachments.ts`) takes a stream, so REST and the team tools share one size,
  storage and access check, and judges the member against the current roster
  again just before an upload is published. The media type is proven from the
  file's content (PNG, JPEG, GIF, WebP and PDF may be shown inline; HTML, SVG, a renamed or an
  unknown file is always an `application/octet-stream` download); every response is `nosniff`,
  sandboxed by CSP and has a safely encoded `Content-Disposition`; the uploaded name is
  sanitised metadata and never a path. The file system and SQLite share no transaction, so a row
  has a durable state: `pending` (being written), `ready` (the only readable one) and `deleting`
  (the recorded intent to delete, with who asked). A deletion removes the file first and then
  the row and the audit event together, a failure leaves it `deleting` (not readable, finished by
  the next try or the next start), and the start of the server finishes what a stop left half
  done. `attachment_added` and `attachment_deleted` stay in the task's timeline with the file
  name; the websocket event `task_attachments_changed` carries only the task key and reaches every member. Cancelling a task keeps its attachments, and
  no task is ever hard-deleted (deleting one for good would have to remove its files too).
  **Cover and thumbnail** (PM-195): a card's cover is its first image (`coverAttachmentId` in
  `packages/shared`, the oldest ready attachment whose content proved to be a PNG, JPEG, GIF or
  WebP); `Task.coverAttachmentId` is filled by `TaskStore.view`, and the attachments service
  pushes `task_upserted` when an upload or a deletion changes it. The board loads only
  `routes.attachmentThumbnail`: a WebP of at most 640 px that `sharp` makes on the first request
  (first frame, EXIF orientation applied, no metadata; a pixel and a time limit, one run per
  attachment and two at a time; an image it cannot decode answers 404 until the server restarts)
  and keeps as `<id>.thumb` next to the file. The same access check as the content.
  **Chosen cover** (PM-224): whoever may upload (`canUploadAttachment`) can pin one of the card's
  images or hide the cover with `PUT routes.taskCover` (`TaskCoverChoice`, answer `{ task }`; 422
  `cover_not_an_image` for a file that is not a ready image of the card). The choice is one row in
  `task_covers`; `coverAttachmentId(attachments, choice)` applies it: hidden → none, even after a
  new upload, until an image is pinned; a pinned image that is gone falls back to the first image,
  and deleting the pinned file removes the row with it. No timeline event, no team tool.
  **Files on a question** (PM-498): an `ask_human` question names at most 6 files
  (`MAX_QUESTION_ATTACHMENTS`) of its card or its parent; the inbox item keeps a snapshot of them
  (`QuestionAttachment`) and marks each with `goneAt` when the file is deleted (`InboxService.attachmentGone`).
- **Message attachment** (PM-515, PM-516) — a file (at most 25 MB, the same type sniffing and
  upload limits as the card attachment) a member sends with a team message, kept in
  `PROJECTMAN_HOME/message-attachments` and reached only through `routes.messageAttachments*`
  (upload, `content`/`download`/`thumbnail`, delete) and the team tool `read_message_attachment`.
  It belongs to a project, not to a card. Upload is open to every project member (a viewer too) and
  starts **unsent**: only its uploader sees it, at most 20 at a time (`message_attachment_limit`), and
  the hourly sweep removes the ones older than 24 hours. `send` takes `attachmentIds` (at most 10; the
  text may be empty with at least one): every file must be ready, unsent, of the project and the
  sender's own, else `message_attachment_unavailable` and nothing is sent; the binding to the message
  and the message happen in one transaction. A **sent** file is visible to exactly those who may see
  the message (`canSeeTeamMessage`); anyone else gets `not_found`. Deleting a sent file
  (`canDeleteMessageAttachment`) removes file and row, marks the entry in `team_messages.attachments`
  with `goneAt`/`goneBy` (`TeamMessage.attachments`, a JSON column; old rows have none), and
  publishes `team_message_updated`; it adds no timeline entry. The recipient's text carries the
  block `messageAttachmentLines` under the message (name quoted with `JSON.stringify`, SI sizes) in
  single, batch and Operator info delivery. `read_message_attachment` judges visibility through the
  calling AI member's eyes (a guest Operator conversation through the guest's) and answers an image
  as an image (first frame, EXIF rotation applied, WebP of at most 1568 px, 1 500 000 bytes), a
  valid UTF-8 text of at most 100 000 bytes as text, and anything else by name, type and size.
- **Work item and session** — every AI member works in a **fresh session per work item**:
  member × task, member × meeting or member × general chat (decision 5). A task session lives
  through the whole pipeline; later messages about the task resume it. Persistent identity
  and durable memory carry over between sessions. A task session of a role that changes files
  runs in a git worktree of the task's repository and never in the workspace root; with several
  repositories and none chosen it does not start (`repo_required`). Roles that only read run in
  the workspace root. A conversation belongs to the directory it ran in: when the task's
  worktree is elsewhere (its repo changed since), the session starts a new conversation there.
  **Dependencies in a worktree** (PM-332, PM-412, `PROJECTMAN_CLONE_DEPENDENCIES`, on by default; macOS only):
  after `ensureForTask` made the worktree (or found one with missing or stale `node_modules`) it clones `node_modules`, the
  root's and every workspace's, with `cp -c -R` (APFS `clonefile`: seconds, and the blocks are shared) from
  the first checkout of the repository (the repo path, then its other worktrees) whose `package-lock.json` is
  byte-identical and whose hidden `node_modules/.package-lock.json` is not older than it, i.e. installed after
  the lockfile's last change. Only on one APFS volume, only where git ignores `node_modules`; `.vite`,
  `.vite-temp` and `.cache` are left out of the copy. The server never runs `npm install`/`npm ci` outside the
  sandbox (install scripts). Whatever fails or does not apply (`worktree/dependencies.ts` names the reasons)
  is a log line, never a failed worktree: the member installs as before. Members' own workspaces and review
  copies are not cloned. An installation is stale when its hidden npm lockfile is missing or predates
  `package-lock.json`. Refreshes serialize per worktree, prepare all copies before replacing
  directories, and replace the root last. A failed replacement restores the old directories;
  without a matching reference, the old installation stays. The successful root copy is stamped
  at the target lockfile's modification time or later so another start does not refresh it again.
  Workspace modules absent from the reference are removed during replacement. Before every
  provider's `PreToolUse` answer (subagents included), the runner awaits the same manager method
  through `RunnerModuleOptions.refreshDependencies`. The manager only accepts paths registered
  by `ensureForTask` since server start and never derives the reference repository from a member's
  writable `.git` file. A fresh install needs two stat calls. Missing references, unsupported clones
  and failures retry after 60 seconds, or immediately if the target lock mtime changes. Copying has
  a 90-second total budget; Codex and Claude prepare hooks wait 120 seconds (Gemini already waits
  for its permission timeout). No heavy-run queue is taken for these short APFS copies. Failures
  only log and preserve the hook decision; the prompt tells the member to ask the owner to install
  missing dependencies in the default checkout.
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
  messages after it idles and restarts on the new commit.
  A non-assignee designer without implementation duties also uses a review copy once another
  member has a work branch on the card, in any stage (PM-828); before that, planning keeps its
  writable workspace. Each design-review start checks the current developer tip.
  The handed-over work is the assignee's workspace branch (another developer's later copy may
  be stale), else the last other one. Only committed work travels; the server fetches by explicit
  path. A workspace serves one task session at a time, for the life of its process group, idle or
  not (the reservation in `member_workspaces`): every start (admission, a person's resume, a
  message wake-up) checks it, a session of another task gives way only when it idles on a task it
  no longer works on (it is stopped; its conversation stays). It also yields after two idle minutes
  when its member has no open queue item on that card and a queued item needs another card (PM-927).
  Otherwise the start waits
  (`workspace_busy`). A branch switch needs a clean workspace with no unfinished git operation
  (`workspace_dirty`); nothing is stashed, reset, cleaned or removed, and done or cancelled tasks
  leave the workspace, its branches and dependencies in place. A conversation of an older
  generation of the workspace (made again or moved) is not resumed. Memory stays per project and
  member (`memory/<KEY>/<handle>.md`). The merger resolves conflicts in the card engine's
  dedicated merge-fix checkout, including in member workspace mode (PM-794).
- **Context pack** — built when a session starts: the project's own `CLAUDE.md`/`AGENTS.md`
  (read by the CLI from the working directory), the member's identity, duty fragments and
  instructions, the team roster, the project's labels, how to use the team tools, the rules
  of the current stage, for tasks the shell commands the server runs without asking (generated
  from `runtime/permissions` (`unattended-commands`), so that a member writes them in
  a form that passes), the member's memory, and for tasks a kick-off brief (title,
  description, links, relations to other cards, attachments, recent timeline) sent as the first message.
  The Operator's and the project manager's roles start with a short procedure/tool index; the full
  procedure is the optional `role` guide (PM-991, PM-992). The project manager's prompt keeps the
  signal level and its step budget, the never list, the screening limits and the report labels;
  the principles, signal, screening, feedback and routing procedures are in the guide.
  Immediate authorization limits, session policy, current task steps,
  configured/personal instructions, checklist state, knowledge, preferences and memory stay in the prompt.
- **Team tools** — an MCP server (`/mcp/:token`) through which AI members message teammates,
  read full `commands`, `rules` and optional `role` guide topics with the member-only `get_guide`
  tool (PM-972, PM-991),
  read and update tasks (labels, notes, stage moves, subtasks), create tasks, link PRs, ask
  humans, save memories and work with attachments (list, read by local path, attach a file of
  their own working directory, delete their own; PM-113, see [SECURITY.md](SECURITY.md)). Text
  an agent writes in its own session reaches nobody.
  Tool definitions may declare an optional audience of roles (Operator, project manager,
  named merger) or duties (`mcp/kit.ts`, PM-973). `runtime/sessions` derives the member audience
  from the current project configuration for every stateless MCP request; registration keeps
  tools with no audience or any matching role/duty. The Operator always sees all tools.
  This is list visibility only: handlers remain the permission authority. Tools whose access
  depends on a particular request, decision maker or conversation remain visible unless a role/duty
  is also a necessary condition; further session/request checks stay in the handler.
  External/super registration is unchanged.
  A client that caches its tool list sees new tools on the next session. Filtering runs on the
  server and adds no machine-dependent operation or remote-engine boundary.
  The context pack builds each guide from the same section builders as its short prompt index.
  Guides stay in server memory per live session, are rebuilt on start/resume and removed on exit
  or failed start. Only the shortened prompt crosses to a remote engine; no database storage is needed.
  `GUIDE_TOPICS` in `contracts/context.ts` supplies the MCP topic enum. A missing session topic
  returns `not_found`; role procedures share one guide even when several duties are indexed.
- **Team messages** — a message about a task goes to the recipient's session for that task
  (batched when idle; a stopped session is started or resumed through admission only for a valid
  action); messages to humans go to the web app. A message never goes to its sender.
  PM-368 records `kind` (`action` or `info`), the sending card version (stage, branch head and
  review pin), and a permission subject where applicable. AI `send_message` calls must name the
  kind. Info never starts a session or requests a review round. The server applies the shared
  `messageStaleReason` / `messageWakes` rules again before a deferred start: obsolete actions remain
  readable and reach the next input with an out-of-date marker; old unknown versions and human
  messages remain actionable. Result-label events retain the caller's reviewed commit.
  PM-426: an action from an AI member starts only a recipient with a role on the card
  (`hasCardRole` in `packages/shared`: its assignee, a member with a review, testing or UI/UX
  duty, an owner of its current `step` stage, or a member with a session on the card or its
  parent). The others get `next_input` with `noWake: 'no_card_role'` in the send result, and no
  review round is requested of them. The role is checked again before every deferred start, and
  when a card gets its assignee the waiting messages of the new assignee wake them. People, the
  integrator and `system` messages start anyone; a message about no card or a theme is not
  limited.
  PM-662: REST team-message sends, MCP `send_message` and Operator `start_member` check for
  same-role workers before review rounds, repinning or recording anything. Only an action that
  is not held, is placed on this open non-theme card and reaches a running session or would wake
  its recipient counts as joining. Project managers, Operators and existing card workers do not
  join; the sender and the handoff's outgoing member are excluded from the other workers.
  Shared `cardBusyGroups` reports a collision with another worker or another joining recipient of
  the same role as 409 `card_busy` with `CardBusyDetails`. Sending again with `despiteWorkers: true`
  (MCP `despite_workers`) confirms intentional parallel work. Other internal sends keep their
  existing behavior. The web temporarily confirms every send until PM-663 adds its confirmation
  dialog. All facts and checks stay on the server; no remote-engine boundary changes.
  AI messages wait in storage while the recipient works or waits for permission. At idle they
  reach it in one input, prefixed with the current card state, within the first-input size limit.
  PM-769 materializes only pending `(message_id, handle)` pairs in `team_message_pending`, indexed
  by project, recipient and the source message's sequence. Migration 77 backfills them; message
  insertion, receipt updates and legacy delivery markers replace each message's pairs in the same
  SQLite transaction, including within an outer unit of work. Receipts remain authoritative;
  missing/empty/JSON-null receipts fall back to the legacy aggregate delivery marker, malformed
  JSON receipts to an empty array. Pending reads hydrate only indexed matches; engine waiting
  counts use SQL COUNT without message hydration. Routing and action/info wake rules stay in
  `core/messages`. SQLite and this index stay on the server, within the existing “Cloud composition”
  and “Provider and engine outage watch” boundaries; no engine operation or payload changes.
  The shared synthetic measurement protocol is [PERIODIC-WORK-PERFORMANCE.md](PERIODIC-WORK-PERFORMANCE.md).
  The transcript and web chat split the batch into existing system-note and team-message items.
  A permission wait names its current deciders in the brief, get_task and the send result. A
  delegated notice is tied to its inbox item and no longer wakes its recipient after resolution
  or escalation. All validity and formatting happen on the server; engines receive text and
  the existing permission decision. The existing source-head git lookup stays engine-local.
  Injected messages carry the prefix `[team message from <handle> about <KEY>]` so
  transcripts can be parsed. Where an AI recipient gets it is decided when it is sent
  (`Messaging.place`, PM-182): its running session on the card; else on an open card its running
  session on an open family card (parent of a subtask, subtasks of a parent; siblings do not
  count; the most recently active wins; not for an owner of the card's current stage); a closed
  card's message goes to its general chat. The receipt keeps that `route` when it is not the
  default (`messageRoute` in `packages/shared`), so the message is found there while it waits;
  the prefix always names the message's own card. While a card is being refined (`isRefining`), a
  message about it for an AI member that is not the `turnMember` is held at the card, whatever
  sessions the family has (PM-255): it is typed in or taken in the first input when that member's
  turn starts, and wakes its recipient as usual when the card leaves refinement; only the answer to
  the recipient's own `ask_human` question goes through at once.
  PM-421: a new relation on a card that is being worked on is announced by `RelationNotices`
  ([`core/messages`](modules/core-messages.md)), which listens to the `task_relations_added` event
  (emitted after commit by `TaskService.create` / `applyUpdate`, one event per operation, for both
  cards; a deletion emits nothing). Each AI member with a running session on the card (not the actor,
  not a closed card) gets one stored `info` message from `SYSTEM_SENDER` (`system`) naming the
  relation kind from its card, and the other card's key, title, stage, status and the start of its
  description (only key and title when it may not read it). It starts nothing: `SendOptions.untilInput`
  keeps it for an idle session until its next input (`MessageDelivery.holdUntilInput`; counted
  delivered when typed in, so the receipt time is the trace), a working session gets it at the end
  of its turn. For a prerequisite or a duplicate (`relationAsksAnalyst`) the card's analyst
  (`cardAnalyst`: the AI member who last set `analysis-ok`, else the first `requirements_analysis`
  duty holder not on leave) also gets an `action` message on that very card (`SendOptions.ownCard`:
  never steered to a family card's session) asking it to check the work; an analyst who is also a
  worker gets this one only. With no analyst the owners get a `relation_check` alert. The held
  notices are in memory: one for a session that ends stays undelivered for the member's next session.
  The messages are the whole trace: the timeline's `team_message` row names the recipient and the time,
  the card thread shows the owner the delivery receipt with its time.
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
  SQLite as well as in memory: a start that waits for one chosen AI member is an item of that
  member's queue (`member_queue_items`, type `start`, PM-927); one with no member chosen yet (nobody
  free, a Senior, a prerequisite, a label) stays in the `deferred_starts` table, as no member's
  queue can hold it (PM-949). The server loads both back when it
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
  task, see `TaskStore`; also a card without an assignee in a work stage whose every owner is
  such a developer).
- **Work start** (`admission/work-starts.ts`, PM-119) — an active card moved into a work stage
  without an assignee starts like the Start button starts it: `TaskStarts.startLocked` is the
  same developer choice, temp worker, admission checks and session start, run under the
  admission lock the attempt already holds (the lock is not reentrant). Nobody free waits
  (`no_free_member`, a refusal only this start defers) in `deferred_starts` as a `work_start`
  spec, and is retried by the 30 s timer and by the events that free capacity (a card leaving
  a work stage, a session ending or going idle, a card cancelled, a member called back). It
  applies only while the card is still in that stage and has no assignee other than the one
  this very start assigned (a half-done attempt carries on, someone else's assignment ends the
  wait). While AI work is off a move creates no start. A card with an assignee only gets the
  stage hand-over's notice. **Prerequisites** (PM-204): `startLocked` first refuses a card with an
  open prerequisite (`prerequisite_open`, the open keys in the details), before any developer is
  chosen; the work start defers that refusal too, so the card waits (`startWaiting.reason`
  `prerequisite_open` with `prerequisites`) and starts once, when the last prerequisite is done or
  withdrawn (`task_stage_changed`/`task_cancelled` retry the deferred starts) or its relation is
  removed (`task_prerequisite_removed`); the retry skips a start whose open prerequisites did not
  change. A person starts despite them with `despitePrerequisites` (`StartTaskRequest`, or
  `UpdateTaskRequest` on the move, carried as `StageChange.despitePrerequisites` into the
  `work_start` spec): honored for human actors only, so a card an AI member moves waits. Cards in a
  queue stage have no start, so a closing prerequisite starts nothing there. (A move that needs an
  approval first does not carry the flag past the approval: the card then waits.) Each closing writes
  `task_prerequisite_closed` on the timeline of every open dependent (`PrerequisiteClosures`). The
  stage hand-over (review, QA) and message wake-ups do not wait for prerequisites.
  **Labels an AI member sets** (PM-236): the Start button of a card whose gate before the work
  stage lacks only labels that AI members may set (`aiLabelSetters` in `packages/shared`, from
  `UnmetCondition.setters`; any other unmet condition, a blocking label, or a human-only setter
  keeps today's `gate_blocked`) starts those members' sessions (the designer round, PM-235) and
  keeps the developer's start as a `work_start` spec with `afterLabels` and the chosen `developer`.
  The card stays where it is, unassigned, with `startWaiting.reason` `label_missing` and `labels`.
  The `task_labels_changed` event retries the deferred starts; the retry skips this start while
  the gate still blocks (`AutomaticStart.blocked`), and starts the developer once it lets the card
  through (the label set, or `ui` removed). A move, a cancel or an assignment ends the wait like
  for the other work starts. Only a person's start (`StartTaskOptions.startSetters`, set by the
  route) starts setters.
  **The complexity limit** (PM-1007, replaces the Senior mark of PM-348): the automatic developer
  choice is `chooseDeveloper` in `packages/shared`. A card's points (`Task.complexity`, PM-1006) are
  compared with each developer's `complexityLimit` (a temp worker's is always 5). Among the free
  developers, optional `specialtyLabels` first restricts automatic assignment to cards carrying at
  least one matching label; explicit assignees remain unrestricted (PM-1038). Among matching free
  developers whose limit reaches the points the one with the smallest limit wins (then the least
  loaded, then the team order), so a small card does not take the strongest developer; an unscored
  card goes the same way among all free developers. While every developer who reaches the points is
  busy or away, `startLocked` leaves the card in the work stage unassigned and the start waits as a
  `work_start` deferral (`startWaiting.reason` `senior_busy`, with `seniors`: the handles whose limit
  reaches the points); a person's Start gets a normal response with that wait. A card of up to 5
  points may go to a temp worker instead of waiting. `SeniorWaits` (`admission/senior-waits.ts`, table
  `senior_waits`, one open row per card) keeps when the wait began, the question and the answer over a
  restart. After `seniorWaitMinutes` (30) the 60 s sweep asks the owners once (an inbox decision,
  `wait_for_senior` or `any_developer`); "any" lets the free non-temp developer with the largest limit
  take it. A freed developer who reaches the points takes the card first (`retryDeferred` tries
  `senior_busy` deferrals first) and the question closes (`senior_took`); an assignment, move,
  closure, a change of the card's points (`task_complexity_changed`) or of the team's limits closes it
  (`senior_wait_ended`). When no developer's limit reaches the points the card starts by the "any"
  rule (`no_senior` event). The names `senior_*`, `seniors` and `wait_for_senior` are kept because
  stored rows and events carry them. A config migration turns the old `senior` mark into limit 13 and
  a DB migration turns a "senior" recommendation into 8 points. No machine-dependent part is affected.
  **A paused provider** (PM-1051): a member whose provider is held (`provider_rate_limited` cooldown) or
  over the plan usage limit (`plan_usage_paused`, `planUsagePause` in `packages/shared`) is not free
  (`Admission.providerAvailable`), so the automatic choice never picks them and a paused high-limit
  developer causes no `no_senior`. An assigned card whose assignee is on such a provider and has not begun
  it (no session, no source trace, no open handoff, no fix-limit hold: `canReplaceUnstartedAssignee`) is
  planned like an unassigned one by `planStarts` (`reassignableTaskKeys`, always an offer) and started by
  `start_task` at a fitting free member (points, label and specialty limits still apply); with none free
  nothing is assigned and no session starts. Work already begun is never moved. A new assignee on a
  paused provider is refused by `update_task` and the REST PATCH with the known 409 codes, the whole
  update atomically (`TaskService.registerProviderAssignmentCheck`, `Admission.assertProviderAvailable`).
  The check reads the last background usage (`PlanUsageCache.peek`); admission itself still refreshes.
- **Stage hand-over** — when a task enters a later stage owned by AI members, by anyone's
  move, the least loaded free owner (never the task's assignee) gets a session for the task.
  An owner that already has a session for the task gets a notice instead. A card sent back into the
  work stage tells its assignee's session, and starts an AI assignee that has none (PM-420; a deferred
  `hand_over` start when admission refuses; not when the assignee moved it or the fix limit holds it).
- **Refinement line** (decision 31, `RefinementSteps`) — a card carrying `refine` (or standing in a
  `task_breakdown` step stage) is worked out one step at a time, before development. The steps are
  the labels the gates up to the work stage lack, in gate order (`refinementTurn` in
  `packages/shared`, the same set `evaluateStart` refuses a Start for). Each step has one member:
  an AI setter (already working on the card, else not on leave, else least loaded) is started
  (a running session only gets a notice), a person gets a `manual_step` alert. Nothing is done
  while a session is mid-turn on the card; a step is not handed out twice (its member's turn
  ending without the label raises one `stalled` alert). When every label is on, the system takes
  `refine` off and moves the card to the stage before development. Completion (`done`, PM-594)
  sends a team message to the configured card mover, otherwise the project manager, otherwise
  the Operator (`info` for a human, `action` for an AI member). Without a recipient, only the
  `refinement_turn` timeline event remains. The project manager can start for this system message;
  the Operator receives it with the owner's next message under the existing wake rule (PM-447/475).
  Legacy `done` alerts are cancelled at startup (`RefinementSteps.reconcile`) and when the card is
  next examined (`closeAlerts`). The shared `isInformationalAlert` predicate also excludes them
  from `taskWait`, so an acknowledgement never makes the card wait for their recipient.
  Every change of turn is a `refinement_turn` timeline event (`turnMember` reads the latest). A
  turn left open when `refine` comes off (or the card leaves the stage) is closed with `stopped`,
  so putting `refine` back begins a new turn (PM-420). A
  refused start is deferred (`StartSpec` kind `refinement_turn`) like a hand-over. In such a
  project a person's Start does not start label setters (PM-236): it is refused until the card is
  worked out, and the stage hand-over starts nobody on entering a refinement stage.
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

- handles are unique, and a handle once used is never reissued: the `formerHandles` of every AI
  member and the `from` of every `member_renamed` event stay taken (PM-1025); at least one human
  owner exists; AI sponsors are humans;
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
                                                 ├─ core and services ─▶ SQLite (runtime state)
                                                 ├─ config store ────▶ customization git repo (YAML)
                                                 ├─ github ──────────▶ gh CLI (owner's login; read-only, but a release, PM-968)
                                                 └─ runner ──▶ node-pty ──▶ claude | codex (interactive TUI)
claude ── HTTP hooks  POST /hooks/:token ─────▶ runner (state machine, permission gate)
codex ─── command hooks ─▶ forwarder ─▶ POST /hooks/:token ─▶ runner
claude | codex ── MCP (http)  /mcp/:token ────▶ team tools ─▶ module facades
claude | codex ── transcript JSONL ────────────▶ runner transcript tailer ─▶ chat events
```

- One HTTP port, bound to loopback. `/hooks` and `/mcp` accept only local connections with a
  per-session random token. Everything under `/api` and `/ws` requires a login cookie.
  Local single-machine remote access can use `tailscale serve` ([SECURITY.md](SECURITY.md)).
  The cloud hub's public entrance uses a Cloudflare Tunnel and Access
  ([HYBRID.md](HYBRID.md#the-cloudflare-tunnel-and-access)), ending at the container's loopback port.
- Session states come from hooks: SessionStart → idle, UserPromptSubmit → working,
  PermissionRequest → waiting_permission (a blocking call answered by the inbox decision,
  with a timeout), Stop → idle, SessionEnd or exit → exited; a lost login → failed.
- Messages are typed into the PTY with bracketed paste only while the session is idle;
  otherwise they queue.
- Sessions do not survive a server restart; conversations do (the CLI's transcript), and a
  later message resumes them. A stop pauses the team first and the start resumes it, so the
  sessions that were working go on with a nudge (the pause section below, PM-219). A resumed task session gets a first input so that it does not
  sit at its prompt: the messages that caused the resume, else a short continue message (it was
  restarted; the task and its stage; check where it left off). A new conversation gets the
  messages that woke it after its brief, in full: typed in later they would wait for the end of
  the first turn, and the member would work from the timeline's excerpts (up to 24 000
  characters; the rest is typed in once it runs). Codex has it on the command line
  of `codex resume`, Claude Code has it typed once SessionStart arrives ([PROVIDERS.md](PROVIDERS.md)).
- **End-of-round compaction (PM-213, part of PM-209).** A member's round on a card ends when the
  card leaves the stage the member worked it in (`isWorkingOnTask` false after a
  `task_stage_changed`; a card that is done or cancelled needs nothing). The conversation then owes
  a compaction (`sessions.compact_pending`): `SessionOrchestrator.roundEnded` delegates to `RoundCompaction` (`runtime/sessions/compaction.ts`), which marks every session of
  the card and, at the session's idle moment, types `/compact <instruction>` through the runner
  (`SessionRunner.compact`; the text is `COMPACT_INSTRUCTION` of the context module, which names what
  to keep). Nothing is typed while a message is on its way in (`hasPendingInput`): it goes first, and
  the next idle moment tries again; if the card is back in a stage the member works it in by then, the
  conversation just goes on. The runner follows the CLI's PreCompact and PostCompact hooks: the
  session is `working` ("Compacting the conversation") until PostCompact, so no message is typed
  over it. A typed command that has not started holds the queue back as well (a message typed behind
  a swallowed command would start a turn the give-up must not end). The runner gives the compaction up
  (a `compaction` event, `abandoned`) if the command does not start within `compactStartTimeoutMs` or
  end within `compactTimeoutMs`; only a compaction that had started is then ended (idle). Only
  a conversation whose last measured context (input + cache read + cache write of its last step,
  `sessions.context_tokens`, from the transcript) is above `COMPACT_MIN_CONTEXT_TOKENS` (100 000; a
  fresh session already starts at 52-56k, so a small or just compacted conversation is not worth a
  summary, and an unmeasured one counts as small) is compacted, at the end of its round and on resume.
  A session that did not run at the end of its round (stopped, server restarted) is compacted when
  it resumes, before the wake-up messages or the continue message (`StartSessionSpec.compactFirst`).
  The compaction is the same conversation, in the same
  transcript. Only Claude Code is compacted (`COMPACTING_PROVIDERS`): Codex's compaction command was
  not checked, so its members work as before. A returning reviewer's continue message names the commit
  it reviewed last (`sessions.reviewed_commit`, set when a session starts on a pinned commit) and asks
  for only the change since and the fixes of its earlier findings.
- The server's composition root is `apps/server/src/app.ts` (`buildApp`); the domain's is
  `apps/server/src/assembly.ts` (`createDomain`), which builds the services (the board,
  member profiles and invitations included) and wires their reactions to the domain events.
  Core implementations live in the eight sealed `core/<module>/` folders; common helpers
  live behind `kernel/index.ts`. Composition lives in `assembly.ts` (PM-648).
- Services tell each other what happened through typed domain events (`ctx.events`:
  configuration changes, resolved inbox items, stage moves, cancellations, label and mention
  notices, sessions starting and ending, messages waiting for a recipient); a failing listener
  is logged and never stops the others. The event bus carries only what goes to members (the
  websocket). Shutdown stops the kernel sweep tickers and module programs, then waits for
  running sweep rounds and background work (hand-overs, message wake-ups, plan usage probes).
  It next awaits `MessageDelivery.close()`, calls `pauses.dispose()` and `sessions.dispose()`,
  and awaits `sessions.settleFolderRemovals()` (including the session lifecycle Scope closing).
  The Scope ends the runner subscription and job tracking, refuses new jobs and closes session
  timers; it neither cuts nor waits for existing session jobs. Folder removals are awaited
  separately before temporary roots are released.
  Finally the machine monitor and the scheduled work finish.
- Only `apps/server/src/index.ts` reads configuration from the environment; it passes it to
  the modules as options. The git and gh commands the server runs inherit its environment.
- Writes that belong together run as one unit of work (`ctx.unitOfWork`): one SQLite
  transaction, whose websocket events are published only once it commits. Task writes read
  the task inside it and write only the columns they change.

## Module map

### Layers and the dependency rule (PM-577)

Every server source file belongs to one stable module and one layer (PM-577, PM-649).
Targets describe the implemented layout; passes record the completed refactor.
Each module gets one pass: `none` keeps it unchanged; `move` relocates it;
`split` gives it a narrow plain TypeScript interface; `split-tool` does that and
adopts the chosen tool (Effect) in the same pass; `delete` removes it.

| Layer       | Contents                                                        | Runs on                                                     |
| ----------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `contracts` | Shared interfaces and engine ports                              | Server and engine                                           |
| `infra`     | Storage, configuration, logging and common helpers              | Server; engine where needed (logging, identity and helpers) |
| `core`      | Project, task, member, message and inbox rules                  | Server                                                      |
| `runtime`   | Admission, sessions, delivery, permissions, watches and context | Server; engine-local enforcement through contracts          |
| `service`   | Independent capabilities such as merges, tests and releases     | Server; machine operations through engine ports             |
| `engine`    | CLIs, worktrees, host operations and server/engine transport    | Execution host; remote adapters also run on the server      |
| `connector` | API, MCP, websocket, HTTP, control and auth adapters            | Server; engine-side HTTP/MCP relay where needed             |
| `assembly`  | Application startup and dependency wiring                       | Server or engine entry point                                |

Imports within a module are unrestricted. Across modules, dependencies go only
downward according to this table (type imports count too):

| Layer       | May import                                                      |
| ----------- | --------------------------------------------------------------- |
| `contracts` | `contracts`                                                     |
| `infra`     | `contracts`, `infra`                                            |
| `core`      | `contracts`, `infra`, `core`                                    |
| `runtime`   | `contracts`, `infra`, `core`, `runtime`                         |
| `service`   | `contracts`, `infra`, `core`                                    |
| `engine`    | `contracts`, `infra`, `engine`                                  |
| `connector` | `contracts`, `infra`, `core`, `runtime`, `service`, `connector` |
| `assembly`  | All layers                                                      |

Services do not call other services, and runtime and services do not call each
other: they communicate through the core. Connectors and runtime reach engine
capabilities only through ports in `contracts/`. Workspace `@projectman/*`
packages count as contracts and are accessible to every layer.

The source is [module-map.ts](../apps/server/test/architecture/module-map.ts).
The final closure is recorded by PM-649, after PM-627 and PM-645 closed phases 4 and 5.

The kernel and eight core modules are sealed at their final paths (PM-631, PM-637–644).
The core descriptors live in `test/architecture/modules/core-<module>.ts`, assembled in
the original `MODULES` order. Their public names, types and factory dependency shapes
remain those frozen in PM-636; no old implementation files or forwarding shims remain.
Assembly uses `createProjectService`, `createTaskService`, `createMemberService`,
`createTimelineService`, `createMessaging` and `createInboxService` in the existing
construction order; the factories return the existing classes without changing behavior.

| Module                                            | Responsibility                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `contracts`                                       | Shared server interfaces and engine ports.                                  |
| `db`                                              | SQLite storage, repositories and migrations.                                |
| `config`                                          | Project configuration loading, validation and migrations.                   |
| `exec`                                            | One-shot external commands with exact environments and bounded termination. |
| `logging`                                         | Structured server and engine logging and file rotation.                     |
| `instance`                                        | Installation identity and activation state.                                 |
| `kernel`                                          | Common errors, utilities, background work, sweeps and merge locks.          |
| `agent-text`                                      | Text formatting for agent-facing context.                                   |
| [`core/base`](modules/core-base.md)               | Domain context, units of work, domain events and the websocket event bus.   |
| [`core/projects`](modules/core-projects.md)       | Projects, roles, stage reviewers and visibility.                            |
| [`core/tasks`](modules/core-tasks.md)             | Tasks, PR records, board state, focus, involvement and card measures.       |
| [`core/members`](modules/core-members.md)         | Member access, invitations, presence and naming.                            |
| [`core/timeline`](modules/core-timeline.md)       | Append-only task and project timeline access.                               |
| [`core/messages`](modules/core-messages.md)       | Stored messages, sending/session-chat rules and runtime routing port.       |
| [`core/inbox`](modules/core-inbox.md)             | Human questions, approvals, permission inbox items and question lifecycle.  |
| [`core/attachments`](modules/core-attachments.md) | Task and message attachment storage and processing.                         |
| `runtime/admission`                               | Admission, deferred starts, handovers and refinement.                       |
| `runtime/sessions`                                | Session lifecycle, rounds, compaction, policy, pause and workspaces.        |
| `runtime/delivery`                                | Message routing, holds, wake-ups, session chat and session notices.         |
| `runtime/permissions`                             | Command parsing and execution permission rules.                             |
| `runtime/watchers`                                | Runtime health, machine, outage, review, left parts and cleanup watches.    |
| `runtime/usage`                                   | Provider quota, plan usage and managed provider keys.                       |
| `context`                                         | Agent context packs, prompts and member memory through two factories.       |
| `services/merges`                                 | Card merge orchestration, queue and locks.                                  |
| `services/full-tests`                             | Full-test and screenshot-run orchestration.                                 |
| `services/releases`                               | Release proposals, release roadmap notices and `publish_release` (PM-968).  |
| `services/structure`                              | Repository structure descriptors, module sizes and card file placement.     |
| `services/github`                                 | GitHub synchronization, pull requests and publishing.                       |
| `services/obligations`                            | Open-step deadlines, one reminder and one integrator todo (PM-806).         |
| `services/feedback`                               | Feedback marks, screenshots and widget sessions.                            |
| `services/project-docs`                           | Operator document writes and decision candidates.                           |
| `services/schedules`                              | Scheduled member work.                                                      |
| `services/operator`                               | Operator actions, signals, requests and project management.                 |
| `runner`                                          | Provider CLIs, PTYs, permission waits, transcripts, usage probes and trust. |
| `worktree`                                        | Task and member worktree creation and dependency refresh.                   |
| `engine-host`                                     | Engine-local files, session roots, host operations and branch merging.      |
| `full-test`                                       | Sandboxed test execution and the heavy-run queue.                           |
| `machine`                                         | Machine probes and process parsing.                                         |
| `engine-link`                                     | Server/engine RPC, transport and remote adapters.                           |
| `api`                                             | HTTP API adapters.                                                          |
| `mcp`                                             | MCP transport, tool declarations and handlers.                              |
| `ws`                                              | Websocket transport and broadcasts.                                         |
| `http`                                            | HTTP transport guards and infrastructure.                                   |
| `control`                                         | Administrative control socket.                                              |
| `auth`                                            | Authentication and integrator credentials.                                  |
| `assembly` (`assembly.ts`)                        | Domain service composition and wiring.                                      |
| `entry`                                           | Application and engine startup, composition and shutdown.                   |

The source of truth for file → module assignments is
[projectman.structure.yaml](../projectman.structure.yaml). Layers, targets and passes live in
[module-map.ts](../apps/server/test/architecture/module-map.ts), which reads server paths
from the YAML at load time.
The longest matching path wins; each declared path must exist and appear only once.
[dependencies.test.ts](../apps/server/test/architecture/dependencies.test.ts)
enforces the layer rules against all production TypeScript source files.
There are no dependency exceptions; new ones must not be added. Every module below
the assembly layer is sealed: cross-module imports use its target `index.ts`.
The guard test asserts both the empty exception list and complete sealing.

The sealed modules are `contracts`, `db`, `config`, `logging`, `instance`, `kernel`,
`agent-text`; all eight `core/*` modules; `runtime/admission`, `runtime/sessions`,
`runtime/delivery`, `runtime/permissions`, `runtime/watchers`, `runtime/usage`, `context`;
all nine `services/*` modules; `runner`, `worktree`, `engine-host`, `full-test`, `machine`,
`engine-link`; and `api`, `mcp`, `ws`, `http`, `control`, `auth`.
Only `assembly` and `entry` remain unsealed in the assembly layer. Other layers cannot
import them. The `context` facade exposes `createContextPackBuilder` and
`createMemberMemoryStore`; prompt and formatting helpers remain internal.

No exception has a `core/*` source. Of the fifteen original pairs, PM-612 removed one, and
PM-632–635 removed fourteen. PM-646 removed the four connector exceptions
(`api/auth/ws → assembly`, `instance → entry`). PM-648 moved composition to
`assembly.ts` and removed compatibility exports; callers import the owning module.
PM-649 sealed the remaining ten modules and added the final guard. The `domain/`
folder is gone, composition exports only its factory and types, and every lower-layer
module is behind its facade. This completes the module refactor's structural goals (PM-577).

#### Core extension points

When a core rule needs facts from a service or runtime module, the port type belongs
to the core module. Its `register…` method names the core concept rather than the
provider. Registration happens in assembly (`assembly.ts`); constructor ports also
receive the existing runtime/auth/service instances there. These interfaces live in
`core/{projects,tasks,members,messages,inbox}/ports.ts` and are exported by their facades.
Core imports neither runtime/services/auth nor Effect. A later registration replaces
the earlier one.

The first extension point is `TaskService.registerMergeGate(gate: MergeGate)` (PM-591).
The merge service supplies the facts for “done only after merging”; the rule that
decides which move requires a merge and when to check it (`moveMerge`, `mergeRepoOf`)
stays in `packages/shared` and is applied by task moves.

The inbox's `registerDecider(key, decide)` supplies merge, release, hand-on and Operator
approval decisions; handlers that own the item close it themselves. `registerQuestionAnswer`
supplies question delivery, and `registerAskerStarts` supplies visible asker-start previews.
Messaging's `registerWaker` supplies recipient wake-ups, `registerSignals` records Operator
signal presentations and decisions, and `registerCardHold(reason, hold)` supplies card-level
fix-limit and full-test holds while messaging decides which recipients wait (PM-593).
The awaited `task_review_round` event announces an assignee's action message about an open
card before recording it; its assembly listener queues the pinned commit's full test before
recipients get the message.

#### Team tools and routes by module (PM-592)

A module's team tools live in `mcp/<module>/`: `tools.ts` exports a `TeamToolGroup`,
`handler.ts` implements its handler contract, and `index.ts` exports both.
`TEAM_TOOL_GROUPS` in `mcp/tools.ts` is the registry of module tool definitions;
`mcp/team-tools.ts` collects the handlers through `TeamToolsService` forwarding
methods. New tools belong in their module's group and handler, never in either collector.

One shared `ToolCaller` (`mcp/caller.ts`) checks callers, the Operator's requests and
guest access, records steps and opens session files. Assembly creates it once and
passes it to every handler, preserving the shared signal-step reservation.

REST routes already register by module: `api/<module>.ts` exports
`register<X>Routes(app, deps)`, collected by `registerApiRoutes` in `api/index.ts`.
No REST contract changes. This refactor moves server code only; engine calls and
file-transfer boundaries stay unchanged.

The Operator slice (PM-605) lives in `services/operator/`, with one entry point and
structural ports for sessions, admission, delivery, pauses and releases. Its six tools
(`get_project_state`, `operate`, `screen_question`, `dismiss_signal`, `start_task`, `start_member`) live in
`mcp/operator/`; signal decisions and manager/Operator channels register in `api/operator.ts`.
This module needs no Effect program: retries belong to admission, reply relay uses
`background.run`, and the 60-second signal sweep runs in `kernel/sweeps.ts`; assembly
(`assembly.ts`) declares the sweep list.

The top right corner (PM-1042, decision 65) belongs to the project manager. `GET routes.projectManager`
returns a `ProjectManagerCorner`: the manager's channel plus, for the viewer, the requests and steps, the
signals and the manager's queue; a person who is not an owner gets `readOnly` and no signals or queue. The web
queue view reads `routes.memberQueue` for the manager. The machine grant is shown on the machine panel and
managed in Settings → Integrator. The Operator's own channel route is gone (PM-1045): the app has no Operator.

Personal conversational style (PM-688) lives in `services/operator/preferences.ts`.
`get_operator_preference` and `set_operator_preference` choose the person from the
authenticated Operator session and its current human request, or the selected active PM's
internal general session and open direct owner message/answer (PM-1021); they accept no person,
project or path selector. Guests gain only this personal write. REST exposes self reads
and owner/admin lists through personal logins, with no preference write route.
The session launcher requests only its current human's five enum fields through a
server port; signal and question-screening launches receive none. Guest contexts omit
member memory. Style is rendered as validated JSON data and grants no authority.
The PM shares the same per-person document and CAS with the Operator, with no owner fallback
in background rounds. Only direct current-owner message/answer/conversation launches receive
PM style data. Its overridable template style precedes project role and member instructions;
explicit style requests or corrections teach preferences, not a single technical question.

Shared approved agreement and principles (PM-689) live in `services/operator/knowledge.ts`.
Only an Operator owner message/answer can propose them. The inbox's registered
`operator_knowledge` decider accepts a human owner's own-login decision; the private CAS
shares `ProjectService.withConfigurationLock` with configuration commits. The inbox stores
the applying human before CAS, and the file stores the proposal marker with the new revision.
Startup completes only marked writes with that same human resolver. Rejected or stale proposals
write nothing. Agreement approval does not apply its recommended configuration operations or
replace their separate protected approvals. Internal PM general sessions may read the shared
document, but cannot propose or write it. Context carries only revision, agreement and principles
as JSON data below the fixed instructions, with no application markers or silent truncation.
An agreement's recommended operations are sent as a durable server-generated message with
`operator_knowledge_approval` origin. Delivery verifies the resolved inbox, matching applying human,
approved step and current owner/Operator before opening an idempotent `approval` request. That
request permits only `operate` with an exact stored operation; other writes require a fresh owner
message or answer. Startup retries undelivered continuations; a consumed one never reopens.

**Effect:** long-running parts (timers, queues, retries and shutdown) are Effect programs, each
behind a plain TypeScript facade, so nothing outside a module sees an Effect type. Modules with
an Effect program: `kernel`, `runtime/sessions`, `runtime/delivery`, `runtime/watchers`,
`runtime/usage`, `services/merges`, `services/full-tests`, `services/github`,
`services/project-docs`, `services/schedules`, `runner`, `worktree`, `full-test`.
The programs, their files and facades, the pinned version and the rules are in
[EFFECT.md](EFFECT.md); read it before touching or writing Effect code.

**Packages** (TypeScript source, used directly by both apps):

- `packages/shared` — the contracts: domain types, configuration schema and invariants, the
  duty catalogue, label and gate rules, owner-only changes, REST DTOs, routes, error codes and
  the websocket protocol (zod).
- `packages/templates` — factory project templates, role defaults and role views, standard
  label sets, member naming, legacy-configuration helpers, template locales.

**Server** (`apps/server/src`):

- `contracts/` — interfaces between modules and server/engine ports.
- `db/` — SQLite schema, migrations and repositories.
- `config/` — customization YAML, validation, migrations and git history.
- `logging/` — structured logs and rotating server and engine log files.
- `instance/` — installation identity and activation state.
- `kernel/` — shared helpers, Effect execution, periodic sweeps and merge locks.
- `agent-text/` — AI-facing wording for context packs and team tools.
- `core/` — the eight sealed core facades: base, projects, tasks, members, timeline,
  messages, inbox and attachments, with implementations inside each module's own folder.
- `assembly.ts` (`createDomain`) — the composition and event wiring (PM-648).
- `runtime/` — admission and handovers; session lifecycle, launch, rounds, compaction,
  provider limits, cleanup, policy, pause and workspaces; message delivery; command permission
  rules; health, machine and outage watchers; provider usage, quota and managed keys.
- `context/` — context packs, prompts, kick-off briefs and member memory.
- `services/` — merges, full tests and screenshots, releases, GitHub synchronization and
  publishing, feedback and widget sessions, project documents, schedules
  and Operator actions (the eight service modules).
- `runner/` — provider CLIs and PTYs, the input queue, session clocks, permission gate,
  hooks and their forwarder, transcripts, provider usage probes, trust and login checks.
- `worktree/` — task worktrees and branches, member workspaces and dependency refresh.
- `engine-host/` — local engine composition, session folders and roots, sandbox directories,
  files, screenshots, host operations and branch merging.
- `full-test/` — sandboxed test execution, screenshots and the heavy-run lock.
- `machine/` — OS machine probes and process parsing.
- `engine-link/` — server/engine RPC, transport, transfers and remote adapters.
- `api/` — REST routes.
- `mcp/` — team tool transport, definitions, module handlers, collector and shared `ToolCaller`.
- `ws/` — websocket transport and broadcasts.
- `http/` — HTTP request guards and infrastructure.
- `control/` — the administrative control socket.
- `auth/` — login, invitations and integrator credentials.
- `app.ts` builds the server; `engine-app.ts` builds the engine; `index.ts` reads the environment;
  `shutdown.ts` coordinates stopping.

**Web** (`apps/web/src`): React UI (board, task drawer, team and profiles, session chat and
terminal, inbox, messages, settings) with `api/` (typed client, queries, websocket cache),
`features/`, `components/`, `lib/` and `i18n/`; `mocks/` is the in-memory fake backend behind
the UI tests.

**Feedback widget** (`apps/feedback-widget/src`, PM-510): the embeddable marking tool, built as one
IIFE script (`dist/widget.js`, Vite library build, CSS inlined, at most 100 kB gzip: the build
fails over it) that the server serves at `/feedback/widget.js` (PM-509). Preact in a Shadow DOM
host, `@medv/finder` for selectors, `modern-screenshot` for the picture. It is not part of the web
app and shares nothing with it at run time; from `packages/shared` it takes types only (`import
type`: a value import would bundle zod). Modules: `controller.ts` (all state and flows: launch
code, session, refresh, targeting, sending; no markup), `api.ts` (the public widget API client),
`storage.ts` (the session token in `localStorage`, keyed by API origin and project key), `code.ts`
(reads and removes the launch code from the address), `anchor.ts` (the pure anchor lookup and the
list grouping), `selector.ts`, `screenshot.ts`, `environment.ts`, `ui/` (Preact views), `i18n/`
(the widget's own Hungarian text), `styles.css` (inside the shadow root). `dev/index.html` is the
test page: `npm run dev -w @projectman/feedback-widget` serves it on `127.0.0.1:5174`, a different
origin from the server, as on a customer's site. Remote engine: the widget runs in the visitor's
browser and talks to the server's public API only, so no machine-dependent part is added; the
server only reads the built file (`feedbackWidgetFile`, PM-509).

Pure rules (label refusal and label changes, gates, duty resolution, invariants, owner-only
changes) belong in `packages/shared`, so the server and the web's test fake use the same code.

## Storage

`PROJECTMAN_HOME` (default `~/.projectman`, mode 0700):

```
db.sqlite                 runtime state
secret                    cookie signing key; the e-mail login's HMAC key derives from it (PM-670)
secrets/nanogpt.json       installation NanoGPT key (0700 directory, 0600 file; PM-328)
customization/            git repo: projects/<KEY>/{project,team,pipeline}.yaml
memory/<KEY>/<handle>.md  AI member memory (durable learnings)
worktrees/<KEY>/…         git worktrees created for tasks
workspaces/<KEY>/<handle>/<repo>/{repo,cache,tmp}
                          member workspaces (PM-138, when on): durable independent clones,
                          never removed by projectman
instance.json             role of this copy (PM-143): absent = the active instance, `standby` or
                          `retired`; written only by a person with the move tool
migrated/                 what a move left (PM-143): the apply report, the old machine's pending
                          work, the carried transcripts; never read by the server
attachments/<KEY>/<TASK>/<id>   task attachments: private (0700 directories, 0600 files),
                          named by the generated id (the uploaded name lives only in SQLite);
                          a file still being written is <id>.part; an image or PDF
                          an agent asked for also has <id>.<ext> (a hard link);
                          an image's thumbnail is <id>.thumb (<id>.thumb.part while written)
feedback/<KEY>/<markId>.<ext>   screenshots of feedback marks (PM-506): private (0700 directories,
                          0600 files), named by the generated mark id; the WebP thumbnail is
                          <markId>.thumb (<name>.part while written); at most 2 MB, proven an image
                          by its content; served to processors only
message-attachments/<KEY>/<id>  files of team messages (PM-516): the same modes and names
```

SQLite tables: `users`, `auth_sessions`, `invitations`, `projects`, `counters`, `tasks`,
`task_links`, `timeline_events`, `sessions`, `team_messages`, `inbox_items`, `member_state`,
`schedule_runs`, `deferred_starts`, `attachments`, `member_workspaces` (one per project x member x
repository, with its reservation), `task_workspace_bindings` (a member's branch or review round of
a task in it), `task_review_pins` (PM-183: the commit handed over with the task's current review or
test stage); the feedback tables (PM-506, migration 55): `feedback_marks`, `feedback_events` (the
thread of a mark), `feedback_reads`, `feedback_marker_colors`, `feedback_launch_codes` (single use,
two minutes, kept as hashes) and `feedback_sessions` (the tool's sessions on customer pages, kept as
hashes); `member_queue_items` (PM-894, migration 98: one row per item in an AI member's queue, see "Member
queue"; not journaled); `sessions.execution_profile` (PM-141) is a column, not a table. Schema changes are numbered migrations in `apps/server/src/db/migrations.ts`;
the server refuses a database a newer build migrated.

**Handle columns (PM-1025).** Every column that stores a member handle is registered in
`apps/server/src/db/member-handles.ts`: either rewritten by a rename (`REWRITTEN_HANDLE_COLUMNS`,
`REWRITTEN_HANDLE_JSON`: tasks, messages, inbox, sessions, `member_state`, `member_queue_items`,
`task_workspace_bindings`, …) or deliberately not (`UNREWRITTEN_HANDLE_COLUMNS`: the storage keys,
e.g. `member_workspaces.member`, which hold the storage handle, and the append-only timeline). A
guard test (`member-handles-columns.test.ts`) fails when a new handle column is in neither list.
The rewrite is idempotent; at startup `MemberService.recoverRenames` completes a rename whose
configuration was saved but whose database step did not run.

## Member queue (PM-894)

Every AI member has one durable queue of what is waiting for them: a message, an Operator todo, a fix limit decision
(later slices add permission requests, signals, obligations and starts). Slice A (PM-894) stores and shows; slice B
(PM-925) adds the driver that wakes members from the queue (see "Driver" below).

- **Storage**: `member_queue_items` (`apps/server/src/db/member-queue.ts`). One row per (project, member, source type,
  source id), unique, so enqueueing twice is a no-op. Columns: `kind` (`message`, `todo`, `fix_limit`, ...), the `place`
  the member works it in (a card, or `general` = the member's desk with no workspace), `wake`, `state`
  (`queued`, `processing`, `done`, `cancelled`), the close reason, `attempts`, a wait code and the Operator's outcome.
  The contract is `packages/shared/src/domain/member-queue.ts` (`MemberQueueItem`, `MemberQueueView`,
  `nominalMessagePlace`, `memberQueueSourceId`).
- **Enqueue**: `core/member-queue` (`MemberQueue`). The two source repositories run listeners inside the transaction of
  every write (`messages.onPendingChange`, `inbox.onChange`), so a row commits with its source and no call site has to
  remember it. A message gets an item for each AI recipient it is pending for (a receipt without `deliveredAt`; the
  `team_message_pending` table is gone since migration 99); the item closes
  `done`/`delivered` on delivery and `cancelled`/`source_closed` when the receipt is settled any other way. Since
  PM-1045 the Operator gets no item at all: it runs no session in the app (`operatorRunsInApp = false`,
  `runsInApp`), so a message to it is refused (`operator_connected_only`) and an integrator todo or narrow fix
  limit decision stays an open inbox item, which the connected client reads through the super-mode tools
  (`open_integrator_todo`, `resolveIntegratorTodo`). Migration 121 cancelled the Operator rows that were open
  (the inbox items stayed). Both reconcilers are idempotent and a failure is logged and never changes what the
  source write does.
- **Invariant**: the open message items are exactly the messages pending for an AI recipient. `recover()` runs at
  startup (after `messageAttachments.recover()`) and fills in what is missing or closes what is stale; running it again
  changes nothing. The pending counts, `get_project_state` and the diagnostics read the queue.
- **Driver** (PM-925, `apps/server/src/runtime/member-queue/`): `MemberQueueDriver` exposes `ensure(projectKey, member)`,
  `sweep()` and `register(lane)`. Everything that could give a member work (an item queued, a turn over, a hold lifted, a limit gone)
  calls `ensure`, which works the member's queue by level under a keyed mutex (idempotent, one run at a time): items
  whose source no longer owes them are cancelled, items on a closed card go to the desk or end (`place_closed`), a hold
  puts its code on the item, a live session gets its items at the turn boundary, and the first waking item without a
  session starts one through `admission.start`. A refused start leaves the items queued with `wait` (code plus
  `wait_details`); there is no deferred-start row for it. The sweep (`DomainOptions.memberQueueSweepMs`, default 30 s,
  in the kernel's sweep list) calls `ensure` for every member with an open item, so a lost wake or a limit that lifted
  without an event is found at the next sweep. A lane (`MemberQueueLane`) says what its items are; the message lane
  delivers as before (receipt and item close together). Items a session works (`processing`) return to the queue
  when the session is gone, after `MEMBER_QUEUE_MAX_ATTEMPTS` they are handed off, and after 45 minutes the session is
  stopped. An old `message_wake` deferred-start row is read once (`ensure`) and deleted.
- **API** (`apps/server/src/api/member-queue.ts`): `GET /api/projects/:key/operator/queue` only (PM-1030 deleted the
  per-member and all-members routes; nothing called them). Access: a person's own login (developer or more) or
  an integrator read or super key. Legacy keys fail authentication with 401 (PM-1037). The route stays for the old Operator rows and is empty for a project after migration 121.
- **WebSocket**: `member_queue_changed {projectKey, member}`, once per member per unit of work. Clients do not see it.
- **Remote engine**: no machine-dependent part is added. The queue, the driver and the sweep live on the hub with the
  database; only the session start crosses to an engine, as before. A member whose engine is offline waits with
  `engine_offline` as the item's wait, and the sweep starts it when the engine is back.

## Durable super-mode handoff (PM-762, part of the super mode PM-757)

The Operator's queue handoffs (PM-1003) use the existing integrator inbox: `no_grant`, `no_typed_operation`
and `processing_failed` leave machine work there, with `payload.operatorHandoff` describing the action and
context. The super client lists it through `list_integrator_inbox` and resolves it through
`resolve_integrator_todo` or `resolve_integrator_fix_limit` (MCP, including the CLI proxy). With no super
client running, it waits; held cards remain held. Operator leave or AI being off does not send this work to
the owner (`integratorSideAvailable` checks only that an Operator exists). Only `owner_reserved` goes to
the owner, using the operation's existing question when available. The queue outcome records
`handoff.to` (`super` or `owner`; missing on old rows means owner). The web shows a short outcome, without
an owner inbox link for super work; no extra owner notification or badge is created.

`request_super_operation` (the base Operator, in its own general conversation during an open owner request;
retired by PM-888, whose `execute_operation` runs the command directly, see "In-app Operator on the shared path"
below; the schema and the stored handoffs stay) stores a `SuperHandoff`: one `SuperCommand` of a closed set (`operate`, `member_update`, `invite_create`,
`merge`, `merge_order`, `administration`), a reason and, optionally, the configuration version it was made
against. It grants no execution right and no approval. The integrator lists the handoffs (`GET
…/operator-super/handoffs`) and starts one with the `execute_super_handoff` MCP tool (there is no REST execute route,
PM-1030), authenticated by the owner's super token; one `(project, token, request id)` is one `SuperOperation`, so a retry
returns the same record and a different command under the same id is 409 `super_request_conflict`.

The server classifies the command itself (`superCommandEffects`, a projection onto the closed mutation list of
PM-759; what cannot be classified is refused). With no deletion, security or cost effect it runs on
the integrator's own power. With one, the operation waits (`waiting_owner`) and an owner question carries
`payload.superOperation = {operationId, commandHash, expectedConfigVersion, expiresAt}`; only the owner's own
login answers it (not the token, not a relay), within 24 hours. After a yes the integrator executes the same
request id again; the service verifies the config version, the command hash and that the same token is still
valid (stale: 409 `super_operation_stale`) and opens a grant for that one command only. A no cancels it
(`owner_declined`); an expiry cancels the operation and frees the handoff. After a restart a running operation is
`unknown` and never started again by itself.

The relay (`POST …/inbox/:id/relay-answer`) lets the integrator give the owner's words as the answer to an open
question the asker marked as plain information (`ask_human` `response_purpose: "information"`). It is marked
`ownerAnswerRelayed`, is not an owner decision and never reaches the decision candidates. The rule lives in
`services/super-operator/relay.ts`; the REST route and the MCP tool `relay_owner_answer` (PM-760) both call it.

### In-app Operator on the shared path (PM-888, decision 55)

The in-app Operator uses the same path as a super-mode key: `execute_operation {request_key, task_key?, command}`
(not `operate` or `member_update`, which keep `operate`), `get_operation`, `get_machine_status` and `get_machine_logs`
(Operator tools, in the Operator's own general conversation during an owner message or answer; guests and the other
members are refused). They call `SuperAdministration`, `SuperOperator.execute` and `SuperHandoffService.operate`, so the
rights check, the audit, the owner question for a K3 effect and the machine grant (`operator_grant_inactive`) are the
key path's, not a copy.

- **Credential.** There is no stored key. `services/super-operator/app.ts` issues an `IntegratorPrincipal` with
  `source: 'app'`, `prefix: 'operator-app'` and `keyId` = the Operator session id, acting as the first owner (by
  handle) with a user account. The authority wrapped around the key authority accepts an app principal only when it
  was issued there (a `WeakSet`) and `OperatorAppSessions.active` holds: the session is live, it is the Operator's own
  general conversation (no guest) and an owner message or answer request is open. Otherwise `insufficient_access`.
- **Idempotence.** The request id of an operation is a UUID v8 from the first 16 bytes of
  `sha256(operatorRequestId:request_key)`, so a retry in the same request is the same operation.
- **Owner's yes.** The operation waits (`waiting_owner`) with the usual question. After the owner's own login says yes,
  the `inbox_resolved` event calls `SuperHandoffService.resumeApprovedAppOperation`, which re-runs `operate` under an
  approved app principal (no live session needed; the yes, command hash and config version are checked again).
- **Step log.** `OperatorAction` has `operation`; `operator_steps.operation_id` (migration 96) links the operation.

**Does this work on a remote engine?** The whole path runs on the hub; a machine operation reaches an engine through the
existing administration port. No new machine-dependent part.

## The external MCP endpoint (PM-760, part of the super mode PM-757)

`POST /mcp` (no token in the path) is the integrator's MCP door: a bearer `pmi_` key, HTTPS or a local connection,
no login, no session and no engine. The member door `/mcp/:token` is separate and unchanged (a session token, a local
connection, `ToolContext` with a `sessionId`).

- **Stateless.** The SDK `WebStandardStreamableHTTPServerTransport` runs per request with no session id, over the SDK's
  low-level `Server` (`mcp/super-operator/server.ts`), so an unknown or forbidden tool is a domain denial and not an
  `isError` text. `GET` and `DELETE` are `405` with `Allow: POST`. The route (`mcp/super-operator/route.ts`) requires the
  `request.principal` the root auth hook resolved (`resolveIntegratorCredential(secret, 'mcp')`); a missing, wrong, expired,
  revoked or over-HTTP key is `401` (`integrator_key_invalid`, `integrator_https_required`), never the member door's `404`
  and never a `200` with an error text, also for a batch element and a notification. The key is re-read in each tool call
  (`assertActive`); a key found revoked in the middle of a request turns the whole answer into `401`. The `Authorization`
  and `Cookie` headers are removed before the request reaches the SDK (`requestInfo`) and nothing logs a body or a header.
- **Its own context.** `ExternalToolContext = {principal, projectKey, actor, requestId}` (`contracts/team-tools.ts`) has
  no `sessionId`; `ToolContext` is not changed. The shared tool definitions get a caller adapter: a definition is
  **denied by default** until it carries an explicit `external` binding (`mcp/kit.ts`: modes, read or write access, the
  project and card argument). `mcp/super-operator/registry.ts` lists the served tools (`EXTERNAL_TOOLS`) and the denied
  shared ones with the reason (`EXTERNAL_DENIED`); a test checks that every shared tool is exactly one of the two.
- **Project switching is stateless.** Every project tool takes a required `project_key`; `list_projects {}` returns the
  projects where the key's holder is an owner at this moment. An unknown project and one the holder does not own are
  refused alike (`insufficient_access`). `tools/list` is filtered by the key's mode (`super`, `read`); a forbidden
  tool called directly is refused by the same table (`integrator_not_allowed`, `integrator_read_only`).
- **Same right, same audit.** A call runs through `SuperOperator.execute` (`super` and `read` keys: the REST scope; `super`:
  the audit row `mcp_<tool>`). Legacy keys fail authentication with 401 (PM-1037). The super tools
  (`list_super_handoffs`, `execute_super_handoff`, `super_operate`, `get_super_operation`, `query_super_diagnostics`,
  `get_administration_status`, `get_administration_logs`, `get_machine_snapshot`, `relay_owner_answer`) are `super` only and answer with structured
  JSON plus the domain `errorCode`.
- **Entrance.** The tunnel and proxy rules pass `/mcp` and refuse `/mcp/` and `/hooks` (`^/mcp/` in
  `scripts/cloud/cloudflare.ts` and `deploy/cloudflare/config.example.yml`); the root auth hook treats `/hooks/` and `/mcp/` as
  literal prefixes so no spelling opens the member door to a bearer. [DEPLOY.md](DEPLOY.md) "The integrator's MCP endpoint".

**Does this work on a remote engine?** The endpoint, the key check and the audit run on the server and nothing of them
crosses to an engine: the tools call the same domain facades as the REST routes. A tool that needs an engine (the
administration status and logs, a diagnostics run) uses the engine path the matching REST route uses; the key is never sent
to an engine.

## Super-mode diagnostics, test and build (PM-764, part of the super mode PM-757)

The integrator (a super token, an owner's access) reads and starts what it needs to prepare a release, every call
bound to the project and to an engine linked to it. The MCP tools `get_administration_status` (`target=hub|<engineId>`)
and `get_administration_logs` (`limit` at most 200) answer from the supervisor's sanitized view
(503 `administration_unavailable` where the instance has no adapter, 403 `administration_target_mismatch` for an
engine that is not linked); the REST routes were deleted in PM-1030, nothing called them. The `query_super_diagnostics` tool reads a closed
catalogue by name (`tasks`, `sessions`, `merges`, `operations`), each with the fixed columns of
`SUPER_DIAGNOSTIC_COLUMNS`: there is no SQL, no table or column argument, and no user, key, secret, inbox text or
personal data in any column. `POST …/operator-super/operations {requestId, taskKey?, command}` starts a
`SuperCommand` at once (202 `{operation}`), with the same checks, the same owner question and the same registered
executor as a handoff's operation; `GET …/operations/:id` answers `{operation, result}`.

The `administration` executor re-checks everything directly before it starts anything: the key is still active, its
owner still owns every affected project (a hub restart or a deploy needs every project of the instance), the engine
is linked, the commit is one of the card's, and a deploy's release is the one a human owner approved (otherwise
409 `release_state_conflict` / `release_target_mismatch`). A revoked key therefore starts nothing further and undoes
nothing already done. It submits the strict command to the protected adapter and returns `{pending: true}`: the
operation stays `running`, and a registered settler finishes it from the result the supervisor recorded (only
`inspect`, never a second `submit`, so a restart or a second reader cannot run it twice; a record that cannot be
found is `unknown`). A finished full test also lands on its card as `task_full_test` (outcome, run id, commit,
duration, failed files; no output) and `super_operation_changed {operationId, state, resultKind}`; it writes no
approval label and does not replace the merge's own mandatory test. A quick fix or a release keeps every human
gate: the super actor can propose a release but not approve it. The common operation executors (PM-882,
`services/super-operator/commands.ts` and `operate.ts`) call the task, admission, merge, configuration,
member, invitation and credential domains as the bound Operator. A created card's key is recorded on the
operation, and retries return that same result. Owner-reserved effects wait for the owner's own answer;
an approved operation resumes only against its pinned configuration. Fixed Operator fields are refused
before opening a question (`operator_fixed`), including role instructions; changes to its model, provider
or effort require an owner answer. The final configuration commit applies the same shared projection to
direct super writes. Login methods, key creation, the waiver, the NanoGPT key and super-rights management
remain owner-login-only; `inbox_resolve` reserves its command shape for PM-883. The executors run on the hub;
merge work uses the existing engine boundary.

## Project change journal (PM-761, part of the super mode PM-757)

A durable, cursor-read record of what changed in a project, for the integrator's readers (and the
members' tools) to continue after an interruption or a restart of the hub. It says **that** something
changed and **which entity**; the content is read from the normal APIs. Nothing raw is stored: no terminal
text, chat text or secret, only ids.

- **Table.** `project_change_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, project_key, kind, entity_id,
at)`, index `(project_key, seq)` (migration 81). `seq` never goes back, also not after a delete of the
  newest row. Kinds: `task`, `timeline`, `message`, `inbox`, `configuration`, `pause`, `engine`,
  `handoff`, `operation`. No row is deleted automatically (a journal that forgets cannot tell a reader
  that it missed something).
- **Atomic with the change.** SQLite triggers on the state tables (`apps/server/src/db/change-triggers.ts`,
  the list in `CHANGE_TRIGGER_TABLES`) write the row in the transaction of the very statement. Many
  facades publish to the websocket after their write and outside a unit of work, so a row written from
  the bus would not be atomic; a trigger covers every write path (a facade, a sweep, the recovery of an
  interrupted configuration commit, which ends in the `projects` record update). A rollback, also of a
  nested unit of work, takes the row with it. A trigger writes only the metadata (project, kind, entity id,
  time), never a rule and never content.
- **Coverage matrix.** `CHANGE_TRIGGER_TABLES` lists the tables the card's read model is made of, with the
  statements that announce, the project and the entity: the card and its side tables (links, attachments,
  covers, fix limits, hand-ons and hand-overs, review pins, loops, waits, deferred starts, full-test runs,
  focus items) name the card key in kind `task` (a link names the card's project through the card, a
  card removed by a cascade is announced by its own row); `timeline_events`, `team_messages`,
  `message_attachments`, the inbox and its question groups, `task_handoffs`, the operator requests and
  their steps (the step names its request and the request's project), the super-operation audit,
  merges, merge trains, releases and doc writes have their own kinds; a pause of the whole
  instance is written for every project. `UNJOURNALED_TABLES` names every other table with the reason
  (credentials, login, usage, machine-local bookkeeping, Operator bookkeeping, the journal itself).
  `test/project-change-journal.test.ts` fails when a table is in neither list, in both, or a name is
  stale, so a new table makes someone decide. A migration that rebuilds a covered table drops its
  triggers and must create them again (the same test); a new state table needs a migration that calls
  `changeTriggerSql`.
- **Configuration.** The configuration is git's; the `projects` record carries its version
  (`config_version`). The `configuration` entry (entity `null`) is written when a project is created and
  when the record gets a **new** version, whichever path writes it (a commit, a revert, the sync from the
  store, the recovery of an interrupted operator execution or audit). A path that finds the record already
  at the version, or changes only its name or time, writes nothing, so a recovery that runs again does not
  repeat the signal. A git commit followed by a crash before the record update is finished by the existing
  reconciliation (`syncFromStore`, `recoverOperatorExecution`, `settleSuperAudit`), which writes the entry
  in the transaction of the record.
- **Engines.** `engine` entries name the engine registry's changes (`EngineRegistry`,
  `runtime/sessions/engine-registry.ts`): the registry's write (create, revoke, set the default, the first
  sight of an engine and a changed hello) and the entries of the projects it concerns are one
  `repos.transaction`. An engine concerns the projects with a session stored on it and, while it is the
  default (before or after the write), every project, because new sessions go to the default. The online
  flag is memory and a heartbeat of the last-seen time is not a change; neither is journaled (the journal
  is never trimmed, so a heartbeat every minute would grow it for ever). The registry wakes the readers
  after the commit (`useJournalWake`).
- **The wake only notifies.** `ChangeJournal` (`core/base/change-journal.ts`): waiting readers are woken by
  the domain event bus (any event with a `projectKey` but the noisy ones: member state, plan usage,
  chat), by `record` and `notify`, and by a one second safety read of the database while a wait is open; a
  reader always reads the database. A reader reads, subscribes, and reads again, so a commit in between is
  not missed. `record(projectKey, kind, entityId | null)` is for a change no trigger covers; a path a
  trigger covers does not log a second time.
- **Reading.** `GET /api/projects/:key/events?after=<cursor>&limit=100&waitMs=25000` answers
  `{events, nextCursor}`; `limit` 1..500, `waitMs` 0..25000, no `after`: from the start of the journal. The
  cursor is base64url JSON `{version:1, generation, projectKey, seq}` with `seq` as a decimal **string**
  (no number precision loss); a malformed cursor or one of another project is `400 invalid_event_cursor`,
  one of another generation (or past the end of this journal) is `409 event_cursor_expired`. The same cursor
  works after a restart: the generation is a UUID stored in `instance_meta` under
  `project_change_generation`, made once with the database (migration 81) and never changed by a restart.
- **Access during the wait.** Every member (PM-79: a client reads like a viewer). The credential and the
  membership are checked again on every wake and before the answer: a key revoked or expired during the
  wait gets `401 integrator_key_invalid` at once (revocation wakes the waiter, expiry has a timer), a
  member who lost access gets the refusal instead of entries. A stopping server ends the waits with
  `server_stopping`.
- **Restoring a snapshot.** A database restored from an older copy must get a new generation
  (the `UPDATE instance_meta … WHERE key = 'project_change_generation'` in `docs/AWS.md` and
  `docs/HYBRID.md`; replacing it is mandatory); the restore steps there say so. Without it a cursor from the lost journal could
  continue into a different history (a cursor past the end of the restored journal is refused anyway).

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

For Claude members (PM-165) the mode goes to the CLI as it is, and the runtime permission broker answers
what the CLI still asks: `commandVerdict`, then the approver (`human`: the inbox; `none`: an
immediate refusal with no inbox item, a `permission_refused` event `by: 'approver_none'`; `ai`: the
AI decider of PM-169, below). The auto mode's own refusals arrive as the
`PermissionDenied` hook, through `PermissionBroker.refused`, as `permission_refused` `by:
'classifier'`. The hard denials (credentials, the live instance's data, `WebFetch` of localhost,
publishing) are deny rules computed in `runtime/sessions` (`session policy`) and rendered in `--settings` by
the Claude adapter; see `PROVIDERS.md` for the server-side decisions and their reasons.

`runtime/sessions/permission-broker.ts` owns CLI permission decisions (PM-960).
Assembly creates it with the inbox, projects, timeline, domain context, engine directory and
attachment-directory callback. It uses `engineIdOf`, `readableRootsFor` and `commandVerdict`
directly within runtime, checking the tool working directory's canonical paths on the session's
engine before applying the command verdict. `core/inbox` owns item creation, closure, publication,
waiters (`waitForClose`) and delegation; the former `InboxPermissionPolicy` port is removed.
The permission broker and engine contracts, decision order and synchronous waiter registration
are unchanged.

**The AI decider on the host (PM-169).** With approver `ai` (and the owner's `team.boundary.enabled`) a
question the CLI still asks goes to the AI members holding `boundary_authorization`, not to the sponsor:
the routing rule (`routePermissionRequest`), the owner's categories it never delegates
(`permissionOwnerCategory`: publishing, release, live instance, credentials, lasting host changes) and
the one rule for who may answer (`canDecidePermission`) are pure rules in `packages/shared`; the item is
a `permission` inbox item whose `payload.delegation` carries the decider(s) and the lead deadline. The
decider is woken by a team message and answers with `decide_permission_request`
(`InboxService.resolveDelegated`: `allow` and `deny` close the item in its name and answer the waiting
hook, `escalate` hands it to the sponsor or owners). A deadline, a decider on leave or delegation
switched off do the same in `sweepDelegations`; nothing is ever an allowance by itself.

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
and are typed in after the restart, which gets no continue message. Grants "for this session" die with the process:
`permissionGrantsLost` says so in the header. Each change is a `session_permission_changed`
timeline event (the owner, `field`, `from`, `to`, `reset`, `restart`).

The Operator's approver stays `human`, with source `member` (PM-691), even with a historical
`none`/`ai` member setting or any session override. `SessionPermissionMember` preserves its identity
for `isOperator`; ordinary and missing members retain their session settings. The shared
`sessionApproverChangeRefusal` rejects Operator `none`/`ai` updates with 403 `operator_fixed` before
any write, restart or event; `human`/`null` clears the override. Mixed mode/forbidden-approver patches
are atomic. Starts, resumes, permission routing and the session header use the same effective rule.

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
`runtime/sessions` (`session policy`), from the policy's actual paths; the runner gets it as
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
built-in file tools. Codex renders the sensitive-path denials and portable writes through its
own permission profile (PM-356; readers receive no write entries).

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

The hybrid move tool (`scripts/migrate/`) inventories a stopped local source, writes a checksummed
cloud package and prepares the Mac engine identity. Source repositories, worktrees and CLI
transcripts stay on the Mac. The return path restores final cloud data before activation;
[HYBRID.md](HYBRID.md) documents the procedure and rollback. VM packaging, path remapping and
repository restoration were removed in PM-1033; legacy migrated homes retain their activation checks.

## Review at a pinned commit (PM-183, part of PM-176 rule 1)

A task that enters a step or release stage a reviewing or testing duty belongs to
(`stageHandsOverForReview`, the set that gets the `review_copy` placement) is **handed over**: before the move,
`TaskMoves.prepareMove` (which also decides whether the merge is checked, see "Merger setting") reads the head of the developer's branch through `SessionOrchestrator.sourceHead`
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

## Full test before review (PM-217)

The developer's sandbox cannot open a pseudo-terminal, so the server's PTY tests (`*.integration.test.ts`,
`golden-path-*`) never run before a review. A repository that sets `reviewTest` (`{command, maxWorkers = 2,
timeoutMinutes = 15}` in the project's configuration; absent: nothing below happens) gets a **full test** of the
commit pinned at the hand-over, run by the server.

- **Queue.** `FullTestRuns` (`services/full-tests/full-tests.ts`) queues a run (`full_test_runs`, migration 32) when the
  review pin is saved (the stage change) or a new round re-pins (`repinReview`, on the developer's message to a
  reviewer), and drops the queued or running run of an older pin or of a stage the card left (`cancelled`:
  `repinned`, `stage_left`; `branch_moved`, `interrupted` at a restart, `shutdown` at a stop). One run runs at a
  time in the whole installation, first in first out, under `nice -n 10` (set on the process that starts
  srt, outside the sandbox: Seatbelt refuses `setpriority` inside it; the sandbox and the command inherit it).
  The scoped Effect core (`services/full-tests/queue.ts`, PM-601) drains the durable FIFO and
  interrupts steps cooperatively: the aborted executor call settles before the next step starts.
- **Executor.** `src/full-test` (`FullTestExecutor` in `contracts/full-test.ts`) writes the srt settings
  (`fullTestSandbox`: reads the checkout and the configured repository's git directory only, writes its run
  directory `<tmp>/pmft-<end of the run id>/` only: srt's own default temporary directory, `/tmp/claude`, which it
  opens on its own and the members' sandboxes share, is in `denyWrite`; no network except listening on local ports, `allowPty`;
  Unix sockets only below the run's own `tmp` — `network` is exactly `allowedDomains: []`, `deniedDomains: []`,
  `allowLocalBinding: true`, `allowUnixSockets: [<run directory>/sandbox/tmp]`, `allowAllUnixSockets: false`
  (the path prefix of srt 0.0.78's macOS generator; the installer's and the screenshot runs' network profiles
  get no socket permission). The directory is short and measured in bytes (UTF-8) on the canonical
  paths: `runDirOf(tmpRoot, shortRoot, runId)` takes roots the caller resolved with `canonicalRoot`
  (`realpath`: `/var/folders` is `/private/var/folders` on macOS, which a socket path is checked against), and
  a root is used only when its `tmp` and `home` below the run directory leave at least 40 bytes (the separator
  included) within 100 bytes (macOS's socket path limit is 104; srt's `srt-mux-<pid>-<n>.sock` is 24 bytes with
  the separator, the control socket's `control.sock` 13). Otherwise the directory is under `/private/tmp`
  (`pmft-<end of the run id>`), whose frame is checked the same way; when neither root has room `runDirOf`
  throws and the run ends as `sandbox_unavailable`, with no wider permission or longer path. This is the
  code's profile: it says nothing about the running installation, which gets it only with a separately
  approved engine update; the real socket behavior is proved by the socket integration tests (PM-754) after
  that), runs `<command>` there (srt's `-c`, with
  its standard input closed by `exec </dev/null;`, because srt hands the command its input through a socket,
  and `script`, so a PTY, fails on a socket; srt also sets the command's `TMPDIR` from `CLAUDE_CODE_TMPDIR`,
  or a `/tmp/claude` that does not exist, so `fullTestEnv` sets it to the run's tmp) with
  `VITEST_MAX_FORKS` and `VITEST_MAX_THREADS` set to `maxWorkers`, kills the process group at the time limit
  and reads vitest's failed files and "Failed Tests" section from the output. Without macOS or `srt` the
  executor is not available and the feature is off.
- **The hold.** While the current pin has no result (`FullTestRuns.holds`) the reviewers do not start (the
  hand-over's deferred start waits with `full_test_pending`) and the developer's messages to them are stored
  (`Messaging.heldForFullTest`); a person's message is not held. `TaskReviewPin.fullTest` shows the state.
- **Green.** The reviewers start; their brief and resume message say the full test passed, so they need not run
  the tests or the type check again. On another hand-over of the same commit, the latest earlier verdict is
  reused if it passed: no new run or `task_full_test` event is made, reviewers do not wait, and
  `reviewPin.fullTest` keeps the original result time. Earlier failed or error verdicts are retried;
  a new commit gets a new run. **Error** (could not run: timeout, no sandbox, no PTY, dirty checkout, …):
  nothing is sent back, and the brief says the reviewer must run the checks itself. **Failed:** the card goes
  back to the work stage before its stage (`task_stage_changed.testsFailed`, a fix round in the round count),
  the reviewers' sessions stop and the developer gets a system message with the failed files and the output.
  Every result is a `task_full_test` timeline event. A branch that moves or a dirty checkout while the run
  waits or runs never produces a verdict (`branch_moved`, `checkout_dirty`).
- **Tests.** The domain logic is tested with a fake executor (`test/full-tests.test.ts`); the real sandbox
  only in `test/full-test-sandbox.integration.test.ts` (macOS). It cannot start a nested sandbox,
  so it is skipped when `PROJECTMAN_FULL_TEST_SANDBOX=1` and runs outside the sandbox before
  every live deployment (PM-493, `release-test`).

When the executor is available and the task's repository sets `reviewTest`, `FullTestRuns.runsFor`
sets `ContextPackInput.serverFullTest` in the session brief. Implementation and maintenance steps
then ask only for targeted tests and the type check of touched parts while working: the server runs
the configured full command on the handed-over commit, PTY tests included. Otherwise the steps ask
for targeted tests while working and one full test and type check on the handed-over commit.
A repository can set `fullTestAtMerge: true` to delegate the full check to its integrating session
or merge step (PM-380): developers and maintainers then run only related tests and the type check of touched
workspaces, including at hand-over and in fix rounds. In PM, the merger uses `merge_task`; the
server runs `npm run merge-test` in the full test sandbox, in the machine's heavy-run queue,
before the default branch moves (decision 40, PM-386). Other projects retain their existing default
(absent or false). With `fullTestAtMerge: true` the
repository's `reviewTest` runs only at the merge (PM-386, PM-489): `reviewTestBeforeReview` is false, so
`reviewTestOf` finds no test, nothing is queued or held before review and the context carries no
`serverFullTest`. The merge step (`Merges`, "Merge (PM-452)") runs the command once on the merge result
before the default branch moves; a repository that merges but names no `reviewTest` blocks its merge
(`check_unavailable`). Where `requiresMerge` is true the context says the merge step runs the full check;
where an outside integrator merges (`fullTestAtMerge` without `requireMerge`) it keeps the integrator
wording. Reviewers without a server result receive instructions to run only targeted tests.
No machine boundary changes: the check runs where the integrator or the merge runs. Dependencies are
installed only when missing from the working directory.

**Where the review test runs (PM-909).** `reviewTest.beforeReview` (`off`, `engine` or `github_actions`) chooses
the runner of this pre-review test independently of `reviewTest.runner`, which stays the merge check's. Absent:
`engine`, or nothing when `fullTestAtMerge` is set (`reviewTestRunnerBeforeReview`, `reviewTestBeforeReview` in
shared). `github_actions` needs the repository's `github` (`review_test_runner_github`, at the path `reviewTest.beforeReview`; at run time the lack
of it ends the run as `github_unavailable`) and, like `runner`, changing it is an owner-only `review_test` change.
`FullTestRuns` stores the run's `runner` (migration 103) and its `external_url`; a GitHub Actions run needs only an
engine with a full test executor (no sandbox, no `srt`, no heavy-run queue, no local checkout) and builds the same
`full_test.run` spec as the merge check with `githubActions.all = true`: the workflow's `all` input runs the whole
suite on four shards (`merge-test -- --all --shard k/4`) and the verdict is judged by `fullScopeProblem`, which
refuses a run whose shards did not cover the full suite. The queue stays sequential: one run at a time, GitHub
runs included. The result, the run page (`TaskReviewPin.fullTest.externalUrl`, the `task_full_test` event) and
the reviewer's brief carry the runner; an error (`github_unavailable`, `engine_offline`, `github_run_error`)
releases the review with no local fallback. A change of the runner cancels the run (`configuration_changed`;
`config_changed` triggers `syncAll`) and queues a new one for the new runner. The merge never reuses a GitHub
Actions review result: its reuse is limited to `engine` runs, so the merge runs its own check.

## Merge (PM-452)

The system requests a merge; the member selected by `cardMerger` starts it with `merge_task`,
`POST /tasks/:taskKey/merge`, or the human inbox request. An authenticated super Operator may also start
a normal merge (PM-882); conflict fix checkouts and resolution submissions remain the merger's.
`mergeReadiness` and `mergeRepoOf` in shared
configuration rules determine readiness and the forward moves that need the approved commit on the
default branch. The source is the persistent handover (`task_handovers`, migration 47), then the review
pin, then the card's clean branch head. A client reads `Task.merge` and `Task.merged` like any member (PM-79).

`services/merges/` (PM-600; `Merges` in `merges.ts` is the facade, exported by `index.ts` with `MergeCardLock`)
persists requested, queued, running, failed and blocked states in `task_merges`,
with one running merge per project/repository in FIFO order. The slot is an Effect program
(`queue.ts`, `makeMergeQueue`: a `FiberMap` keyed `projectKey:repo`; `docs/EFFECT.md`); the merge itself is
the sequential async program of `steps.ts` (`MergeSteps`), which stops at its own checkpoints when its
abort signal fires (`kernel/effect.ts` `abortable`: an interrupted slot is free only after the merge settled
and released its check worktree). `notify.ts` holds the messages to the merger, `ports.ts` the structural
interfaces to the sessions, the slot peer and the check sandbox. The tools `merge_task` and
`prioritize_merge` are `mcp/merges/`, the two routes `api/merges.ts`. The card engine's `BranchMerger` prepares
the base, validates linked PRs, builds without changing the base, checks local checkout conflicts,
runs or reuses the approved commit's full check, checks readiness again, pushes and advances locally.
The check goes through two steps (PM-489): `check_waiting` while the full test waits for the machine's
heavy-run queue (PM-332), then `checking` when the executor reports that the run holds the lock
(`FullTestExecutor.run`'s `onStarted`; on a remote engine the `full_test_started` event, sent by the
`full_test.run` handler like `screenshot_started`). An engine that does not send the event leaves the step at
`check_waiting` until the run ends; a reused passed run goes straight to `checking`. A repository with
`fullTestAtMerge` and no `reviewTest` blocks (`check_unavailable`): nothing merges unchecked.

A lost engine link is waited for up to 15 minutes per loss, at most five losses per merge
(PM-791, PM-777). The repository slot stays occupied while other repositories can proceed.
`engine_waiting` replaces the card's visible steps; train manifests retain their last durable
step. A remote check follows its run with `full_test.attach` after reconciliation, including
replayed start events. If an engine restarted or cannot attach, a new attempt recreates the
check checkout only after PM-790's cleanup invariant stops the old test. Other lost merge
calls restart from prepare and recover an already published candidate before building again;
the publication flag is retained. Shutdown aborts the wait through the merge signal and requeues
unpublished work; a merge already pushing retains its durable publication recovery for startup. A timed-out
wait or repeated losses block with `engine_offline`; no database migration is needed.

**Where the check runs (PM-900, PM-906).** `reviewTest.runner` (`MergeCheckRunner`: `engine`, the default,
or `github_actions`) chooses it per repository; the merge check only (the review test is untouched), and
changing it is an owner-only `review_test` change; the pre-review test has its own `beforeReview`
(see "Full test before review", PM-909). `github_actions` needs the repository's `github`
owner/name (`review_test_runner_github`; at run time the lack of it blocks `check_unavailable`). In that
mode the hub makes **no local check checkout, takes no heavy-run lock and prepares no dependencies**: the
one helper `prepareMergeCheck` (`services/merges/check-preparation.ts`), used by the single-card merge
(`steps.ts`) and by the train group check and lone diagnosis (`train.ts`), releases any checkout of the
merge and builds the same `full_test.run` spec with a `githubActions` descriptor (`GithubActionsCheck`:
ref, `mergeId`, `owner/name`, base branch, merge commit, the `merge-check.yml` workflow and, for a lone
diagnosis, the failed files, at most 20) instead of `requireHeavyLock`/`npmCi`; the `cwd` is only a label
(`github-actions:owner/name`). The executor of the card's engine runs the workflow and answers with the
usual `FullTestResult` plus `externalUrl`, the run's page (the engine side is PM-907; the local executor and an
older engine refuse the descriptor with `github_unavailable`, a run that stopped with no result is
`github_run_error`). Both are operational errors: the merge or train blocks, nothing is split or blamed.
`endChecksIn` also stops a descriptor run by its `mergeId`, as the merge has no checkout path to match.
A train groups only cards of the same runner (`train-selection.ts`). `merge_check_runs` records the
`runner` and the `url` (migration 95); `list_merge_checks` shows both.

`task_merged` stands on the member who started the merge (`startedBy`, `{ kind, handle }`); a merge found
already in the default branch stays a system event.
Conflicts and failed checks notify the merger and keep the card in place; a failed check tells an AI merger
to send the card back (a fix round) if the card caused it, or to retry once and then ask a human. Operational failures notify
the AI merger or create an alert for the human merger. Calling the same tool retries under the same id.
Success records `Task.merged` with `via: tool`, then asks AutoAdvance to check the ordinary move rules.
The merger never moves the card itself. Every forward move path checks the default branch before the
transaction, including approvals and hand-on requests; manual merges discovered there are recorded
with `via: found` when a persistent handover exists.

**Queue order (PM-576).** One merge runs per repository (the full check runs on main merged with the card, so
a second one in parallel would check against a stale main), but the order of the waiting ones is a member's
decision, not the server's: by default it is the order of the requests (`task_merges.created_at`, `rowid`; a
retry keeps its place). The queue reads `ORDER BY prioritized_at IS NULL, prioritized_at DESC, created_at,
rowid` (`QUEUE_ORDER` in `db/task-merges.ts`; `prioritized_at` is a nullable column, migration 58, and
`created_at` is never rewritten). The card's merger or the Operator (in an owner's request, step `task_update`)
calls the team tool `prioritize_merge { task_key, reason }`, an owner does the same with the "Előre" button of the
queued merge box (`POST /api/projects/:key/tasks/:taskKey/merge/prioritize`, body `{ reason }`); both land in
`Merges.prioritize`: it allows the card's merger, an owner and the Operator only, takes a `queued` merge only
(`merge_not_prioritizable` otherwise), sets `prioritized_at`, writes `task_merge_prioritized` (`mergeId`, `repo`,
`reason`, `ahead`: the keys of the queued cards it went ahead of) on the card with the caller as its actor, and
pumps the queue. The mark is cleared when the merge starts running. A merge already first changes nothing (no
event). The running merge is not interrupted. Remote engine: the queue is on the server and the engine is not
involved; no new machine-dependent part.

**Durable train foundation (PM-659, part of PM-652).** `db/merge-trains.ts`, exposed as
`Repositories.mergeTrains`, stores a Zod-validated manifest in `merge_trains` (migration 60).
Its SQL identity, project, repository and state match the JSON record. A unique partial index
allows one `running` train per project/repository. The manifest keeps 2–8 unique members in
fixed order, their source commits/branches, starting members and timestamps, and the optional
priority snapshots, check, candidate commits and parent train. It starts `running` at
`merging`, landed `nowhere`; later `landed` may also be `remote` or `local`. The nullable
`task_merges.train_id` maps to internal `MergeRecord.trainId`; older rows stay null and neither
`TaskMergeState` nor `TaskMerged` exposes it. Train and member writes share the existing
`unitOfWork` transaction, so a failed reservation rolls them all back.

`services/merges/train-selection.ts` exports the pure `selectMergeTrain`: the caller supplies
queued candidates in the existing `QUEUE_ORDER`, with readiness and solo facts already evaluated.
It takes only the compatible prefix, at most eight, comparing project/repository/base/engine and
the review command, worker count and timeout. An ineligible head selects nothing; a solo head
or one without a review test selects only itself. An incompatible, ineligible or solo follower
ends the prefix. Diagnostic candidates never mix with normal candidates or another parent;
every selected diagnostic member's integer 1–8 limit bounds the group. A singleton uses the
individual merge path. Selection neither sorts nor rewrites timestamps and reads no DB or engine.
**Common train execution (PM-660).** `services/merges/train.ts` reserves the compatible
queued prefix under card locks sorted by task key, rechecking sources, gates, merger rights,
PR metadata, engine and the full review configuration. One transaction saves the manifest
and moves every member to running. The existing Effect repository slot owns the train;
the document writer retains its priority when that slot next frees. There is no collection
delay and no card lock during heavy-queue waiting or testing. Cancelling any member interrupts
the common worker and waits for checkout cleanup before the slot can be reused. Survivors
return to queued with their original priority snapshots; the invalid manifest is retired.

The engine builds an ordered source chain, then closes it with another `build` whose first
parent is the original main. The unchanged first-parent merge-test diff therefore covers
every source. One `_merge/<trainId>` checkout uses dependencies matching the merged lockfile;
one full-test run with `requireHeavyLock: true` checks the candidate, without individual
green-result reuse. Candidate and all member merge commits are saved before testing. Every
member switches to checking on the common onStarted callback and receives the same result
and run id. The final locked checkpoint rechecks every source and authorization before one
non-force push and local compare-and-swap advance. Publication is cooperative and cannot be
cancelled once started. One transaction records every merged row and each starter's own
task_merged event, followed by each card's ordinary afterMerge/AutoAdvance.

A failed group check retires the manifest as failed and atomically requeues its members
with internal `task_merges.diagnostic_json` (PM-661): the failed parent's id and an integer
`maxCards = ceil(member count / 2)`. A conflict while building the ordered source chain uses
the same atomic requeue with `maxCards = 1` (PM-778), so every member automatically retries
individually on current main. A source that still conflicts uses the individual `conflict`
failure path; the full check and review gates remain required. Original creation times and
manifest priority snapshots are restored; candidate, check, failure, block and active
membership are cleared. Only adjacent diagnostic members of the same parent can group,
bounded by every member's limit.
**Blaming a member by a lone run (PM-844).** When the repository's `reviewTest.filesCommand` is set,
the group check failed with named files (`failedFiles`) and the train has at least two members, the
train does not halve first: for each member in turn it builds `onto + member`, checks that out
(`checkoutForCheck`, released after the run) and runs `filesCommand` with the group's failed files,
each shell-quoted (`mergeTestFilesCommand`, shared), with the train's workers, timeout and heavy lock.
A member is blamed only if its run failed **and** its failed files intersect the group's: any other
non-zero exit (a usage error, a failed install, no file named) leaves it unknown. Each blamed member
takes the individual `check_failed` path (`MergeSteps.fail`: `base` = the train's `onto`, the lone run's
id and command, the intersecting files, its output tail, the `task_merge_failed` event and
notification). The others (green or unknown) are requeued with no `diagnostic`, so they keep their
queue place and may join any train, each with a timeline note. If no member is blamed (an interaction,
or every lone run was unknown or red elsewhere), the train halves as before. Members keep the step
`checking`; a restart during the lone runs finds the stored red group check and halves. All of it runs
through the engine link's `build`, `checkoutForCheck`, `releaseCheck` and the full test executor, so
nothing machine-dependent is new.
Each smaller attempt gets a fresh candidate and check on current main; successful prefixes
therefore participate in the next half's check. Singletons use the individual path and only
their failed check identifies a blocking card. Success clears diagnostic state; operational
blocks and explicit retries preserve it. Shared `openPrerequisites` checks at reservation and
before publication leave dependent cards queued while unrelated runnable cards proceed.
The slot and heavy lock are released between attempts, giving the document writer and queue
prioritization their ordinary turn. A persisted red check resumes its atomic split after
restart; already published candidates still recover publication first. Operational failures
block with the original reason. Non-fast-forward rebuilds and rechecks once, then blocks.
Startup handles train manifests before individual rows: candidate ancestry detects a push
or local advance completed before the DB transaction, and finishes without repeating the
check, push or events. Unpublished candidates rebuild and recheck conservatively. The train
worker is the sole owner of shared checkout release, including startup recovery.
Blocked publication attempts are checked for candidate ancestry before their leader is
queued for recovery. An unpublished blocked manifest never reopens cancelled requests or
changes members that were retried individually; those requests keep their current state.
The manifest and selection run on the server with remote engines too, grouped by `engineId`;
they add no machine-dependent operation or RPC. Execution belongs to the existing
"Member initiated merge" inventory entry when enabled.

Cancellation is allowed before push; a successful remote push is recorded as `landed: remote` so a
retry only advances locally and finishes. Running rows resume from prepare on startup. Every attempt
releases its check worktree in finally; startup also releases the known queued and blocked worktrees.
Release errors only log a warning. The `_merge` directory is separate from card worktrees and is never
swept as a closed card; a failed release of a terminal row can leave a checkout for engine-side cleanup.

**Does this work on a remote engine?** Yes: the server owns the durable queue, gates and inbox;
all git operations, check checkouts, dependency copies and sandbox checks run on the card's engine
through the existing `merge.*` and `full_test.*` contracts. PR metadata uses the existing application
GitHub service (the default engine's `github.*` calls in cloud mode); it is independent of local git.
Source-head reads are strict for merging: an unavailable engine or failed read cannot pass the gate
as a code-free card. See the machine inventory entry below.

Check dependencies match the merged `package-lock.json` (PM-580). The engine tries the preferred
source, its repository checkout, then that repository's non-prunable worktrees under `worktreesRoot`
outside `_merge`, using canonical paths and excluding overlapping checkouts. The first byte-identical
lockfile with an installation at least as recent as that lockfile supplies `node_modules`; the source
is checked again after copying. Without a matching installed source the merge asks for the preparation
(PM-681, PM-711, PM-897): standalone merges, train checks and lone-member diagnoses call
`checkoutForCheck` with `allowDependencyInstall: true` through `services/merges/check-preparation.ts`, and the
engine then answers `dependencyInstallRequired: true` with a check checkout that has no `node_modules`
(old packages are never copied in their place). The shared preparation adds
`npmCi: { ref, mergeId }` to the check's `FullTestSpec` only for that answer, always with
`requireHeavyLock: true`; the executor then restores the exact merged lockfile's installation from its
store or installs it in its sandbox, under the same machine reservation as the test (see "Server full
test before review"). A missing or false answer sends no `npmCi`, and a switch that is false or absent
keeps the older `git_failed` / `check_error` with installation instructions. A merged tree without a
regular root lockfile keeps the preferred-source copy behavior, and a symlinked lockfile never starts an
installation. Preparation errors (`dependency_install_failed`, `timeout`, `killed`, an unusable queue)
are `error` results: the merge blocks with `check_error` (no developer fix round, no owner question, no
test, no push) and the check checkout is released after the executor has ended; only a test that runs
and fails is `check_failed`. On a remote engine this holds for an RPC timeout too: the cloud sends
`full_test.cancel`, and the engine answers it only when the run has ended and cleaned up (the
installation stopped, the lock freed), so the checkout is removed after that; an engine that stays
unreachable is `engine_offline`.

`BranchMerger.readFile` and `BranchMerger.commitFiles` are for project document writing
(PM-388, PM-494, PM-1044): the card merge never calls them. `RepoConfig.docs` (`project-docs.ts`) says where
the decision log, roadmap and lessons are (PM-1004); absent, the feature is off, and `projectDocsOf` takes the first
repository that has a path. `PATCH /config` sets it with `repoDocs` (`docs: null` clears it).

**The slot is shared with project document writes (PM-495, PM-1044).** `DocWrites` (`services/project-docs/doc-writes.ts`)
writes a row of `doc_writes` and runs it in the same repository slot as a merge: `Merges.pump` skips a
repository while `DocWrites.busy` says a write runs there, and a merge fiber's observer calls `docWrites.pump()`
before its own `pump()`, so a waiting write goes first when the slot frees (`DocWrites.pump` skips a repository
for which `Merges.busy`, and calls `merges.pump()` when it ends). `Merges.registerSlotPeer` ties the two (the peer
is the `MergeSlotPeer` port: `busy` and `pump`; the writes use `DocWriteSlotPeer`: `busy`, `holder` and `pump`). Neither module imports the other; domain assembly connects them. At most one write is open (`queued` or `running`) per project (unique index
`doc_writes_open`). Its git work is the engine's (`prepare`, `readFile`, `commitFiles`, `checkoutConflicts`,
`push`, `advance`), run in the order of the card's merge: a `non_fast_forward` push is built again once, on the
new head. The built commit is saved (`commit_sha`) before the push; a `running` row from before a restart is
`published` when the remote already has that commit (the local branch is advanced), otherwise `queued` again.
A write made through the bearer MCP (PM-784, `requestExternal`) has no Operator request or step: its row carries
the key's origin (`external_origin`), its commit has the key's trailers, and it answers after about five seconds
(`EXTERNAL_DOC_WRITE_WAIT_MS`) with `published`, `queued` or `running`; `get_project_doc_write` reads it on. A row
without a request and without an origin never runs (`authorization_revoked`), except one explicitly marked
`autonomous_lessons` by `requestLessons` (PM-1004). That write has no owner request or step. The hub verifies
the selected project manager or transitional Operator, repository/default branch and current lessons path at start, recovery and before publication;
conflicting provenance or revoked configuration ends it as `authorization_revoked`. Its result still reaches
the author through the existing system-message path.

## Heavy-run queue (PM-332)

Three full test suites at once (2026-10-04) took the load to 81–89 and the swap to 6 GB: every member's vitest
starts a worker per core, about 150 MB each. So **one heavy run goes at a time on the machine**, and a run's
workers follow the machine's size.

- **The lock** (`apps/server/src/full-test/heavy-lock.ts`, with an Effect core in
  `full-test/heavy-lock-core.ts`). The CLI imports the facade directly; `full-test/index.ts` also
  loads the sandbox runtime. macOS has no `flock` or `lockf`, so the lock is a
  directory in `/tmp/projectman-<uid>/heavy` (`defaultHeavyLockDir()`, `PROJECTMAN_HEAVY_LOCK_DIR`): its parent
  must be 0700 and ours, or the queue is `heavy_lock_unavailable`. `holder/` is the lock itself (`mkdir` is
  atomic; `owner.json` inside names the process, its label, checkout and session); `queue/<ticket>.json` is one
  file per waiter, the ticket sorting by queue time. A waiter and the holder write a heartbeat (`utimes`, every
  5 s) on their file. The head of the queue removes the tickets and the holder that are stale (heartbeat older
  than 30 s, or the pid gone) and takes the lock; breaking a holder is a `rename` away, atomic, so one waiter
  wins. A live holder is never broken, however long it runs. After a sleep a live lock can be broken for a
  moment (two runs overlap); the holder notices at its next heartbeat and logs it once. `readHeavyQueue` shows
  who holds it and who waits, for the PM-300 display.
- **The run's directory (PM-847).** Whoever holds the lock prepares its run directory
  (`full-test/sandbox.ts`, `runDirOf` on `canonicalRoot` roots): a byte-measured `pmft-*` directory with room
  for the sandbox's sockets (see "Server full test before review"), made only once the lock is held; when no
  root has room, the run ends as `sandbox_unavailable` and releases the lock.
- **Idle close (PM-569).** An idle session with a live heavy-run holder or waiter stays open,
  and gets its full idle interval after the last sweep that saw the run. Heartbeats must be at most
  30 seconds old and the PID must live. After 120 minutes since `lastActivityAt`, idle closure applies
  even with a run present. Other closure reasons and meeting sessions are unchanged. Only queued
  commands are covered; grace is in memory and does not survive a server restart.
- **Who queues.** The CLI `npm run heavy -- [--label <text>] [--max-wait <s>] <command>`
  (`scripts/heavy/cli.ts`) runs the command at its turn; the root `npm test`, `npm run typecheck` and
  `npm run shots` go through it. It says on stderr who it waits for; `--max-wait` ends with exit status 75.
  The command runs under `scripts/lib/child-guard.mjs` (PM-863) as the leader of its own process group
  (its stdin is `/dev/null`): SIGINT, SIGTERM and SIGHUP to the CLI, and the CLI's death even by SIGKILL
  (the guard's stdin is a pipe from the CLI), stop the whole group (SIGTERM, SIGKILL after 5 s), and any
  member left when the leader exits is killed. The lock is released only after the guard has gone, so
  no vitest worker outlives an interrupted run or overlaps the next one. An unusable queue folder (`heavy_lock_unavailable`) stops the
  command with exit status 78 and a four-line message; it does not run without the queue (decision 33,
  PM-346). `PROJECTMAN_HEAVY_LOCK_HELD=1` (set for everything the CLI runs) makes a nested call run
  without queueing. Runs inside one workspace (`npm test -w …`, `npx vitest related …`) do not queue.
  **Direct runs (PM-869).** A member's own `npx vitest run` / `related` is not under the guard, and an
  interrupted one used to leave its forked workers (about 4 GB each in `apps/server`). Every vitest config
  lists `scripts/lib/vitest-parent-guard.setup.mjs` in `setupFiles` (`PARENT_GUARD_SETUP`): a forked worker
  ends itself with SIGKILL (vitest replaces `process.exit` in a worker with a throwing function) when the
  IPC channel to its parent closes (`disconnect`) or its parent pid changes
  (`scripts/lib/worker-parent-guard.mjs`, polled every 2 s). Worker threads die with their process and are
  left alone. A worker stuck in a synchronous loop cannot run the handler; the heavy CLI's process-group
  kill is the only thing that reaches it.
- **The server's full test** (`createFullTestExecutor({ heavyLockDir })`) takes the lock before it prepares the
  run directory; the wait is not part of `durationMs` and `timeoutMs`, and an abort while waiting ends as
  `killed`. `fullTestEnv` sets `PROJECTMAN_HEAVY_LOCK_HELD=1`, so the scripts inside do not queue again. With an
  unusable folder it runs without the queue and logs a warning: the review must not stall on it. The merge
  check is the exception (PM-658): `FullTestSpec.requireHeavyLock` (optional; the merge always sends `true`)
  makes a missing or unusable queue end the run as `error` / `heavy_lock_unavailable` (`durationMs` 0, no
  sandbox, no `onStarted`), so the merge blocks as `check_error` and never runs one without the queue.
  A merge train (PM-660) submits one common candidate through that same executor and lock;
  its repository slot and card locks do not permit parallel heavy runs or bypass the queue.
  Dependency preparation (`FullTestSpec.npmCi`, PM-710) requires that lock too: probes, sandboxed
  `npm ci`, dependency copies, generation publication and the test share one reservation and one
  `timeoutMs` budget after waiting. `onStarted` fires once; each probe gets at most 60 seconds and
  every child gets only the remaining budget. Abort waits for the running child before cleanup and release.
- **The members' sandboxes** (`SandboxPaths.heavyLockDir`): `projectman-<uid>` is writable and
  `PROJECTMAN_HEAVY_LOCK_DIR` is set, together with `npm_config_prefer_offline` (install from the member's own
  npm cache when there is no clone). The same folder and variables go to a Codex member as
  `AgentSandbox.portable` (PM-346): `buildCodexArgs` adds the parent to `sandbox_workspace_write.writable_roots`
  (only in `workspace-write`) and sets each variable with
  `shell_environment_policy.set.<NAME>`, so every command sees them, also one run outside the sandbox after a
  question. The server makes the missing parent (0700) before the process starts.
- **Workers.** `defaultTestWorkers` (`packages/shared/src/config/test-workers.ts`): half the cores, at most 4,
  one per 4 GiB of memory, at least 1. Every `vitest.config.ts` sets `maxWorkers` to it and `minWorkers` to 1.
  `VITEST_MAX_FORKS` and `VITEST_MAX_THREADS` (the server's full test sets them from `reviewTest.maxWorkers`)
  still win: vitest takes `poolOptions.*.max*` before `maxWorkers`.
- **Two server test projects (PM-865).** `apps/server/vitest.config.ts` has two `test.projects`, both
  `extends: true`. `isolated` is plain vitest, a fresh module graph per file in a `forks` process. `pooled` runs
  the files `pooledTests` (`apps/server/test/isolation.ts`) picks in the `threads` pool with `isolate: false`:
  the files of a worker share its modules, process and globals, so the server's modules load once per worker,
  not once per file. The choice is a machine rule, not a list kept by hand: a file is `isolated` when it, or a
  test-side file it imports (under `test/`, `*test-helpers*`, fixtures), holds a pattern of
  `ISOLATION_REQUIRED` (module mocks, `vi.resetModules`, `process.chdir`/`on`/`exitCode`/`env` writes, globals set
  by hand, spies on `process`, fake timers nobody gives back) or is named in `ALWAYS_ISOLATED` (with a reason),
  or is a PTY test. `test/isolation.test.ts` covers each pattern. `pooled` puts `vi.stubEnv` and
  `vi.stubGlobal` back after each file (`test/setup/unstub-after-file.ts`; not after each test, which would end a
  `beforeAll` stub early). Vitest decides whether a worker is recycled from the root
  `poolOptions.<pool>.isolate`, never from a project's, so the root sets it for `threads` only. The pool's
  `minThreads` equals its `maxThreads`: with fewer, tinypool ends an idle worker thread without isolation and the run
  fails with "Terminating worker thread". The two pools would run at the same time, so `pooled` has
  `sequence.groupOrder: 1`. `VITEST_MAX_FORKS` caps the threads too (`VITEST_MAX_THREADS` first). A failed file
  is named `FAIL  |pooled| …` or `|isolated| …`; `merge-test` and `full-test/output.ts` read both.
- **The server's merge check** runs the repository's `npm run merge-test` in the full test sandbox
  before the default branch moves (PM-386, PM-490, PM-657). The first-parent diff and the union of
  both git trees' import graphs select changed server modules and their transitive dependents.
  A module check runs one server typecheck and one Vitest invocation with explicit test paths:
  adjacent tests, external tests reached through helpers, uncertain test dependencies, architecture
  tests, integration tests and golden paths.
  **Server and script impact (PM-864).** Server contracts and config use their source modules;
  script code uses the server workspace. Both server and script files are read from each git tree.
  Changed tests select themselves, deleted tests have no effect, and snapshots select their owning
  test (an unmapped snapshot falls back). Changed helpers and scripts select tests reaching them in
  either tree; a script dependency also proves a source dependency. Server markdown is ignored.
  Fixtures, test setup and other non-code changes fall back to the full server workspace, as do
  nonliteral/unresolved production imports, unmapped sources, empty selection and ambiguous Vitest
  substring filters. Web changes retain full web checks; documentation-only changes skip tests.
  Files importing `child_process`, `worker_threads`, `vm`, `module` or `@lydell/node-pty` stay uncertain
  unless audited in `scripts/merge-test/runtime-entries.ts`: its `RUNTIME_ENTRIES` map adds explicit
  repository entrypoint edges, and `[]` means only external programs/packages. Unknown launchers
  and missing historical entrypoints keep every reaching test. Filesystem imports alone do not
  imply runtime code loading. The runtime-entry guard always runs alongside architecture guards
  and rejects missing keys/targets or keys without a runtime import; reviewers verify the entries
  against the launcher's code. Integration tests, golden paths and tests without a source dependency
  also always run.
  **Shared export impact (PM-843).** `packages/shared/src` changes run shared's own tests and use
  `scripts/merge-test/shared-impact.ts` to follow named exports from its barrel, relative shared
  dependencies and named consumers in both git trees, including `scripts/`. The affected server files
  and script consumers seed the server module/test graph. Web and widget consumers run their whole
  workspace. Shared changes always typecheck every workspace. A shared test or other non-source file
  selects only shared's tests.
  Unsupported exports/barrels, duplicate export names, uncertain or escaping shared dependencies,
  shared subpath imports, analysis errors or affected template consumers require all tests.
  Namespace, side-effect, dynamic or otherwise uncertain consumer imports keep that consumer.
  The architecture checker and shared export analysis share trivia recognition: regex literals at
  proven expression starts cannot create import/export tokens or hide the following real import.
  Changes to `scripts/merge-test/**`, `scripts/full-test/**`, non-code scripts, the widget, other
  packages, manifests/lockfiles, TypeScript/Vitest configuration, architecture guards or unknown
  paths require all workspaces; `--all` forces them. `--dry-run [<commit>]` prints the scope and each
  `merge-test step: npm <args>` without executing checks or checking out the commit (default `HEAD`).
  It compares against the commit's first parent; a non-merge commit retains the full-run scope.
  Scope, selected modules, test count and fallback reason are logged before and after execution. The executor holds
  the machine's lock, so the nested root scripts do not queue again.
  **Timing measurement (PM-866, 2026-10-20, Mac, main `fab09438`).** With four workers,
  the comparable server baseline on PM-865 was 421.5–430.6 s (534 files, 12,316 tests;
  collect 272.3–275.4 s and tests 1,321.9–1,344.7 s summed across workers). The final
  run in the same Claude Code sandbox, excluding PTY files, took 306.14 s (collect
  47.00 s, tests 1,145.95 s), with 538 files and 12,427 tests. Four files failed because
  a long temporary path exceeded the macOS Unix-socket limit; all four passed when
  rerun with a short TMPDIR (75 passed, one skipped). In the replay, one host test
  uses its successful 17.9 s rather than the failed JSON's 1.68 s. This raises the
  estimated complete server wall time to about **310–322 s**, below the 600 s target.
  Registered test counts did not decrease. The corrected wall improvement over the
  426.05 s baseline average is 24–27%; collect fell about 83%.
  A fresh four-worker web run took **99.59 s** (178 files, all 2,257 tests passed).
  Forty first-parent merges ending at the cutoff replay as 15 module scopes, 20 full
  scopes, one cloud scope, one shared scope, two workspace scopes and one skipped check.
  Using the corrected server file times divided by four, the measured web time and
  shared/templates/widget allowances of 10/1/2 s gives a **393.47 s median** and
  **399.62 s nearest-rank p90**: the typical estimate misses 300 s by 93.47 s at the
  median. Module scopes retain 92–99% of the complete server file-time sum; counting
  fewer files does not remove most of the slow harness work. The full-workspace wall
  estimate is about 423–435 s (corrected server wall plus web and the three allowances),
  not an observed end-to-end full run. These estimates exclude collect/typecheck overhead
  and the 23 PTY files missing from the server JSON; their cost is not known to be zero.
  The report, top twenty files and forty replay rows are attached to PM-866 and PM-849;
  PM-876 tracks the remaining time gap and the owner's structural options.
  Historical successful merge step times and worker counts cannot be reconstructed:
  `passedOutputTail` retains flaky markers only. Merge checks did not store their duration
  before PM-876 (they call the executor directly and write no `full_test_runs` row); since then
  every one is recorded in `merge_check_runs` (migration 92: time, queue wait, the `maxWorkers`
  the hub passed, scope and step timings from the engine; `list_merge_checks`, `get_task`).
  Runs before that have no record. Requested-to-merged timeline intervals
  include queue time and retries, so they are upper bounds. The last explicit setting
  record (PM-798, owner, 2026-10-19 11:38 UTC) reduced `reviewTest.maxWorkers` to two;
  it is not a per-run worker measurement. Only one merge at this cutoff contains all
  five optimizations, so a twenty-merge after sample is not yet available.
  Repeat on the engine Mac with the same sandbox capabilities and PTY exclusion as
  the baseline, and a **short, writable TMPDIR** for Unix sockets. The earlier Codex
  sandbox run (PTY probe allowed, local listeners refused) is diagnostic only.

  ```sh
  VITEST_MAX_FORKS=4 VITEST_MAX_THREADS=4 TMPDIR=<short-tmp> npm run heavy -- npx vitest run --root apps/server --configLoader runner --reporter=default --reporter=json --outputFile.json=<tmp>/after.json
  npm run merge-test -- --dry-run <commit>
  VITEST_MAX_FORKS=4 VITEST_MAX_THREADS=4 TMPDIR=<short-tmp> npm run heavy -- npx vitest run --root apps/web --configLoader runner --reporter=default --reporter=json --outputFile.json=<tmp>/web.json
  ```

  List commits with `git log <cutoff> --first-parent --merges -40 --format=%H`; run
  the dry-run once per commit with the current selector against each historical
  first-parent diff. Match selected paths to JSON `testResults` by repository path;
  report excluded PTY files and missing timings separately. Estimate each merge as
  selected file durations / 4 plus only its selected non-server workspaces. Report
  median and p90 separately from observed wall time. Retain the default reporter's
  collect/test totals too: JSON per-file durations do not include collect time.
  **Rerun and marker lines (PM-842).** `scripts/merge-test/steps.ts` runs the steps one by one (the
  full run is split by workspace: every type check, then every test, so a failed file belongs to a
  workspace). A failed `test` step reruns once, with only its failed files, when it ended with an
  exit code, 1-5 files can be read from vitest's `FAIL` lines, there is no "Unhandled Errors"
  block and the merge (`HEAD^1..HEAD`) did not change any of those files (a card's own tests are
  never rerun). A green rerun makes the step green and prints `merge-test flaky: <path>` per file; any
  other failure prints `merge-test failed: <path>`. The marker lines come last, before the closing
  `merge-test scope:` line; the rule (`mergeTestMarkerLine`, `mergeTestMarkedFiles`) is in
  `packages/shared/src/domain/merge-test.ts`. `npm run merge-test -- --files <path>...` runs only
  those test files (grouped by workspace, no type check, same rerun rule; a path absent from the
  checkout prints `merge-test skipped (absent): <path>` and is left out).
  `--files-from-env` takes the same list as a JSON array (1 to 20 files) from `MERGE_TEST_FILES`
  (empty or absent: the plain scope mode; not with `--files`, `--all` or `--dry-run`), so a CI
  workflow hands its input over through the environment and no shell reads it. `--shard <k>/<n>`
  (1 <= k <= n <= 8, with any mode, anywhere in the arguments) deals the type checks round-robin
  among the shards and runs every test step on every shard with `--shard=k/n` (every workspace's `test` script carries `--passWithNoTests` itself);
  the `merge-test timing:` line keeps the step's index in the whole list, so the shards' reports
  can be merged. The failed-file rerun (PM-842) stays inside the shard and has no shard flag.
  `.github/workflows/merge-check.yml` (PM-900) runs four shards on `macos-15` for a
  `workflow_dispatch` on a `pm-check/` branch only (no secret, read-only token, actions pinned to
  commits; `merge-check-workflow.test.ts` guards this). The executor
  (`full-test/output.ts`) reads the markers: `failedFiles` prefers the `failed` lines, and a passed
  run's `outputTail` holds the `flaky` lines. The server adds a system `task_note` to the card of a
  single merge, and to every member of a train, when its check passed with flaky files, and logs
  `merge check passed with flaky test files`; the merge goes on. The engine link is unchanged: the
  lines travel in the existing `failedFiles` and `outputTail` fields.
  **Passed-step cache (PM-845, PM-841).** Each step hashes
  `JSON.stringify({ v: 1, tree, args, node, platform, arch, maxWorkers })` with SHA-256: the complete
  `HEAD^{tree}`, npm arguments with absolute paths made repository-relative, Node version, OS,
  architecture and `VITEST_MAX_FORKS` (or an empty string). Only identical inputs reuse a step.
  The engine-owned executor reads `<app home>/cache/merge-test-steps.json`, drops entries older than
  14 days and writes a disposable `sandbox/merge-test-passed-keys` list, exposed by
  `PROJECTMAN_MERGE_TEST_PASSED_KEYS`. A hit prints `merge-test cached: <command>` and skips npm;
  `--no-cache` bypasses reads. Passed steps print `merge-test step passed: <64-hex key>` immediately
  and again before the closing scope line. Only an original invocation with exit code 0 produces a
  passed-step key; a green failed-file rerun stays flaky and is never cached, so retries retain its
  diagnostic and apply their own changed-file rerun condition. The shared `mergeTestPassedSteps`
  parser accepts at most 50 unique, line-anchored keys, after ANSI removal. After any command outcome, including timeout or
  cancellation, the executor merges those keys with fresh timestamps and the run id, retains the
  newest 500 entries and publishes the version-1 JSON by temporary file and rename. Cache failures
  are warnings and never change the test verdict. The sandbox never writes the persistent cache;
  markers have the same candidate-code trust boundary as the script and its exit code.

## Machine-dependent parts (PM-341)

- **Interrupted card continuation (PM-1092)** — `runtime/sessions/sessions.ts` closes lost live
  sessions with `server_restart` during startup or engine reconciliation; the internal `session_ended`
  event carries the previous state so completed idle turns stay stopped. `runtime/admission/hand-over.ts`
  resumes their current work-stage assignee or review-stage owner through normal admission. The
  persisted `hand_over.resumeMember` keeps the same member while capacity, pauses or an offline engine
  hold the continuation; a changed stage or assignment invalidates it. **Machine assumptions:** the
  existing provider transcript on the session's engine supplies the resumed conversation. **Remote
  engine:** the hub stores and retries the continuation; the existing session-start RPC runs the CLI
  on the engine after it reconnects. No new transport or shared filesystem is required.

- **Keep awake while working (PM-1086)** — `engine-host/keep-awake.ts` (`createKeepAwake`,
  `spawnKeepAwakeProcess`), wired in `engine-app.ts` to its 1 s poll; `engine-handlers.ts` `activeRuns()`
  counts the merge-check and screenshot runs; `engine.json` `keepAwake` and `npm run engine -- keep-awake
on|off`. While a session, a merge check or a screenshot run is active the engine holds
  `/usr/bin/caffeinate -i -s -w <engine pid>` and lets go two minutes after the last one ended (a crashed
  `caffeinate` is started again at most once a minute). **Machine assumptions:** macOS only (other
  platforms report `unsupported`; a Linux `systemd-inhibit` is not built); `-i`/`-s` keep the system awake
  on mains power, the display may sleep, and a Mac on battery with the lid closed sleeps anyway; `-w` ends
  `caffeinate` with the engine even after a SIGKILL. **Remote engine:** everything runs on the engine's own
  machine and nothing crosses the server/engine boundary; `hello` and the RPC are unchanged.

- **Link-headers file and the working-folder check (PM-1077)** — `scripts/engine/commands.ts` (`init
--link-headers-file <path>`), `EngineHost.workspaceState(path)` (`contracts/engine.ts`; local:
  `engine-host/local-host.ts`, remote: `engine-link/remote/host.ts`), `NewProjectEngines.workspaceState`
  (`runtime/sessions/new-project-engines.ts`) and `ProjectService.create` (`core/projects/projects.ts`).
  **Machine assumptions:** `init --link-headers-file` runs on the engine's own machine, resolves the path
  against the working directory, requires an existing regular file and writes its real path into that
  machine's `engine.json` (`linkHeadersFile`; the file itself, mode 0600, is checked at engine start and never
  read by `init`). The folder check asks the engine's `host.is_directory`, which the engine answers only within
  its own roots (`path_outside_roots` in `engine-limit.ts`). **Remote engine:** both run on the engine; the
  `not_held` state is made on the hub from that existing refusal (a path the engine does not hold yet, e.g. an
  owner's folder before `project set`), so the hub never looks at the owner's disk and the wire method and the
  engine limit are unchanged, which keeps an older engine working. A project created that way waits with
  `engine_offline` until the engine reports it, after `project set` and a restart (`service install`).

- **Member queue driver (PM-925)** — `apps/server/src/runtime/member-queue/` (driver, message lane), the sweep in
  the kernel's sweep list (`DomainOptions.memberQueueSweepMs`), `member_queue_items` with the wait columns
  (migration 99). It wakes members from their queue through `admission.start`. **Machine assumptions:** none of its
  own; it runs in the server process and reads only the database. **Remote engine:** the driver, the sweep and the
  database run on the hub; the session start crosses the server/engine boundary as it did, and an offline engine
  becomes the item's wait (`engine_offline`), retried by the sweep.
  **Start lane and workspace yielding (PM-927):** known-member deferred starts live in the queue;
  their specifications are rebuilt and retried through admission. `runtime/sessions/workspaces.ts`
  also stops a holder idle for two minutes when its card has no open item and its member's queue
  needs another card. The hub decides from persisted session and queue state; the existing session
  RPC stops the process on its engine, whose workspace manager still refuses dirty checkouts.
  No new path, process or transport assumption is introduced.
  **No Operator lane (PM-1045):** the Operator lane and its reminder are gone; the driver starts no session
  for the Operator and the queue puts no item on it. Machine work waits as an open inbox item for the connected
  client, with the PM-1003 sweep escalating it to the owner when no owner has a live super key
  (`integratorSideAvailable`). Nothing new crosses the boundary.

- **Startup sweep of crash leftovers (PM-837)** — when the engine host is created (the server in local mode,
  the engine process in hybrid mode) two one-shot background sweeps remove what a crash left behind, each
  logging a warning on failure and never throwing: `sweepStaleChecks` (`engine-host/merge-check.ts`, called by
  `createLocalEngine`) over the direct children of `<worktreesRoot>/_merge` named like a merge id, and
  `sweepStaleRunDirs` (`full-test/sandbox.ts`, called by `createFullTestExecutor`) over the direct children of
  `os.tmpdir()` and `SHORT_ROOT` named `pmft-<up to 8 alphanumerics>` (full test and screenshot runs). Only
  entries older than `STALE_LEFTOVER_MS` (24 h by mtime, `contracts/engine.ts`) go; links are judged by `lstat`
  and never followed (a `_merge` link is unlinked, a `pmft-*` link is left); a `pmft-*` directory must also be
  owned by the engine's uid. The git worktree entry of a removed check is pruned by the next `releaseCheck`.
  **Machine assumptions:** the engine's local temp and worktrees roots, the shared `/tmp` (`/private/tmp` on
  macOS), which another instance of the same user may use (hence the uid and age checks), and POSIX `getuid`.
  **Remote engine:** the same code runs on the engine over its own directories; the cloud takes no part and
  nothing crosses the server/engine boundary.

- **One-shot external commands (PM-903)** — `apps/server/src/exec/` runs short commands through
  execa without a shell, preserving the supplied environment and final newlines. Timeouts,
  cancellation and output limits send SIGTERM, followed by SIGKILL after a fixed 5-second grace
  period. It waits for the child to exit; it does not create process groups or replace session
  and test process guards, and does not add parent-exit cleanup. **Machine assumptions:** POSIX
  signals and executables available on the supplied `PATH`. **Remote engine:** supported; the
  helper runs wherever its caller lives: worktree and merge git on the engine, configuration git
  and gh on the server. Later slices use it for engine probes, copies and trust, server version
  checks and supervisor service control (PM-911). Host scripts now use the helper for migration
  git/tar, the administration builder's commit check and work-root move commands
  (`scripts/migrate/{git,apply,package}.ts`, `scripts/administration/builder.ts`,
  `scripts/engine/move-work-root.ts`, PM-912). No new data crosses the
  server/engine boundary; the change on each host is SIGKILL escalation after the grace period.

- **Local history embeddings (PM-767)** — `apps/server/src/history-semantic/**` (module `history-semantic`, engine
  layer, sealed), `db/history-semantic.ts` and migration 95, `services/history/service.ts` (the search phases),
  `apps/server/scripts/prepare-history-model.mjs` with `models/history-model.json` (the pinned model, fetched once
  and hash-checked at build time, never at run time). The semantic part of `search_history` is a worker thread of
  the server process: it owns the Xenova/multilingual-e5-small q8 model (`@huggingface/transformers`, ONNX Runtime
  with one thread) and the `sqlite-vec` extension, and has its own WAL connection of the database file
  (`openAuxiliaryDatabase`). The vectors are derived data in plain tables (`history_semantic_*`, in the journal's
  unjournaled list), rebuilt from `history_documents`; the search is an exact brute-force cosine scan, no
  `vec0` table. **Machine assumptions:** a database file path that a second connection of the same process can open
  (no `:memory:`); about 350 MiB of native memory beside the heap (2 GB machine target); the model files next to
  the bundle (`dist/models/history`) with a build that has the native binaries for the platform; no network at
  run time (`allowRemoteModels=false`). A standby copy never starts it. **Remote engine:** nothing runs on the
  engine. The history, its index and the search belong to the server/hub that holds the database, so the worker
  runs there (the cloud image carries the model, `deploy/cloud/Dockerfile`); no embedding, text or vector crosses
  the server/engine boundary. A failure of the worker, the model or the extension only leaves the word search
  (statuses in the private search log, never in a tool reply). **Release measurement (PM-910):**
  `deploy/cloud/history-semantic-profile.mjs` (docs/HYBRID.md "History semantic profile") runs the built server in
  fresh processes on a Linux ARM64 machine in a cgroup v2 with `memory.max` up to 2 GiB, no swap and no network,
  reading `/proc/<pid>/status`, the cgroup's `memory.*` files and `/proc/net/tcp*`; the server starts through
  `src/start.ts` (`index.ts` is its one-line entry) and the measurement's bundle `dist/history-semantic-profile.js`
  adds a loopback search listener with a one-time secret that `dist/index.js` never loads. It runs where the model,
  the database and the worker run, on the server machine, and nothing of it crosses the server/engine boundary.
  The cloud stays `PROJECTMAN_HISTORY_SEMANTIC=off` until a report passes.

- **Web push sender (PM-815, PM-827)** — `apps/server/src/services/web-push`, the
  `contracts/web-push.ts` transport and the personal `web_push_*` tables run on the server/hub.
  The P-256 installation key is atomically created under `PROJECTMAN_HOME/secrets/web-push.json`
  (directory 0700, file 0600), included in the cloud restic backup. Delivery requires outbound HTTPS
  to the allowlisted browser push providers (Google, Mozilla, Apple and Windows); redirects are
  not followed. Visibility is held per authenticated WebSocket connection in hub memory.
  Standby copies never create keys or send; cloud restore rehearsals additionally set
  `PROJECTMAN_WEB_PUSH_ENABLED=0`. **Remote engine:** fully supported; nothing runs on the
  engine and no new data crosses the server/engine boundary.

- **Administration adapter and supervisor (PM-763, Super mode 7/10)** — `apps/server/src/administration/**`
  (module `administration`, engine layer, sealed), `apps/server/src/contracts/administration.ts`,
  `apps/server/src/engine-link/{methods,protocol,engine-handlers}.ts` and `engine-link/remote/administration.ts`,
  `scripts/administration/*` (`npm run administration -- prepare`), `deploy/mac/com.projectman.administration.plist`
  and `deploy/projectman-administration.service`. A separate supervisor process per machine (the hub host, each
  supported engine machine) restarts exactly one configured launchd label or systemd unit, reads that service's
  boot id (systemd `InvocationID`; launchd a hash of pid and process start time) and keeps a durable operation
  record and a sanitized diagnostics journal. The hub and the engine reach it only through the port
  `AdministrationPort` (`status`, `logs`, `submit`, `inspect`) over one Unix socket, one JSON line each way.
  `full_test`, `image_build` and `deploy` are forwarded to injected executors only; their business orchestration
  is PM-764, and a command without an executor is not advertised as a capability. **Machine assumptions:** a
  Unix-domain socket in a 0700 directory owned by the service user (the container of a cloud hub gets this one
  socket bind-mounted, no docker.sock, host network or shell); launchd (`/bin/launchctl`) or systemd
  (`/usr/bin/systemctl`) called by absolute path with a minimal environment; the supervisor runs as the same OS
  user as the service it restarts, and the OS (for example a polkit rule for that one unit) grants it the restart
  right; `/bin/ps` for the launchd process start time. Node cannot read Unix-socket peer credentials, so access
  rests on the file-system rights, which are checked (owner, mode, no symbolic link) before every connection.
  **Remote engine:** yes. Each engine machine runs its own supervisor; the cloud hub reaches it through the
  engine link with the new server-to-engine RPCs `admin.status|logs|submit|inspect` (PM-1061: only to the host
  owner's engine, `hostEngine()`; any other engine gets `engine_not_host`), which an engine answers for its
  own target only (the `Hello.administration` capability is negotiated; an older engine gives 503
  `administration_unavailable`). The socket never leaves the machine, nothing crosses the boundary but the strict
  zod-checked commands and the bounded diagnostics (at most 200 lines of 1000 characters, no transcript,
  environment, argv, secret or raw exception), and no bearer or Access header is sent. A restart is never repeated
  blindly: the operation id is stored before the restart, a duplicate submit gets the same answer, and success needs a
  changed boot id plus the engine registry's feedback. An active release deployment fence refuses a restart with
  409 `release_pause_conflict`. The installer only prepares files; installing and starting the supervisors is a
  separate owner-approved rollout, and it accepts a state and socket directory only below
  `<app home>/administration`, the folder the session sandbox denies (members run as the same OS user). See
  docs/SECURITY.md "Administration adapter". Since PM-762 the strict command schema (`AdministrationCommand`,
  `AdministrationTargetSchema`, `AdministrationCommandSchema`, the commit, boot-id and operation-id validators,
  `FULL_TEST_PROFILES`, `IMAGE_PLATFORMS`) lives in `packages/shared/src/api/administration.ts`, so the handoff
  and the adapter share one definition; `contracts/administration.ts` and `administration/schemas.ts` re-export it
  under the old names. Only the schema moved: the port, the executors, the socket protocol, the installation and
  the engine RPCs stay on the server, and the hub/engine boundary is unchanged.
  **Machine state, filtered logs and process cleanup (PM-886, part of PM-875):** three more typed operations of the
  same supervisor (`machine.ts`, `service-logs.ts`, `processes.ts`, `redact.ts`, `host.ts` next to it). _Machine
  state_ (`AdministrationPort.machine`, capability `machine`, RPC `admin.machine`): on macOS the fixed commands
  `/usr/sbin/sysctl` (`vm.loadavg`, `hw.memsize`, `vm.swapusage`), `/usr/bin/vm_stat` and `/bin/ps -axo …`; on Linux
  `/proc/loadavg`, `/proc/meminfo` and `/proc/<pid>/stat|status`. It returns the load, memory and swap numbers and at
  most 10 processes of the supervisor's own user by resident memory with the program's base name only (no argument,
  path or environment). _Filtered logs_ (`logs` options `source`, `minLevel`, `since`, `contains`, capability
  `service_logs` for `source: 'service'`; limits stay 200 lines and 1000 characters): launchd reads the optional
  `service.logFile` of `supervisor.json` (an absolute path, opened with `O_NOFOLLOW`, a regular file of the
  supervisor's user that others cannot write, only its last 512 KiB), systemd runs `/usr/bin/journalctl -u <unit>
-o json --no-pager -n <limit>`. Every line is redacted in the supervisor before it leaves (project keys, bearer
  tokens, API and GitHub tokens, `token=`/`key=`/`password=` values, long hex or base64 runs). _Process cleanup_
  (`AdministrationCommand` `process_cleanup`, selector `orphan_test_workers`, a durable operation like the restart,
  mapped to the `machine` capability): sends TERM, then KILL after 10 s, only to processes of the supervisor's own
  OS user whose parent is 1, whose command line carries `vitest` or `tinypool` and that are at least 5 minutes old;
  the running service, its process group and the supervisor itself are never targets, and the result carries the
  counts `found`, `stopped`, `remaining` only. **Machine assumptions:** the absolute binaries above, `/proc` on
  Linux, the same OS user as the processes, and the optional service log file path. **Remote engine:** yes. All of
  it runs in the supervisor on the machine it describes; the engine link carries `admin.machine`, the extended
  `admin.logs` parameters (sent only to an engine that announced `machine`) and the `process_cleanup` submit. The
  cloud hub sees only the numbers, the base names and the redacted lines, never a command line, a pid list or an
  unredacted log; an older engine gives 503 `administration_unavailable`. The super surface reads them with the
  external MCP tool `get_machine_snapshot` and the extended `get_administration_logs`, both behind the operator
  grant (`OperatorGrantGate`); the cleanup goes through `super_operate`.

  **Owner-approved shell (PM-887):** `administration/owner-command.ts` runs
  `spawn(shell, ['-c', command], {cwd, env, detached: true})` as the supervisor's OS user, only when its protected
  config explicitly sets `ownerCommand: {shell: <absolute path>}`. The installer writes that field only with
  `npm run administration -- prepare --owner-command-shell <absolute shell>`; without it the `owner_command`
  capability is absent and submits are `administration_unavailable`. This deliberately narrows PM-763's
  “no host shell” principle: only the owner's own login may approve each individual command, through a fresh
  `waiting_owner` super operation classified as `security`; a grant, waiver or previous yes never substitutes.
  The owner question includes the exact command, cwd (default: the supervisor user's home), target, timeout
  and reason in a JSON code block; these text fields reject Unicode format characters and C1 controls.
  `OperatorGrantGate` is also checked before submission; revoking it does not terminate a running
  command. The environment inherits the supervisor's variables except the shared `BILLING_ENV_VARS`
  (`packages/shared/src/config/billing-env.ts`), including Codex OAuth overrides. The timeout is 1–600 seconds
  (default 120); timeout or supervisor shutdown sends TERM to the dedicated process group and KILL 10 seconds
  later; descendants that create a new session or daemonize can escape group termination. Each output stream
  is bounded to 64 KiB including JSON escaping; raw collection is bounded too.
  Terminal escapes (CSI/OSC) and C0 controls except newline/tab, plus DEL, are removed before `redact.ts`,
  then output is cut at code-point boundaries to fit the encoded budget before entering the durable result;
  the command stays in the Operator's attributed super operation with its request id. The existing operation-id
  deduplication and single-operation lock apply. **Machine assumptions:** a POSIX shell at the configured
  absolute path, process groups, and the supervisor user's home and OS permissions. **Remote engine:** the
  selected hub or engine supervisor executes it through `admin.submit`/`admin.inspect`; only bounded redacted
  output crosses the link. A cloud target runs its own shell. Access to the owner's Mac requires a supervisor
  there with this opt-in enabled.
  On Linux the command inherits the supervisor systemd unit's restrictions: read-only system and home,
  writes only to its state/socket directories, no network beyond Unix sockets, no privilege escalation and
  private temporary files. On macOS, launchd runs it with the owner's OS-user permissions. The Linux unit's
  protections stay in place; a denied operation is reported through the command's exit code and stderr.

- **Durable super-mode handoff and owner-bound operations (PM-762, Super mode 6/10)** —
  The app principal also belongs to the selected project manager (PM-1041): its server-issued `member`
  binds the actor to that member's own general session and open owner request. Project commands use
  the shared operation path under the owner's authority; machine and other unlisted command kinds
  are refused with `command_not_for_project_manager` and handed off through `open_integrator_todo`.
  Owner-reserved effects still wait for the owner's own login. App principals stay on the server;
  this adds no machine dependency or remote-engine boundary. Since PM-1045 the app principal has only the
  project manager branch: the app's Operator session is gone, so nothing issues an Operator principal;
  the super-key path (`superActorOf`) is unchanged.
  `services/super-operator/handoffs.ts` (`SuperHandoffService`), `db/super-handoffs.ts` (migration 83:
  `super_handoffs`, `super_operations`), `packages/shared/src/{api/super-handoff,config/super-command}.ts`,
  `core/inbox/inbox.ts` (the owner's-own-login rule, the relay), the Operator MCP tool `request_super_operation`
  (retired by PM-888) and the routes `routes.superHandoffs` / `routes.relayOwnerAnswer` (execution is the MCP tool only, PM-1030). The base
  Operator records a command and a reason; nothing runs until the owner's integrator (a super token) starts it with
  a request id. A command with a deletion, security or cost effect waits for the owner's own login
  to answer a bound question (24 hours; the question names the command hash, the config version and the token). The
  service and its state are on the hub only. **Machine assumptions:** none of its own — it holds no path, process,
  socket or account; the executors it calls (the Operator operations, member, invite and merge services, and the
  administration adapter above) carry their own. **Remote engine:** yes, by staying on the hub: handoffs, the
  owner question and the token check are processed on the hub. Only the executor of an `administration` command
  crosses the server/engine boundary, through the `AdministrationPort` entry above and its strict zod-checked
  commands; the integrator's token, the owner's answer and the question never cross it. After a restart of the hub
  an operation that was running is marked `unknown` and never started again by itself. The executors of the
  command kinds are wired by PM-760 and PM-764; until then execute answers 503 `super_executor_unavailable`.
  The `operate` executor (PM-831, `services/super-operator/operate.ts`, wired in `assembly.ts`) runs
  `message_send`, `project_pause`, `project_resume` and `session_stop` as the key's super actor on the same
  domain services the base Operator uses; the other operations fail with `super_operation_unsupported` (PM-832).
  It runs on the hub only, so no machine-dependent part changes. A label change in super mode (PM-831) may also
  use the key owner's holding: `planLabelsOrThrow` takes the owner from the authenticated scope and passes it to
  `planLabelChange` as `authority`; owner-reserved labels stay refused.

- **Super-mode diagnostics, full test, image build and release preparation (PM-764, Super mode 8/10)** —
  hub: `services/super-operator/{administration,facade,rights,diagnostics}.ts`, the two routes
  `routes.superOperations|superOperation` (`api/operator.ts`; the status, logs and diagnostics reads are MCP tools only), `packages/shared/src/api/super-operate.ts`. Builder (the machine that tests and builds):
  `apps/server/src/administration/executors.ts` (`createBuilderExecutors`, `FULL_TEST_COMMANDS`),
  `scripts/administration/builder.ts` (the real toolbox) and `scripts/administration/supervisor.ts`, which installs
  the executors only where the supervisor configuration names a builder (`SupervisorConfig.builder {repo, root}`,
  both absolute paths) and an absolute, NUL-free top-level `appHome` (PM-816); `scripts/cloud/images.ts`
  (`buildPinnedImage`). The protected config supplies the app home, with no environment or home-directory
  fallback; a builder configuration missing it refuses to start. `prepare --app-home` writes it on both platforms.
  **Machine assumptions:** the builder repository holds the card's commit (`git cat-file`); the full test checks
  the commit out into a detached worktree below `builder.root` (`createLocalBranchMerger.checkoutForCheck`) and
  runs `npm run merge-test` (or
  `-- --all`) in the full-test sandbox (`sandbox-exec` on macOS) at its turn in the machine's heavy-run queue
  (`defaultHeavyLockDir`, `requireHeavyLock`). Both the test and its sandboxed `npm ci` deny the configured app
  home and the shared Claude temporary roots (including `CLAUDE_CODE_TMPDIR`), `defaultSessionTmpRoot()` and
  canonical `os.tmpdir()/projectman-sessions`; the run's own sandbox, checkout and git metadata stay readable,
  as in "Server full test before review". The builder resolves these roots on its own machine, never from hub
  paths or environment (PM-816). The image build exports the commit with `git archive` (tracked files
  only, symbolic links and secret-named paths refused) and runs `docker buildx build --output type=docker,dest=…`
  into `<builder.root>/_image-build`, with no `docker load`, no registry push and no deploy. **Remote engine:**
  yes, and that is the design: the hub never reads a path or runs a test or a build. It sends the strict command
  (`full_test` / `image_build` with the card's key and the 40-hex commit) to `builderEngine()` through the
  `AdministrationPort` (`admin.submit` over the engine link) and keeps only the operation id; the test, the
  checkout, the build and the archive stay on the registered machine. Back across the boundary come the verdict, the
  exit code, the duration and the failed file names of a test, or the image digest, the archive checksum and the
  byte count of a build — never output, a path, an environment or a raw error (the toolbox's exceptions become the
  code `administration_failed`). The card commit is checked on the hub (it must be the review pin, the merge or the
  merged commit of a card of this project) and again on the builder (it must exist in its repository). A restart
  of the hub marks a running job `unknown` and never runs it again. A deploy is not installed on the supervisor
  here: the release watcher of the administration host deploys, and the hub executor only forwards a release a
  human owner approved.

- **Project change journal (PM-761)** — `apps/server/src/db/change-triggers.ts`,
  `apps/server/src/db/project-change-events.ts`, `apps/server/src/core/base/change-journal.ts`,
  `apps/server/src/api/project-events.ts`, the engine fan-out in
  `apps/server/src/runtime/sessions/engine-registry.ts`. The journal is a table in the hub's
  `db.sqlite` that the hub's own transactions write, and the long-polling read is a hub HTTP route.
  **Machine assumption:** one hub database and one hub process (the in-memory wake and the safety poll
  live in it); `project_change_generation` is bound to that database file. **Remote engine:** nothing
  runs on the engine and no journal data crosses to it: the engine's state reaches the hub through the
  engine link and the cloud registry, which is in the hub's database, so the registry's write and its
  `engine` entries are one hub transaction (the cloud composition, the engine link and the registry
  keep their inventory entries); the readers talk to the hub only. In hybrid and cloud placement the
  journal lives on the hub with the database that backup and restore carry, so a restored database
  needs a new generation (see "Project change journal", `docs/AWS.md`, `docs/HYBRID.md`).

- **Private Operator knowledge (PM-687)** — `apps/server/src/config/operator-knowledge-store.ts`,
  injected by `app.ts` through `assembly.ts` as `OperatorKnowledgeStore`. Stores the approved
  agreement (summary, involvement and extra-critical steps), up to 20 approved learned principles
  (example, principle and effect), and each member's enumerated conversational preferences in
  `<server home>/operator-data/<projectKey>/knowledge.json` and `preferences/<handle>.json`.
  These records are outside the public repository and the customization git history. PM-688 adds
  a session-bound personal preference MCP writer and authenticated REST reads. PM-1021 also
  allows the selected PM to read/write its current direct owner's five style fields in an
  internal general conversation, sharing the Operator document and CAS. PM-689 adds
  owner-approved agreement/principle CAS and marker recovery under the server's configuration
  lock; the store remains private. PM-1043 (PM-1023 K4): the selected PM now leads the agreement,
  the principles and the setup checklist: it reads the project knowledge and proposes changes
  (`propose_operator_knowledge`, without recommended operations) in its internal general
  conversation, and the checklist notices go to its queue; the store, its path and the owner's
  approval are unchanged, and the PM reaches the store only through the server (a remote engine
  needs nothing new). PM-1046 (PM-1023 K7) adds the global Operator's own instance target,
  `<server home>/operator-data/_instance/knowledge.json` (`readInstanceKnowledge`,
  `compareAndSwapInstanceKnowledge`): the same format, revision and error codes, one document for the
  whole server; `_instance` is no valid project key, so it never collides with a project. It is reached
  only through the external MCP's super tools (below); the Operator runs on the owner's machine and the
  document stays in the server's home. Missing documents start at revision zero; invalid documents are refused
  without overwriting. **Machine assumption:** one server process owns a private writable home,
  with POSIX directory/file permissions (0700/0600), no-follow file opens and same-directory atomic
  rename. Target-file CAS writes are serialized within that process, including multiple store
  instances. A synced temporary file is renamed only after the full JSON is written.
  The shared `contracts/sandbox.ts` `sensitivePaths` app-home list denies the entire `operator-data`
  root to member file tools and the existing session-policy/provider consumers; no separate
  provider rule or new permission is added.
  **Remote engine:** storage stays on the server, with no file mount on an engine. Context/MCP
  services send the current person's five preference enums to authorized Operator/PM contexts
  and MCP calls (PM-688, PM-1021), or the filtered shared
  revision/agreement/principles to internal Operator/PM contexts and authorized MCP reads
  (PM-689), across the existing boundary. Markers never enter context. No new engine file or
  machine assumption is introduced.

- **Cloud provisioning from the owner's machine (PM-532)** — `scripts/cloud/*` (`npm run cloud`),
  `deploy/aws/`, `docs/AWS.md`, `apps/server/test/cloud-*.test.ts`.
  PM-674's [rollback sheet](CLOUD-CUTOVER.md) preserves the final stopped-cloud data before
  Mac single activation. Credentials stay on the administration machine, outside member sessions.
  PM-717 adds a mandatory first-start seed integrity gate in `scripts/cloud/machine.ts`: the
  administration machine hashes the closed package DB before/after upload and compares hash/bytes
  with the stopped host through the existing SSH boundary; no engine RPC or credentials are added.
  A tool the owner runs on their Mac
  that creates and maintains the cloud board on AWS EC2: `preflight` and `aws` (PM-534: the machine,
  the security group, the two S3 buckets, the two IAM users and their access keys), the machine part
  (PM-535, the next entry), Cloudflare (PM-536, the entry after it) and the DNS move (PM-537,
  `scripts/cloud/dns.ts`: Route 53 read/import, authoritative verification using `CloudDeps.resolve`
  with name-server IPs resolved locally first, public delegation/DS through Cloudflare and Google DoH,
  Route 53 Domains registration status and explicit `dns switch [--back]` in `us-east-1`, and `up`
  orchestration). Forward switching requires successful verification in the same run and no DNSSEC
  keys or public DS; rollback targets the retained AWS delegation set. It calls the `aws` CLI v2 with argv (profile and
  region from the configuration, no SDK) through the injected `CloudDeps`, never a shell. Machine
  assumptions: the `aws` CLI v2 with explicit profiles on the owner's Mac (PM-664: central resources
  in `aroom`, registrar/retained Route 53 source reads in `i` through `route53.profile`; absent:
  `aws.profile`), later `ssh`/`scp`, and the secrets
  store `~/.config/projectman/cloud/` (directory 700, files 600, symbolic links and wider modes refused;
  `config.json`, `cloudflare-token`, `cloud.env`), which sits under `~/.config/projectman`, a path the AI
  sessions' sandboxes deny. No state file: resources are found by name/ownership tags. **Remote engine:** nothing runs on
  an engine; this is the owner's tool and the cloud machine it provisions is the server side. The
  `cloud.env` it writes is what the container of "Cloud deployment and backup" reads.
  **Module:** `scripts`

- **EC2 provisioning and account boundary (PM-676, part of PM-664)** — `scripts/cloud/{config,aws,aws-cli,ec2,commands}.ts`,
  `deploy/aws/{config.example.json,ec2-bootstrap.sh}`, `apps/server/test/cloud-ec2.test.ts`,
  `apps/server/test/helpers/fake-ec2.ts`, `docs/AWS.md`. **What runs where:** owner-only AWS CLI v2
  on the Mac reads STS identity and provisions one Ubuntu 24.04 HVM/EBS EC2 instance in the
  configured central profile/region, existing VPC/public subnet, dedicated empty-inbound security
  group, EC2-only SSM host role/profile, and the shared private S3/backup-user resources. EC2 type,
  AMI and encrypted gp3 volume size are explicit, never paid defaults. Catalogue/preflight checks
  Canonical image ownership and exactly one persistent root EBS mapping (ephemeral AMI mappings
  are accepted), VPC/subnet/account, DNS, effective IGW route, conservative IPv4 NACL
  reachability and type support/AZ offering. Public IPv4 is outbound access for apt/Docker/SSM/tunnel;
  no NAT/LB/extra host, no public ingress. IMDSv2/hop-limit 1, termination protection and shutdown=stop.
  **Machine assumptions:** owner logins `aroom`/`i`, AWS CLI, selected existing internet network,
  Ubuntu apt/snap/systemd; public bootstrap installs sshd/EIC/SSM with no secret or board payload.
  The script prints instance/EBS/IPv4 cost components before launch; the owner records regional
  rates and approves execution. The newly created security group is read/validated with bounded
  propagation waits before launch; launch-time group/profile propagation retries keep the same token.
  Names/managed tags and a deterministic public-request ClientToken
  recover partial runs/restarts; ambiguity, foreign ownership or dangerous drift refuses creation,
  with no automatic destructive repair. `--dry-run` writes nothing. **Remote engine:** provisioning
  remains on the owner's machine for the central server, never on an engine; the Mac engine gets
  no AWS credentials, and no new server/engine RPC or payload crosses the boundary. SSH over SSM
  host operation is provided by PM-677 (next entry); EC2 is the only compute (PM-1036).
  PM-718 adds explicit `aws.ec2.architecture` (`x86_64` by default, or `arm64`): the Canonical
  AMI name/Architecture, type capabilities and existing instance must agree. Native apt/snap
  bootstrap works on both; ARM requires an external image bundle. The approved PM-675 target is
  Frankfurt/t4g.micro/Ubuntu 24.04 arm64/20 GiB gp3; creation still requires concrete owner approval.

- **EC2 host administration through SSM (PM-677, part of PM-664)** —
  `scripts/cloud/{ec2-host,host,machine,commands,deps}.ts`, `apps/server/test/{cloud-ec2-host,cloud-deps}.test.ts`,
  `apps/server/test/helpers/fake-ec2-host.ts`, `apps/server/test/fixtures/fake-cloud-process.mjs`,
  `docs/AWS.md`, `docs/HYBRID.md`. **What runs where:** on the owner/integrator's POSIX machine,
  AWS CLI v2 with the explicit central profile/region (`aroom`), session-manager-plugin, ssh,
  ssh-keygen and tar; on EC2 Ubuntu 24.04, sshd/EIC/SSM and the existing sudo `host.sh`, Docker and
  systemd. `withHost` dispatches by compute; the unchanged `HostSession` contract and stdin/stream
  payloads use an instance id for EC2's address. Lookup requires a unique managed running instance
  and exact Online SSM target. A fixed, instance-scoped `AWS-RunShellScript` reads only the ed25519
  public host key (bounded 120-second poll, strict text/binary key validation, no raw failure output).
  Temporary 700 directory/600 key and known_hosts pin that authenticated key with strict SSH checking.
  EIC receives only the ephemeral public key for `ubuntu`/actual AZ immediately before each SSH
  connection; ProxyCommand uses validated, quoted AWS `AWS-StartSSHSession`, port 22. Cloud env/tar
  stay inside SSH encryption, never in SSM command/UserData/argv. There is no ingress mutation,
  public-SSH fallback, TOFU or imported permanent key. **Machine assumptions:** the caller has
  DescribeInstances, SSM lookup/RunCommand/start/describe/terminate-session and EIC caller rights;
  EC2 agents/tunnel connect outbound. POSIX process groups close SSH/AWS/plugin descendants even
  with inherited output, timeout or interrupt; pipe ends carry an additive AbortSignal. Cleanup
  reads all active-session pages before termination and matches the exact instance plus a set of
  random public reasons, unique per connection. It obtains at least three complete snapshots
  2s apart and a fresh empty verification after termination, within a 30s total AWS-phase deadline
  including the 5s process shutdown grace. It removes key files/handlers independently of AWS
  failures. Failed verification reports the public target/reasons, preserves the operation error
  and exits 1; the observation window is not an AWS consistency guarantee.
  Existing host paths, container uid 10001, loopback networking and one-writer/restore guards stay
  the same. **Remote engine:** this runs only on the owner's administration machine for the central
  server; no AWS credentials or new RPC/payload crosses the server/engine boundary. It works
  independently of the Mac engine link. Live execution/recovery remains an approved owner round.
  PM-748 adds fault tolerance to the same transport (`scripts/cloud/{ec2-host,host,errors}.ts`): a second
  fixed read-only `AWS-RunShellScript` reads `Ec2HostDiagnostics` (CPU count, 1-minute load, available
  memory, free disk, cumulative OOM kills, EIC status-124 journal count of the last 10 minutes) on EC2;
  nothing else leaves it. On the admin machine, `status` and a connection probe retry at most 3 times
  (5 s, 15 s; 120 s total including child shutdown) with a fresh EIC key each; state changes and
  tar/secret streams are never repeated and a lost answer raises `CloudTransportError` with
  `commandStarted: 'unknown'`. The first state change of a session waits (same bound) for a not-busy
  machine (`load1 <= 2 x CPUs`, `>= 128 MiB` available) and refuses otherwise. **Remote engine:** all
  AWS/EIC/SSM calls stay on the admin machine, the measuring commands run on EC2; the engine gets no
  AWS credential and only measurement metadata crosses the admin–cloud boundary. Related task: PM-748.
  PM-753 narrows its key-refusal match: stderr merges the ssh client's lines with the remote command's, so
  for a state-changing command only a stderr that is the client's single `user@host: Permission denied
(publickey...)` line (plus `Warning:`/SSM session noise) means `commandStarted: 'no'`; any other output
  that mentions it stays `unknown`, not retryable. Reads keep the loose match. **Remote engine:** unchanged,
  admin machine only. Related task: PM-753.
  PM-1029 removes the completed PM-675 trial commands and their embedded host program.
  Host administration no longer needs Python3 or provides trial archival/deletion operations.
  **Remote engine:** the remaining host operations still run on EC2 through SSH/SSM from the
  administration machine; no engine RPC or new machine assumption is added.
  PM-717 carries `seed-digest` over this same SSH/SSM session, with no arguments or stdin payload:
  only the database SHA-256 and byte count return. On Ubuntu 24.04 the host uses coreutils to read
  the fixed `/var/lib/projectman/data/db.sqlite`, refuses live/starting units, non-regular/symlink
  DBs and sidecars, and checks for detectable writes and stopped state after hashing. A failed
  integrity gate preserves uploaded data and prevents build/start; recovery needs an owner decision.
  PM-718 adds `receive-image` on the same encrypted stdin stream: only the selected native-platform
  Docker tar crosses to EC2. Root-only temporary storage, bounded size, SHA-256, free disk, sole tag,
  config digest/platform/revision/version checks precede import; image inspect verifies the result.
  Only strict imageId/platform/revision JSON returns. Docker load output stays on stderr. No registry
  or credentials cross this boundary, and no container or DB starts during import.
  Ubuntu util-linux `flock` serializes import/build/start through the root-only
  `/var/lib/projectman/.image.lock`; current/previous immutable IDs are never dangling-image pruned.
  PM-725 also serializes bootstrap under this lock. On the Ubuntu host, `host.sh` installs `jq`
  before Docker dependencies, then atomically sets `/etc/docker/daemon.json`
  `features.containerd-snapshotter=false` (root:root, 0644), preserving unrelated settings and
  refusing malformed JSON, symlinks and non-regular configuration files. Actual `docker info`
  must report `Driver=overlay2` without the containerd snapshotter marker in `DriverStatus`.
  An existing unsupported store needs a Docker restart, allowed only with a provably stopped board
  and no current/previous deploy history; unavailable or malformed daemon information fails closed.
  A running classic daemon is not restarted. The result is verified; import/start repeat the
  store check under the lock before side effects and retain strict config-digest image IDs.
  Switching stores hides the old images/containers, so the approved bundle must be imported again;
  bootstrap neither migrates nor deletes old store data and leaves the bind-mounted board data intact.
  **Remote engine:** configuration, apt, restart and store checks run only on the central Ubuntu
  host over the existing SSH/SSM channel. No new payload, credential or engine RPC is introduced.

- **The cloud machine and its operation (PM-535, PM-718, PM-725; EC2 is the only compute since PM-1036)** —
  `scripts/cloud/{host,machine,images}.ts`,
  `deploy/aws/{host.sh,projectman-cloud.service}`, `apps/server/test/{cloud-host,cloud-machine,deploy-aws}.test.ts`,
  `apps/server/test/helpers/fake-host.ts`. PM-718's optional `deployment.imageBundle`: without it, the
  existing amd64 host build remains; with it, import
  precedes env/start without build fallback. History adds optional imageId/platform; status adds
  actual container imageId. Prebuilt start uses an immutable ID; health and rollback check/carry it
  and the source SHA. ARM refuses builds and digestless starts/rollback. Operations stay on the
  admin machine/target host, independent of remote engines.
  PM-725 applies the same explicit `/etc/docker/daemon.json` classic-store setting, stopped-board
  and empty-history restart guard, actual-daemon checks and required bundle reimport described
  in the EC2 host channel entry above. This is an Ubuntu-host assumption; Docker Desktop and
  remote engine configuration are unchanged.
  The commands `deploy`, `rollback`, `status`, `logs`, `ssh`,
  `stop`, `start`, `rehearse`, `seed` and `pull-data` of `npm run cloud`. **What runs where:** on the
  Mac `ssh` (and `git ls-remote`, `tar`, the `aws` CLI); on the Ubuntu machine, as root through
  `sudo bash -c '<host.sh>' host.sh <subcommand>` (the script travels as the `-c` argument, so the
  standard input carries the payload: the unit file, `cloud.env`, a tar stream), Docker, git, `jq`
  and systemd. The unit `projectman-cloud.service` runs `docker run` of the image
  `projectman-cloud:<commit id>` with `/etc/projectman/cloud.env` and only `/var/lib/projectman/data`
  mounted; it publishes no port (the Cloudflare tunnel connects outwards), uses no host network, no
  extra privilege and no Docker socket (`deploy-aws.test.ts` checks it). State on the machine:
  `/etc/projectman/{cloud.env,image.env}`, `/var/lib/projectman/{data,deploy.json}` (`current`,
  `previous`, `lastStoppedAt`), the checkout `/opt/projectman/src`. **Machine assumptions:** the
  machine is Ubuntu 24.04 with `apt`, `systemd` and Docker from the distribution; the owner's Mac has
  `ssh` and reaches the machine through SSM with an ephemeral key (the EC2 host channel entry above;
  no inbound rule, no public-address lookup). The build happens on the 2 GB machine (swap file, 3 GiB free-disk check). The released
  image is tagged with the full commit id, which is also `PROJECTMAN_VERSION`. **Does this work on a
  remote engine?** Nothing in it runs on an engine: it is the owner's own tool for the server side, and
  the engine neither calls nor depends on it. The entries "Cloud provisioning" and "Cloud deployment
  and backup" are the other parts of the same chain.
  PM-717 applies the mandatory `seed-digest` gate here too: the owner tool
  compares source before/after SHA-256 and bytes with the stopped Ubuntu host before any build/start.
  It assumes coreutils `stat`/`sha256sum`, a closed package and a single administrator during cutover;
  no new port, persistent state, engine operation or server/engine payload is introduced.

- **The Cloudflare side of the cloud board (PM-536)** — `scripts/cloud/cloudflare{,-api,-publish,-check}.ts`,
  the `guard-check` subcommand of `deploy/aws/host.sh`, `deploy/cloudflare/check.sh`,
  `apps/server/test/cloud-cloudflare*.test.ts`, `apps/server/test/helpers/fake-cloudflare.ts`. The commands
  `edge`, `publish`, `check` and the Cloudflare part of `preflight` of `npm run cloud`: they call the
  Cloudflare API v4 over HTTPS with the owner's own API token (`CloudflareApi`: one `fetch` through the
  injected `CloudDeps`, a read-only mode for `--dry-run`, retry on 429) and make the zone, its edge
  settings, a header transform rule, the One-time PIN provider, the two service tokens, the Access
  policies and applications, the tunnel with its ingress, `TUNNEL_TOKEN` in `cloud.env`, and last the
  proxied CNAME. `check` runs `check.sh` (`cloudflared` and `curl` on the Mac), the three engine doors
  and `deploy/cloud/smoke.sh`. **Machine assumptions:** the commands run on the owner's Mac; the token
  file `cloudflare-token` and the two service token files (`engine-access-token.json`,
  `integrator-access-token.json`) are in the secrets store `~/.config/projectman/cloud/` (mode 600, a path
  the AI sessions' sandboxes deny); the owner has done `cloudflared access login` for `check`. Secrets
  never go into an argument: the service token secrets and the login file travel in the environment of
  the child process, and the output masks them. **Does this work on a remote engine?** Nothing here runs
  on an engine and no engine holds the API token. What crosses the boundary: `cloud.env` to the machine
  (by `deploy`), `guard-check` over the machine's SSH connection (it asks the container's own guard), and
  `engine-access-token.json`, which is the engine's `linkHeadersFile` content (HYBRID.md) and is put on an
  engine by the owner.
  **Further owners (PM-1065):** each `access.owners` entry gets its own engine and integrator service
  token and policies (`<tunnel>-owner-<id>-…`) and its own two files under `owners/<id>/` in the same
  secrets store (folder 700, files 600; the host's token, policy and file never change). `edge` adds the
  policies to the engine and integrator applications and removes only a left owner's objects (policies,
  then tokens, then files). `check` tries each owner's pair from the host's copy of the files. Machine
  assumption: the same host Mac and store. Remote engine: still nothing runs on it; an owner's engine
  gets its file by hand from the host, outside projectman.
  **Separate machine entrance (PM-675):** optional explicit `cloudflare.integratorHostname`, required
  with a public integrator service token, has its own Service Auth application and audience on the same
  tunnel. Only literal `/api/...` and exact `/mcp` reach the hub on that host. `edge` writes
  `PROJECTMAN_INTEGRATOR_HOSTNAME`; `publish` verifies the running backend's `integratorHostIsolated`
  result before making its DNS record, including during private staging. `check` tests both machine
  audiences and deliberately sends a valid human cookie to the machine host (401). The CLI still runs
  on the admin machine and sends credentials only through protected files/environments. The Mac engine's
  `/engine`, key and outbound connection are unchanged; no new engine operation or inbound port exists.
  **Public board (PM-672):** with `access.boardMode: public` the same commands leave the main hostname
  without Access (one Bypass policy), keep `/engine` behind its own Access application (the engine service
  token only; the tunnel's `originRequest.access` for `/engine` names only that application's audience),
  answer `/hooks` and `/mcp` with 404 at the tunnel, and write `PROJECTMAN_PUBLIC_BOARD=1` into `cloud.env`
  (the server then refuses to start without cloud mode, an owner and the e-mail login:
  `apps/server/src/auth/public-board.ts`). `host.sh public-check <hostname>` is a second subcommand run over
  the same SSH connection as `guard-check`: it asks the running container for its own anonymous answers.
  `publish` creates the DNS record only on the exact answer, `check` runs `check.sh` with `BOARD_MODE=public`
  (no `cloudflared` login). **Remote engine:** unchanged; the public side is only the browser login boundary,
  the engine still connects outward to the protected `/engine`.

- **SES identity/DKIM and sender provisioning (PM-678, part of PM-664; own account PM-729)** —
  `scripts/cloud/{ses,config,commands,cli,secrets,aws-cli,cloudflare-api}.ts`,
  `deploy/aws/config.example.json`, `apps/server/test/cloud-ses.test.ts`,
  `apps/server/test/helpers/fake-ses.ts`, `docs/AWS.md`, `docs/HYBRID.md`.
  **What runs where:** the owner's approved provisioning CLI adds optional version-1
  `ses:{profile?,region,domain,from}`; PM-729 adds the optional `profile` (absent: `aws.profile`, resolved
  at load time without rewriting the file), so SES (identity, production access, the narrow sender IAM
  user and its key) can live in its own account (`i`) while compute/S3/host IAM stay in `aws.profile`.
  `ses plan` reads STS, SESv2 identity/account and Cloudflare DNS;
  `ses configure [--dry-run]` additionally verifies managed IAM ownership/groups/policies/keys,
  creates or retains the Easy DKIM domain, converges only three DNS-only CNAMEs from AWS tokens and
  SigningHostedZone, restricts `<instanceName>-ses` to `ses:SendEmail` on the region/account/domain
  identity with an exact `ses:FromAddress`, and writes the dedicated credential/env flags.
  Unknown/inactive/extra keys, foreign user state or conflicting mail DNS are refused, with no
  automatic rotation; partial operations are rediscovered, a lost key response needs owner repair.
  `ses request-production [--dry-run]` is a separately approved transactional invited-customer OTP
  request, not configure/up side effect; acceptance of the request is not production approval.
  `ses check` reads verification/DKIM, production/sending, exact DNS/IAM and local sender config;
  no command sends mail. With the optional `ses.inbound.replyDomain` (PM-945) the same `ses-send` policy
  also carries `ses:SendEmail` on the configuration set and the SQS read on one queue; `ses configure` and
  `ses check` keep that extended policy when it is already in place. Cloudflare list responses are shape-checked so malformed reads cannot
  be mistaken for missing records. **Machine assumptions:** AWS CLI v2/profiles on the owner's
  POSIX administration machine; every AWS call explicitly targets `ses.profile` and the SES region,
  and the key is handed over only through the protected `cloud.env` (no profile env, the backend sends
  directly with the target account's narrow key; a key of a former account is refused, not replaced).
  Existing authoritative Cloudflare zone and protected
  DNS token, no domain transfer or cross-account SES authorization. The cloud store is 0700 and
  `cloud.env` 0600, with unsafe modes/symlinks refused and other env keys preserved; credentials
  never enter argv or reports. Live configuration/request/deploy each needs owner approval;
  sending cost appears in the preview. **Remote engine:** nothing runs on the Mac engine and it
  gets no SES/AWS key. Only the existing approved deploy channel carries cloud.env to the central
  backend (PM-669); no server/engine RPC or credential boundary change. AI sandbox protection of
  `~/.aws` and the cloud store remains in force.

- **The e-mail login code mailer on AWS SES (PM-669)** —
  `apps/server/src/services/email-login/{ses-mailer,config}.ts` (facade `index.ts`),
  `apps/server/src/contracts/email-login.ts`, the six `PROJECTMAN_EMAIL_LOGIN_ENABLED` / `PROJECTMAN_SES_*`
  variables (read in `apps/server/src/index.ts` only, then immediately removed from `process.env`
  before the application version lookup can start a git child process),
  `deploy/cloud/entrypoint.sh`, `docs/AWS.md` ("The e-mail login code mailer"). **What it does:**
  `createSesEmailCodeMailer` sends one Hungarian message (the text is `emailLoginCode` in
  `packages/templates/src/locales`) through the SES v2 `SendEmail` operation with explicit keys and an
  endpoint pinned to the region; no `AWS_*` variable, profile or credential chain is read. It keeps no
  state and logs no address or code; a provider failure is a sanitized `EmailCodeDeliveryError`. The
  login itself (PM-670, the next entry) is its consumer through `BuildAppOptions.emailCodeMailer`.
  **Machine assumptions:** the keys are lines of the owner's `cloud.env` (the secrets store of the entry
  "Cloud provisioning"), which `deploy` sends to the machine; inside the container the entrypoint gives
  `PROJECTMAN_*` to the server process only, the restore rehearsal switches the mailer off, and the runner's
  child environment drops every `PROJECTMAN_` name. **Does this work on a remote engine?** Yes: sending and
  the keys live only in the cloud board; the engine, its link and its protocol do not change, and a
  disconnected engine does not stop the mail.

- **The e-mail login of invited clients (PM-670, part of PM-664)** —
  `apps/server/src/auth/email-login-routes.ts` (`POST /api/auth/email/request` and `/verify`, public),
  `apps/server/src/services/email-login/login-service.ts` (codes, limits, redemption),
  `apps/server/src/core/members/client-standing.ts` (who is eligible; accepts the open client
  invitations), `apps/server/src/db/email-login.ts` (tables `email_login_codes`, `email_login_events`,
  migration 60), `auth/secret.ts` (`deriveEmailLoginKey`). **What it does:** a person who is a client and
  nothing else (a client account or an open client invitation, not the host owner, no other access in any
  project) gets a six-digit code by mail and redeems it for a session; a first redemption creates a
  passwordless account and accepts every open client invitation of the address. Addresses, client IPs
  and codes are stored only as HMAC-SHA-256 hashes; the key is derived (HKDF, own label) from the
  `secret` file, so a copied database alone cannot be tested against guessed addresses. All limits count
  durable rows, so a restart does not reset them. **Machine assumptions:** the client address comes from
  `PROJECTMAN_CLIENT_IP_HEADER` (a trusted loopback proxy sets it; without it every client counts as
  `127.0.0.1` and shares the IP limits). For this service, `kernel/local-request.ts`'s `ipRateLimitKey`
  groups IPv6 addresses by canonical /64 and keeps IPv4 addresses whole, including mapped IPv4 (PM-703);
  other limiters retain their existing keys. The `secret` file in the home and the SQLite database
  are also local assumptions. **Does this
  work on a remote engine?** Yes: everything runs in the cloud board (hub); no engine request is made,
  and no engine protocol or payload changes.

- **E-mail channel sender (SES) (PM-941)** —
  `apps/server/src/services/email-channel/{service,ses-sender,render,config}.ts`,
  `apps/server/src/mcp/email-channel/`, `apps/server/src/api/email-channel.ts`,
  `apps/server/src/auth/secret.ts` (`deriveEmailReplyKey`). **What it does:** an enabled AI member sends a
  filtered, rate-limited e-mail to a consenting human, immediately or after owner approval; the hub stores
  only a hash of the reply token. From: the member's mailbox on the reply domain, falling back to
  `PROJECTMAN_SES_FROM` (a mailbox conflict, or the provider refusing the address). **Machine assumptions:** the hub reads `PROJECTMAN_EMAIL_CHANNEL_ENABLED`,
  `PROJECTMAN_SES_*`, `PROJECTMAN_EMAIL_*` from `cloud.env` in `index.ts`, deletes them before starting a
  child process, and makes the outgoing HTTPS call to the region's SES v2 endpoint with explicit keys.
  **Does this work on a remote engine?** Yes: sending, filtering, approval and token generation all run on
  the hub; an engine receives no AWS credentials, no SES request and no protocol change.

- **E-mail channel inbound (SES receiving → SNS → SQS) (PM-945)** —
  `apps/server/src/services/email-channel/sqs-source.ts` (reader, `createAwsSqsClient`), its wiring in
  `apps/server/src/assembly.ts`, `scripts/cloud/{ses-receive,ses,config,commands}.ts`,
  `deploy/aws/config.example.json`, `apps/server/test/cloud-ses-receive.test.ts`,
  `apps/server/test/helpers/fake-ses.ts`, `docs/AWS.md` ("Receiving e-mail replies"). **What it does:** SES
  receives the replies on the reply subdomain and publishes them (and the bounce, complaint and delivery
  events of the configuration set) to an SNS topic; an SQS queue with a dead-letter queue holds them; the
  hub's reader long-polls the queue and hands each mail or event to the e-mail channel (PM-943), deleting
  the message only when it was handled. `ses receive-plan|receive-configure [--dry-run]|receive-check` of the
  provisioning CLI create and verify the MX record, the reply identity, the topic, queues, subscription,
  configuration set, receipt rule set and the extension of the sender's IAM policy (the SQS read on one queue
  and `ses:SendEmail` on the configuration set and from member addresses on the reply domain identity,
  PM-1016). **Machine assumptions:** the hub makes outgoing HTTPS calls
  to the region's SQS endpoint with the existing `PROJECTMAN_SES_*` key and reads
  `PROJECTMAN_EMAIL_QUEUE_URL`, `PROJECTMAN_EMAIL_REPLY_DOMAIN`, `PROJECTMAN_EMAIL_CONFIGURATION_SET` from
  `cloud.env` (read in `index.ts` only); the CLI runs on the owner's POSIX administration machine with AWS CLI
  v2 profiles and the Cloudflare DNS token, like the SES provisioning entry. **Does this work on a remote
  engine?** Yes: the reader runs on the hub only; an engine gets no queue, no key and no protocol change.
  **Member addresses (PM-989):** the same receipt rule also takes mail to `<mailbox>@<reply domain>`, the
  permanent address of an AI member (`services/email-channel/inbound.ts`, `receiveDirect`; the mailbox name
  is the handle or `ai.email.mailbox`, unique server-wide). The mail lands in the member's conversation as a
  reply linked by MIME headers when answering a member's mail (PM-1018), otherwise as a direct
  team message, and its attachments go through the message-attachments storage on the hub, so nothing new
  crosses to an engine. **Rename (PM-1025):** a rename deletes `ai.email.mailbox`, so the address becomes
  `<new handle>@<reply domain>` (it is refused with `email_mailbox_taken` when that mailbox is another
  member's). Mail to the old address still arrives: `emailMailboxOwners` also matches the `formerHandles`
  of an AI member, so the old name resolves to the same member; a live holder of the same name does not
  win over it but shares it, and the existing shared-name branch parks the mail. The old name stays reserved
  in every project (`emailMailboxReserved`): no chosen mailbox, e-mail switch-on or rename may take it.
  No new boundary: it is the same hub-only rule.

- **Feedback widget public entrance and screenshot store (PM-506, PM-508)** —
  `apps/server/src/services/feedback/{service,screenshots,notices,widget}.ts`, `apps/server/src/api/feedback.ts`,
  `PROJECTMAN_FEEDBACK_PUBLIC_URL` (read in `apps/server/src/index.ts` only), the table family
  `feedback_*` and `PROJECTMAN_HOME/feedback/`. The app side (this card) is cookie authenticated and
  runs on the server; the public entrance for the tool on customer pages (a later card) will be an
  internet-facing address of the server, whose origin and launch codes are bound to the surface. The
  screenshots (originals and WebP thumbnails, made with `sharp`) are files in the server's home next to
  the database and the attachments; the card's copy goes through the attachment service. The settings
  view shows the public address and the sessions the tool holds. Assumes one server host for the
  database, the screenshot files and the public entrance. **Remote engine:** everything runs on the
  server; an engine needs nothing from it and receives a mark's screenshot only as the card's
  attachment, over the existing attachment transfer. The processing (PM-512) runs on the server too: the
  wake-up message to the project manager (`services/feedback/notices.ts`) is an ordinary stored team message,
  and the feedback team tools (`mcp/feedback/`) are answered by the server.
  `get_feedback { mark_id }` hands the stored screenshot's absolute path (`FeedbackScreenshotStore.locate`) only
  to a session whose engine is the local one (`getFeedbackMark`); a session on a remote engine gets none
  and reads the image as the card's attachment (`read_attachment`, PM-315) after
  `create_task_from_feedback`. In the hybrid mode the `feedback` folder is carried
  with the other data (`HYBRID_CLOUD_ENTRIES`) and the public entrance belongs to the cloud server.

  **The public widget API (PM-509)** — `apps/server/src/api/feedback-widget.ts`,
  `apps/server/src/services/feedback/widget.ts`, routes `routes.feedbackWidgetScript()`
  (`/feedback/widget.js`) and `routes.feedbackWidgetApi()` (`/feedback/api/v1`). Outside `/api`, so
  its own guard applies: an `onRequest` hook checks the `Origin` (the address of some project's
  surface, else 403 `feedback_origin_not_allowed`), answers the CORS preflight (no credentials,
  `no-store`, `Vary: Origin`) and checks the bearer session on every request (401
  `feedback_session_invalid`), all before the body is read. `POST /sessions` swaps a single-use launch
  code for a session (30 days sliding, 90 days at most; token kept as a hash); marks, comments, the
  list (`?since` cursor) and the read mark are limited per session and hour (30 marks, 120 comments,
  in memory) and per project and day (500 marks, from the database), answering 429 with `Retry-After`.
  The widget sees only its surface's marks and never the environment, screenshot or forward reason.
  `/feedback` is a server prefix, so an unknown path there is a JSON 404, not the web app. The script is
  `apps/feedback-widget/dist/widget.js` under the install directory (`feedbackWidgetFile` in
  `index.ts`; 404 until it is built, a later card). The caller is a browser on the customer's page and
  the public address of the server (`PROJECTMAN_FEEDBACK_PUBLIC_URL`) is the only machine assumption.
  **Remote engine:** nothing runs on an engine; the API, its sessions and limits live on the server, and
  the engine is not involved. Security notes: `docs/SECURITY.md` "The feedback tool's public API".
  **Module:** `services/feedback`

- **Live release watcher (PM-387, PM-493)** — `scripts/live/*` (`npm run live`, `npm run release-test`),
  `apps/server/test/live-*.test.ts`. Two macOS LaunchAgents (`com.projectman.live` for the server,
  `com.projectman.live-watcher`, one round a minute) switch the owner's live checkout
  (`~/projectman-live`) to a release the owner approved: fetch, build, release test, configuration check,
  then pause, stop, database backup, atomic directory switch, verification, and on success tag and
  GitHub release; on a failure it puts back the previous build and the backup. The state is a journal in
  `~/.projectman/release/` (denied to the sessions' sandboxes in `contracts/sandbox.ts`); the watcher
  talks to the server through the control socket (`release_next`, `release_claim`, `release_report`).
  **launchd teardown (PM-584):** `scripts/live/launchd.ts` polls `launchctl print` after `bootout`
  until the job is absent (up to 120 s), before cutover or rollback continues; `bootstrap` retries
  exit status 5 every 500 ms for up to 30 s. A rollback whose unload fails stays in its journal step
  for the next watcher round. These waits run on the macOS server host; no engine boundary changes.
  It needs launchd (`launchctl`), the user's `gui/<uid>` domain, `git`, `npm`, `sqlite3`, `lsof`, the
  `gh` CLI login and git access to the GitHub remote, the live checkout, the data home and its control
  socket on one machine, and the machine's heavy-run queue. **Remote engine:** the watcher belongs to the
  server's machine, not to an engine: it switches the one live server and its database, which never run on
  an engine. An engine needs nothing from it; a hybrid installation (`PROJECTMAN_MODE=hybrid`) is refused
  by the install, as another process supervisor and release path would be needed.
  **What the plists start (PM-514):** `ProgramArguments` begins with a launcher of the live checkout
  (`scripts/live/bin/projectman-live`, `projectman-release-watcher`; `exec "$@"`), because macOS names a
  background item (System Settings → Login Items & Extensions) after that first element, then the stable
  `node` path (`scripts/live/node-path.ts`: the `PATH` entry that is the running binary, not the versioned
  Homebrew `Cellar` path, which a `brew upgrade node` removes). `live status` checks both files exist. Machine
  assumption: macOS's background-item naming and an unsigned launcher; Homebrew's `bin` link. A remote engine
  has no such plist. PM-751's hybrid release watcher is a separate agent beside it (next entry); this one
  still refuses a hybrid installation.
  **Module:** `scripts`

- **Hybrid release coordinator (PM-751, part of PM-735)** — `scripts/release/*.ts`,
  `scripts/release/bin/projectman-hybrid-release-watcher`, `npm run release`, `docs/DEPLOY.md` ("The hybrid release watcher"), `apps/server/test/release-*.test.ts`,
  `apps/server/test/helpers/{hybrid-world,fake-launchd}.ts`. **What runs where:** the administration Mac runs
  one `HybridCoordinator` round at a time (a `com.projectman.hybrid-release-watcher` LaunchAgent, `StartInterval`
  60, `watch.lock`). It drives the cloud's PM-752 deployment protocol (`release_deploy_*`) through
  `npm run cloud`'s `release-control` relay (one request line, one response line over the verified SSH/SSM
  session; `scripts/cloud/*`, `deploy/aws/host.sh`), the cloud machine through the cloud scripts (image import,
  start, the `release-probe` check) and the Mac engine through `scripts/engine/service.ts` (the
  `com.projectman.engine` plist, `launchctl` `bootout`/`bootstrap`). **Machine assumptions:** macOS `launchctl`
  and `~/Library/LaunchAgents`; the stable admin checkout and `node` path named in the plist (a member
  workspace is refused; the plist environment is `HOME`/`PATH`/`LANG`/`TZ` only); the protected
  `~/.config/projectman/cloud/` tree (0700/0600, no symbolic links) for the configuration, the AWS profile
  and the state directory (journal, lock, saved engine plist, last error: all 0600, atomic writes); the
  engine's pid is checked with `kill(pid, 0)` and the process is never killed; `git` and `gh` on the Mac for
  the tag and the GitHub release (the old decision 35 logic, from the candidate checkout, no token in the
  plist); the machine's heavy-run queue lock, which the coordinator holds from the drain to the end of the
  attempt so no other heavy run starts while the service is switched. **Remote engine:** the coordinator is the
  administrator's tool and stays on the Mac. With the engine itself on another machine it would need the
  engine-side half of `EngineControl` (stop with proof, service start, the plist snapshot and restore) behind
  an engine-owned boundary; today that half is `scripts/release/adapters.ts` `enginePort` and works for the
  Mac engine only. What crosses the Mac/cloud boundary is fixed metadata only (release id, commit, hashes,
  phase, a fixed failure code); no raw error, path or secret is carried into the journal, the status, a
  release alert or the card. The coordinator never kills a process, never leaves `recovery_required` by
  itself and never restores data. **Module:** `scripts`

- **Feedback widget public entrance (PM-506)** — the hostname without Access for the marking widget on
  customer pages (PM-513). Code: `PROJECTMAN_FEEDBACK_PUBLIC_URL` checked at start in
  `apps/server/src/index.ts` (`parseFeedbackPublicUrl`; a wrong value stops the server), the host guard
  `apps/server/src/http/feedback-host-guard.ts` (an `onRequest` hook registered first in `app.ts`; on the
  public `Host` it answers the unknown-route 404 to every raw path except `/feedback/widget.js` and
  `/feedback/api/v1/<segments of [A-Za-z0-9_-]>`), `PASSED_VARIABLES` in `scripts/live/plist.ts` (the
  LaunchAgent gives the server only the variables named there),
  `deploy/cloudflare/config.example.yml` (two rules for the hostname: `^/feedback/` to `127.0.0.1:4800`,
  then a 404 rule) and `deploy/cloudflare/check.sh` (`FEEDBACK_ORIGIN`). Machine assumption: the tunnel
  (`cloudflared`) runs on the server's machine and forwards to its loopback port with the original `Host`
  (no `httpHostHeader`), which the guard reads; the Cloudflare account and the DNS record are outside the
  repository. The hybrid cloud image uses a token-managed tunnel, with the variable given by whoever
  installs it (`docs/HYBRID.md`); on EC2 `npm run cloud -- edge` sets the tunnel, the ingress and the
  variable through the Cloudflare API (PM-536). **Remote engine:** the entrance belongs to the server
  (in the hybrid mode, the cloud one); an engine receives no such traffic and needs nothing from it.
  Security notes: `docs/SECURITY.md` "The widget's public hostname".
  **Module:** `http`

- **Full test trial CLI (PM-386, PM-490)** — `scripts/full-test/cli.ts` runs a command in the current
  checkout through `createFullTestExecutor`, `fullTestSandbox` and `defaultHeavyLockDir`. It reports
  outcome, elapsed time, failed files and output tail. It needs macOS Seatbelt, srt, PTY support and
  the machine's heavy-run queue; run it outside member sandboxes, which cannot start nested Seatbelt.
  The checkout and common git directory are readable; the user/app homes are denied except those
  paths. `PROJECTMAN_FULL_TEST_SANDBOX=1` marks the command for tests that cannot run there.
  **Remote engine:** run the CLI on the engine machine with its checkout, git directory, sandbox
  dependencies and queue. Only the command and result need to cross the existing full-test boundary.
  `scripts/merge-test/{run,scope,impact,shared-impact,runtime-entries}.ts` (PM-657, PM-843, PM-864) selects checks in that detached checkout using
  argv-based git first-parent diff (`--no-renames -z`) and batched blob reads of both revisions.
  It uses the architecture module map, never evaluates old TypeScript or writes a selection cache,
  and retains the configured worker limits. Server contracts/config, changed tests/snapshots, helpers
  and script code use the server/script graph. The audited `RUNTIME_ENTRIES` table supplies runtime
  edges; unknown launchers stay uncertain, filesystem imports alone do not. Fixtures, setup and
  non-code support changes retain full server checks. `--dry-run [<commit>]` reads the named merge's
  trees without a checkout and only prints the scope and commands. Cloud-only infrastructure diffs under `scripts/cloud/`,
  `deploy/aws/` and `deploy/cloud/` (PM-734), optionally with direct cloud/deploy/release test-family
  changes, run server typecheck and the cloud, deploy, release, architecture and merge-test test
  prefixes. Manifest, lockfile, TypeScript/Vitest configuration, selector/executor scripts and non-code
  scripts retain full checks; test-only diffs select the changed tests. **Remote engine:** selection runs on the engine with
  its two git trees; no engine files or new selection API cross the server/engine boundary.
  **Module:** `scripts`

- **Provider and engine outage watch (PM-449)** — `runtime/watchers` (`WorkOutages`), `runner/runner.ts`
  (`providerStatus`). Every 30 seconds the server checks the used providers' login
  (`claude auth status`, `codex login status`, `--version`, Gemini login and the NanoGPT key)
  and engine connectivity. Checks run concurrently, with a 20-second limit and no overlapping
  rounds. The CLI and its login must live on the machine that runs the sessions.
  The bounded status wait runs on the server in `runtime/watchers/provider-status-wait.ts`
  (Effect, PM-617).
  **Remote engine:** checks use the existing `provider.status` RPC, including `refresh`;
  connectivity comes from the server's engine registry. No new engine code is needed.
  For NanoGPT the cloud's key store decides whether the key is there (PM-736).
  A remote engine that has not connected since server startup gets the same 120-second
  grace as a disconnected link; existing alerts stay open until recovery is confirmed.
  Reconnection releases waiting work even if publishing the outage update fails.
  Each project gets a `work_outage` owner alert with affected members and waiting tasks;
  confirmed recovery resolves it with `outage_ended` and retries deferred work. Unknown
  checks preserve the last confirmed outage. Acknowledgement suppresses repeats for the
  episode; open alerts and their original start times are adopted after restart.
  PM-1061: an engine of another owner (see "Engine link and machine keys") affects only the projects bound to it;
  the alert, its inbox items and its targets are built per project, so only that project's members hear of an
  outage of that engine, and the engine's own owner sees its status in the engine list. Nothing changes on the engine.
  **Module:** `runtime/watchers`

- **Engine link and machine keys** — `engine-link/{protocol,methods,rpc,event-buffer,index,version}.ts`,
  `runtime/sessions` (`EngineRegistry`), `db/engines.ts`, `api/engines.ts` (PM-313).
  PM-791 adds `engine-link/remote/hub.ts` `awaitLink`: readiness is recorded only after connect
  hooks finish. A bounded merge wait survives the registry's 120-second offline transition;
  disconnect clears readiness and an abort signal or hub close ends the wait. `stopWaiting` only
  ends the RPC relay waits, leaving merge waits to their signals during domain shutdown. This runs on the
  cloud and needs only the remote engine's existing authenticated link, with no local path assumption.
  PM-698 adds optional `hello.processScope`, running-session `scopeId`, exit `cleanup` and
  `scope_recovered`. All scope inspection and signals stay on the owning engine; only generation
  identifiers and cleanup results cross the boundary. Protocol version stays 1; update the hub first.
  Engines connect outward to `/engine/link` with a bearer machine key; the cloud stores only
  its SHA-256 hash and display prefix. Remote requests require HTTPS; forwarded protocol headers
  are trusted only from a loopback reverse proxy. Plain sockets are restricted to local requests.
  Human cookies and integrator keys do not authenticate this
  socket; machine keys grant no human API access. The method table is the sole RPC gateway,
  validated in both directions and tied to the engine contracts, including the PM-312 disk operations.
  PM-1059 adds no method, parameter or event and keeps protocol version 1: which engine a call goes to is
  decided by the cloud before the call (`EngineDirectory.projectEngine`, `hostEngine`, a session's recorded
  engine), see "Cloud composition". PM-1060 keeps that: the project's engine comes from the cloud's
  `project_engines` binding; nothing changes on the engine.
  PM-1061 isolates the owners' engines on the hub (protocol unchanged, no new wire code): `engine-link/remote/guard.ts`
  classifies every method as open, project-bound or host-only, exhaustively at compile time, and `RemoteHub.call`
  refuses a project-bound call to an engine the project is not bound to (`engine_not_bound`) and a machine or
  administration call to any engine but `EngineRegistry.hostEngine()` (`engine_not_host`, the default engine only
  when the host owner owns it). The other way round, the engine handlers answer a session request only when the
  session is recorded on that engine and its project is bound to it, and `mcp.relay` refuses a token of a project
  the engine is not bound to. `GET /api/engines/status` lists the engines of the viewer's own projects and their own;
  `GET /api/engines` lists every engine to the host owner and the owned ones to another owner, hiding the hostname
  and last address from everyone but the engine's owner and the host owner; `engine_changed` reaches the host owner,
  the engine's owner and the members of the projects that use it (the rules are `canSeeEngine` and
  `canSeeEngineMachine` in `packages/shared`). A remote engine of another owner therefore needs nothing more than
  its link; what it may be sent is decided on the hub.
  PM-1062 adds the owner account (protocol unchanged): the host owner invites an owner by an e-mail link
  (`owner_invitations`, migration 118; a 7-day single-use token stored as a SHA-256 hash, public and
  attempt-limited `GET`/`POST /api/owner-invites/:token[/accept]`); acceptance grants `owner_accounts` and starts
  a session. An owner account creates and revokes its own engines (`canCreateEngine`, `canManageEngine`), but
  the machine default stays the host owner's. The host owner revokes the account
  (`POST /api/owner-accounts/:userId/revoke`, own login only): the account is marked, its projects the host has
  no seat in are paused, its engines and integrator keys are revoked; the login and the data stay. The folder
  check of a new project runs on the engine the creator chose (`NewProjectEngines.workspaceState(engineId, path)`,
  PM-1077: `directory`, `missing` or `not_held`), which then becomes the project's default binding. It needs
  nothing new on a remote engine: `host.is_directory` already exists, and a folder outside the engine's roots
  (`path_outside_roots`) is `not_held`, which does not refuse the project.
  File export forwards `exactRoot` when the caller requires a root without symbolic links.
  PM-739 adds `workspace.publishTaskBranch` (`[key, taskKey, branch, commit]` → strict `{path, ref}`):
  the engine hands a developer's task commit over to its own repository; the cloud never names a path
  or ref, `engine-limit.ts` binds the repository and requires a full object id. Protocol version stays
  1; an older engine answers `unknown_method` and the call fails with an update message, so update the
  engines before the hybrid hand-over is used.
  Events are acknowledged after handling, and engine-scoped request
  results survive reconnects for five minutes in memory. `secret.nanogpt_key` is never cached or
  logged; the starting-session condition is enforced by the PM-315 handler, unavailable by default.
  `bootId` identifies a process start; `instanceTag` still identifies the engine home. Disconnects
  immediately remove the live link, but status stays online for 120 seconds. Registry and key
  management run only in cloud engine mode; single mode exposes an empty status list.
  PM-789 heartbeat: the cloud pings every 20 s (`ENGINE_HEARTBEAT_MS`) and counts the pings without
  an answer; every decoded frame and every pong is a sign of life (`lastHeard`, `unanswered = 0`).
  It drops the link (close 4400, cause `heartbeat`) only when nothing was heard for
  `ENGINE_DEAD_AFTER_MS` (90 s) **and** `ENGINE_DEAD_AFTER_PINGS` (3) pings went unanswered, so a
  loaded engine that pongs late, or a cloud whose event loop stalled (no ping went out), does not
  lose a live link. The engine's watchdog reports `link_silent` only after two consecutive ticks
  with pending events and more than 90 s of silence. Both sides log `engine link: connected` and
  `engine link: disconnected` at info level (code and cause; never the key or URL). Protocol version
  stays 1: an old engine with a new cloud is tolerated for 90 s (the old engine reconnects after
  45 s when events wait), a new engine with an old cloud keeps the old 45 s drop.
  **Remote engine:** the socket, event buffer and method dispatch run on the engine beside its
  CLIs and files; the registry, auth, idempotency store and human websocket broadcasts stay in the
  cloud. Non-JSON/large data uses purpose-scoped uploads (PM-315), with only a hash and size in
  RPC results. `PROJECTMAN_VERSION` overrides the version on both hosts; otherwise
  `resolveAppVersion` reads the installation checkout's git HEAD, falling back to `dev`.
  The override must match `[A-Za-z0-9._+-]{1,64}`. This assumes a git checkout when no override is
  supplied; packaged cloud and engine builds should set the same version explicitly.
  `resolveAppTag` (`engine-link/version.ts`, PM-541, PM-542) reads the release tag on the same checkout's HEAD
  (`git tag --points-at HEAD`, first tag matching `RELEASE_TAG_PATTERN`; `createAppTagReader` remembers only a found
  tag, because the release watcher tags after the switch). It reads the installation's own git checkout, so it runs
  on the server's machine and never on a remote engine; without git, on a timeout (2 s) or with a
  `PROJECTMAN_VERSION` override (a cloud package has no checkout) the tag is null.
  PM-731: JSON turns a trailing `undefined` into `null`, so `workspace.findTaskBranch` accepts
  `string | null | undefined` as its third element and the handler gets `undefined` (no other input
  is loosened). An `invalid_params` answer names the method and the failing parameter paths (never
  the values), `path_outside_roots` the refused path; an unrecognised handler exception still
  answers `internal / Engine request failed` and only its method and class name reach the local
  log (`onFailed`), on both sides. An engine older than this change rejects the `null`: update the
  engine with the cloud.
  Existing inventory boundaries use these groups:
  - Session processes, trust, sandbox and terminal: `session.*`, `terminal.*`, `term`, runner events.
  - Codex project layer inspection: `session.assert_workspace_config`.
  - NanoGPT secret delivery: `secret.nanogpt_key`; the hub's secret store and HTTP usage remain in cloud.
    An engine with its own key file (PM-1068) reads it locally, never asks for the hub's key, and announces
    that with `nanogptKey: 'engine'` in its hello; the key value never crosses the link.
  - Dependencies and task/member workspaces: `worktree.*`, `workspace.*` (including uploaded bundles).
  - Session output folders: `folders.*`; canonical paths and preparation: `host.*`.
  - Screenshots, scenario paths and image lists: `screenshots.*`, `files.resolve_scenario`, `files.list_images`.
  - Attachments: `files.export`, `files.materialize`; transcripts/resume: `transcript.*`.
  - Machine metrics and process attribution: `machine.*` and `hello.instanceTag/pid/uid`.
  - Hook decisions and team tools: `permission.*`, `mcp.relay` (integrator credentials stay in cloud).
  - Free-disk admission: `host.free_disk`; idle heavy-run protection: `host.heavy_run_sessions`;
    CLI login/plan usage: `provider.status`, `usage.plan`.
  - Full tests and their local heavy-run queue: `full_test.run`, `full_test.cancel`, and the engine's
    `full_test_started` event when the run got its turn in the queue (PM-489). PM-790 adds
    `full_test.attach {runId}` in `engine-link/{methods,engine-handlers}.ts`: attachments wait for
    an active run or read its retained result. The engine keeps completed results in memory for
    60 minutes, at most 32, pruning on run/attach calls and completion without a timer. Cancel and
    final disposal forget records; link closure leaves the executor and records alive. Only run ids
    and strict full-test results cross the boundary. Protocol version stays 1; an older engine
    answers `unknown_method`. PM-876 adds `full_test.report {runId}`: the engine reads the bounded
    `MergeTestReport` (scope, workers seen, step timings; no output) from the retained record, and the
    host asks for it after `run`/`attach`. The `report` is cut from the `run`/`attach` answers, so
    older hubs and engines keep their strict schemas; an older engine answers `unknown_method`, which
    leaves the report unknown (null), never an error.
  - Member initiated merges: `merge.*` (PM-451, see "Merge"), including `merge.read_file` and `merge.commit_files` (PM-494, the Operator's documents; PM-784: also the integrator's document write through the bearer MCP, same calls, started by the hub with no member session), and the read-only `merge.list_paths` and `merge.changed_paths` (PM-595, file names only).
    The cloud history copy also consumes `merge.read_file` and `merge.is_ancestor` (PM-744, PM-788):
    `services/history/document-sync.ts`, adapted to `EngineDirectory` in `assembly.ts`, reads the fixed
    `docs/DECISIONS.md` and `docs/LESSONS.md` paths at one commit and publishes them atomically to cloud SQLite.
    `task_merged` and published `write_project_docs` trigger commit reads without fetching; startup,
    configuration changes and a ten-minute poll read the head, retrying each minute while pending, stale or unavailable.
    Git, repository paths and credentials stay on the Operator's selected engine (or the actually registered local
    engine when there is no Operator); cloud has no hidden local repository fallback. Only project/repository,
    fixed paths and base/commit leave cloud; a commit and two bounded UTF-8 texts return. `engine-host/merge-repo.ts`
    serializes upstream fetches per repository across document reads and merge preparation in one engine process.
    With the engine offline, the last received text remains searchable with a stale indication; it is not claimed
    current (owner, 2026-10-18). Database history remains searchable independently of document refresh failures.
  - Administrative control socket: cloud-owned control, with `session.pause/force_pause/release/stop` to engines.
  - Offline machine and the question screening (PM-708): the durable queue, the timer and the
    delivery receipt all run on the server. A screened question that waits for the PM's engine stays
    in the inbox with `payload.screening.queue` (`engine_offline`); it raises no owner alert, no
    `screening_skipped` and no human fallback. The ten minutes start from the receipt
    (`deliveredAt`) and run only while the engine is online (`screeningDeadline`,
    `screeningFrozenRemainingMs` in `packages/shared`). The server learns the link state from
    `EngineRegistry` and `engines.last_seen_at` (`lastConfirmedOnlineAt`, through the
    `ScreeningEngineState` port in `assembly.ts`); the sweep also runs on each `engines.onChange`.
    The Mac only holds the existing engine link, and the CLIs and their login stay there. No new
    process, shell, socket or credential operation, no new table. Remote engine: works unchanged,
    since only the link state crosses the boundary. Signals and team messages already queue on
    `engine_offline` (`releaseForEngine`, `retryDeferredStarts`). Real Mac, sleep and network
    trials belong to PM-664.
    Integrator todo handoff (PM-782, `core/inbox/inbox.ts`, assembly maintenance) has no clock since
    PM-885 and PM-938: since PM-1003, machine work handed off by the Operator stays in the integrator inbox;
    only owner-reserved work is passed to the owners (`integrator_passed_on`). The sweep gives integrator
    work to the owners only when no Operator exists (`integrator_unavailable`); on leave or with AI off it
    waits for the Operator or super side. The hub alone persists and publishes the handoff;
    no engine operation or credential crosses the boundary. PM-801 puts the integrator's fix-limit
    decisions on the same sweep (`planIntegratorInboxEscalation`): hub-side only.
    Machine access (decision 66, PM-1073): `AiMemberConfig.machineAccess` (shown as "Külső teendő (MCP)") lets an
    AI member put machine todos in the owners' integrator queue. The rule is `machineAccessOf` /
    `machineTodoIssuerAllowed` in `packages/shared/src/config/machine-access.ts`: an absent value follows the
    role (the selected, non-temp project manager has it, nobody else; no migration), the system and the Operator
    member issue as before. Only an owner changes it (`ownerOnlyChanges` `machine_access`); a role change pins
    the effective value. `open_integrator_todo` is listed only to such members (`ToolAudience.capabilities`) and
    the handler decides (`machine_access_required`); screening refuses the integrator recipient with
    `no_machine_access`. Hub-side only: no engine operation, credential or process is added.
    PM-712 applies the same server-owned queue and receipt pattern to suspected loops:
    `runtime/watchers/loop-watch.ts` stores generation, assessment and the remaining ten-minute
    online budget in `task_loops.triage_json`; `services/operator/loop-triage.ts` sends a
    report-only `loop_suspected` signal to the selected PM, even when it participates in the loop.
    The engine link state freezes the deadline while offline, and reconnect sweeps resume it.
    Queued delivery alone never creates an owner decision. No new engine operation or CLI mount.
    Before reporting, assessing or falling back to the existing human loop decision, the watcher
    re-reads the task, timeline work and branch head through `SessionOrchestrator.sourceHead`.
    The existing engine git read runs beside the repository; only commit/time facts cross the
    boundary. A null/offline head never proves progress. Queue, deduplication and assessment stay
    on the server and work unchanged with a remote engine.
    **Module:** `engine-link`

- **Engine process** — `engine-app.ts`, `engine-link/{engine-client,engine-handlers,engine-limit,engine-audit,engine-config,engine-status,engine-transfer}.ts`,
  `scripts/engine/{cli,commands,move-work-root}.ts`, `index.ts` (`engineMain`), `app.ts` (`parseMode`) (PM-314).
  `engine.json` has an optional `workRoot` (PM-846, see "Work volume (PM-846)"); engine mode does not read
  `PROJECTMAN_WORK_ROOT`.
  Entry points import the named exports of `engine-link/index.ts` (PM-649); the
  implementations above and their machine assumptions remain unchanged.
  `PROJECTMAN_MODE=engine` (`npm run engine -- start`) runs the machine-dependent parts on the Mac
  beside the CLIs and connects outward to the cloud's `/engine/link` with its machine key. There is
  no database, no `/api`, no web app and no control socket; only `index.ts` reads the environment.
  Files, all under the engine's home (`PROJECTMAN_HOME`, default `~/.projectman`): `engine.json`
  (cloud address, engine id, project workspaces, registered repos with their full-test command and the
  optional `mergeBranch` (the one branch the cloud may merge into and push; absent: every `merge.*` call
  is refused with `merge_not_allowed`), the highest permission mode, whether the cloud may type into a terminal), `engine.key` (the machine key,
  mode 0600; a looser mode, another owner or a link is refused at start-up), an optional link-headers
  file (0600; `authorization` is never taken from it), `engine-status.json` (what `status` shows: no
  secret; PM-1086 adds the optional `work` counts (sessions, merge checks, screenshot runs) and `keepAwake`
  (`mode`, `holding`, `since`, `unsupported`), and `engine.json` the optional `keepAwake` mode,
  `while_working` when absent; PM-1087 adds the optional `version` (as in the hello), `releaseTag` (the git tag
  of the checkout, read once at start-up with a 2 s limit) and, per running session, `member`, `provider`, `label`
  (the display name) and `startedAt`, which the engine remembers from `session.start` until the runner's exit;
  no prompt, token or path), `logs/engine-audit.jsonl` (one line per request: method, session id, outcome and refusal
  code, never a prompt, message, terminal input, file content, token or key; rotated at 10 MB, five
  files kept) and `attachments-cache/` (downloaded attachments, checked against size and sha256; a task
  session may read its card's folder there, which `engine-limit.ts` allows as a read-only sandbox root
  and never as a working directory, PM-667).
  The engine listens on `127.0.0.1:4801` only (`PROJECTMAN_ENGINE_PORT`): the CLIs' permission and
  other hooks, and `POST /mcp/<token>`, which it forwards to the cloud as `mcp.relay` and answers 503
  while the link is down. Every request is checked against a local limit (`engine-limit.ts`) before
  it runs, whatever the cloud asks: working directories, writable and readable roots, worktree and
  workspace paths, the repos and full-test commands in `engine.json`, the highest permission mode, no
  full-access sandbox, a closed set of environment variables, terminal input, and which processes
  `machine.signal` may stop (a process of a running session, never the engine itself or pid 1).
  The engine's own secrets are never reachable from a session: the machine key and the link-headers
  file are in every sandbox's `denyRead` and `denyWrite` and in a policy's `deniedPaths`, and
  `engine.json` and `engine-status.json` are in `denyWrite`. For that, `resolveEngineConfig` refuses a
  key file, a headers file or a home that lies inside a workspace, the temporary directory or the
  engine's own worktrees, after `realpath`, and the engine refuses to run (`home_in_use`) in a home that
  holds `db.sqlite*`: give it its own, for example `PROJECTMAN_HOME=~/.projectman-engine`. The one
  exception is a home whose `instance.json` says `engine` (PM-318, the Mac after the move to the hybrid
  mode, [HYBRID.md](HYBRID.md)): its stale single-machine database and secrets stay there for the way
  back, and the sandboxes' `sensitivePaths` already put `db.sqlite*`, `secret`, `secrets` and the other
  server data of the home in `denyRead`; `instanceMayWork('engine')` is false, so no server ever runs on it. Every
  `session.start` needs a policy (the denied paths and roots come from it), and each path in it (the
  placement, readable, writable and read-only roots, the session folders, a review copy's directories)
  must lie under the engine's roots; a task worktree's `gitDir` must be a registered repo's `.git` and its
  `worktreeGitDir` a folder under that `.git/worktrees`. `/tmp/claude-<uid>` is no root a sandbox may
  name. File transfers do
  not follow redirects, so the extra link headers (a service token) never leave the cloud's address.
  Only `hello` tells the cloud about the machine: version, host name, platform, the registered
  projects and repos (with whether a full-test command exists), providers, running sessions,
  `instanceTag`, `pid`, `uid` and `bootId`. The NanoGPT key is asked from the cloud for a starting
  NanoGPT session only and lives in memory for that start; the audit log records that request (method,
  session id, ok or error) but never the key. On SIGINT/SIGTERM the engine pauses its
  running sessions first, then stops them and closes the link. The link client reconnects with a back-off
  of 1 to 30 seconds after a lost connection, a failed handshake (Node 22–23 WebSockets emit only
  `error`, without `close`) or a handshake without a welcome within 30 seconds (PM-732). Each attempt
  ends only once, so delayed socket events cannot start concurrent connections. It replays
  unacknowledged events by sequence number, buffers at most 10,000 events or 50 MB (the oldest are
  dropped and counted), and sends terminal data only for sessions the cloud attached.
  **Assumptions:** the code (a git checkout), the CLIs, their logged-in accounts (Claude, Codex,
  Gemini), the browsers and the repos are on the engine's machine, and a person starts the engine as
  the user who owns them. The cloud sees nothing of the machine beyond `hello` and what requests
  return. **Does this work on a remote engine?** This entry is the remote engine: in the engine
  process run the Gemini CLI and its conversation directories; the NanoGPT Codex home; dependency clones; the
  heavy-run queue; session output folders; browser installation and screenshots; the machine display and
  orphan processes; instance identity (`instanceTag` from the real path of the engine's home) and session
  liveness and termination; conversation transcripts and resume; hooks and team MCP over loopback;
  task worktrees and shared git storage; the free-disk probe; the native sandbox and canonical paths;
  CLI token and plan usage; Claude workspace trust; the Codex project layer check; and the full test
  before review. The cloud keeps the registry, the secret store, the integrator credential, the
  permission decisions and the control socket. Transcripts, bundles and attachments cross as
  purpose-scoped uploads and downloads (`engine-transfer.ts`; the cloud's endpoints are PM-315).
  The link client uses the runtime's `WebSocket`, which cannot send the close codes 1001, 1002 and
  1011: it closes with 1000 and a reason text (`engine_shutdown`) instead.
  **Module:** `entry`

- **Cloud composition** — `engine-link/remote/{hub,transfers,runner,transcripts,host,attachments,machine,github,handlers,index}.ts`,
  `engine-link/index.ts` (`EngineLinks.authenticate`), `app.ts` (`parseMode`, `createCloudRemote`),
  `runtime/sessions` (`SessionOrchestrator`, `EngineRegistry`), `core/messages`, `runtime/watchers` (`MachineMonitor`),
  `services/full-tests/{full-tests,screenshot-runs}.ts` (PM-315, PM-601).
  PM-791 lets `host.ts` follow a full test across at most five engine link losses when the
  caller opts into a bounded wait. `full_test.attach` carries only the run id and result;
  execution, cancellation and checkout cleanup stay on the engine. The cloud retains start
  callbacks until following ends and uses the remaining test timeout plus its existing grace.
  Other RPC failures end as `spawn_failed`, so handler errors and refusals block the check
  once instead of being retried as engine link losses.
  `PROJECTMAN_MODE=cloud` runs the UI, the API and the database and no machine-dependent part: the
  runner, the transcripts, the plan usage, the machine probe, the engine directory (worktrees, workspaces,
  session folders, free disk), the GitHub CLI, the full test and the screenshots are the engine's, asked
  over its link. `createCloudRemote` builds them before the domain (which takes them as its own runner,
  engines, machine probe and GitHub service) and `bind` hands over the domain and the app afterwards (the
  team-tools relay and the reconciliation). The hub (`hub.ts`) keeps a mirror of each engine (running
  sessions, pending inputs, session folders) built from its `hello` and its events, so the synchronous
  questions (`isRunning`, `list`, `hasPendingInput`, `processExists`, `sessionFolders.of`) are answered
  without a call. A call waits up to 60 seconds for a dropped link while the engine counts as available
  (120 seconds); a request that was in flight when the link dropped fails with `link_down` and is not
  repeated; at shutdown nothing waits (`stopWaiting`). A connecting engine is reconciled before it counts
  as online: a session the database calls live that the engine does not report ends with `server_restart`
  (a cloud restart ends every running remote session, because the team-tools tokens are in memory), and
  what the engine runs that the database does not know is stopped. Messages for a session on an engine
  that is away are held (`SentMessageHold` `engine`) and delivered when it is back.
  The team tools reach the cloud as `mcp.relay`: the cloud runs the request through its own
  `/mcp/<token>` route (`app.inject`) only when the token's session runs on the requesting engine, and
  answers 404 otherwise. Transcripts, bundles, attachments and exported files cross as single-use,
  purpose-scoped transfers (`transfers.ts`: 5 minutes, size and sha256 checked, 404 for an expired,
  reused or another engine's token); the files an engine uploads wait in a spool folder that is emptied at
  start. The NanoGPT key is released to a starting NanoGPT session of the asking engine only (the PM-313
  condition, now answered by `handlers.ts`) and is never logged.
  PM-1061: every outbound call passes `engine-link/remote/guard.ts` (a project's call goes only to an engine bound
  to it, the machine and administration calls only to `hostEngine()`), and `handlers.ts` answers a request about a
  session only when the session is recorded on the asking engine and its project is bound to it. The NanoGPT key
  goes only to an engine whose owner is the host owner; a NanoGPT start on another owner's engine is refused with
  `nanogpt_key_not_for_engine` (a member's start then waits with that reason), and the provider status of such an
  engine reads as a missing key. The host machine view (`machine.ts`, `host.ts`) and the diagnostics, test, build
  and release preparation of the Operator use `hostEngine()` and nothing else.
  **Assumptions:** the cloud has no CLI, git checkout, browser or session folder of its own; the one
  engine of a project (the default engine) is the machine the owner sees. `PROJECTMAN_MACHINE_FIXTURE`
  is ignored and no full-test or screenshot executor is built locally. The
  local worktree manager is still created because `DomainOptions.worktrees` is required, and is unused.
  Since PM-774, the native PTY and terminal packages (`runner/{session,terminal}.ts`), sandbox runtime
  (`full-test/{index,workspace-dependencies}.ts`), SES SDK (`services/email-login/ses-mailer.ts`) and
  image decoder (`core/attachments/{attachments/thumbnail,message-attachments/image}.ts`,
  `services/feedback/screenshots.ts`) load only on first use. Synchronous PTY and terminal APIs use
  `createRequire`; asynchronous operations memoize dynamic imports. The image decoder disables its
  operation cache when loaded. Cloud startup loads none of these packages, even with e-mail login
  configured; the SDK client is created on the first send. The entry point loads the full-test factories
  dynamically in single mode; the queue directory helper lives in `full-test/heavy-lock-dir.ts` and
  remains available through the existing facade. `test/architecture/lazy-packages.test.ts` guards
  against static value imports. The engine and single mode load each package where its work runs;
  the existing RPC boundary and host requirements do not change.
  The idempotency store of a link keeps 10,000 results; the `usage` events replayed after a cloud restart
  can be counted twice, because the cloud's memory of handled events does not survive its restart.
  **Engine per project (PM-1059).** The business code no longer asks the hub for "the" default engine;
  it asks `EngineDirectory.projectEngine(projectKey)` (the project's base engine) or `hostEngine()` (the
  machine that is not about one project: project-creation folder check, machine view and orphan
  signal, host build, NanoGPT recovery, provider status without a project). `engineFor(projectKey, handle)`
  names a member's engine. `projectEngine` is the project's binding since PM-1060 (see below);
  `hostEngine` stays the hub's default engine. The remote runner starts a session on the
  spec's `engineId`, else the project's engine, and refuses (`engine_offline`) rather than falling back to
  another engine; attachments and materialized files go to the session's or the project's engine. Plan
  usage is measured and cached per `(engine, provider)`, shown on a board from the engine of the
  project's first AI member of that provider, and published (`plan_usage`) only to the projects that run
  on the measured engine; admission checks the starting member's engine. GitHub reads, release
  publishing and PR watches go through `GithubService` (project-aware) to the project's engine
  (`MachineGithubService` is the engine-side, project-less contract); the cloud keeps a watch per
  `(project, repo, PR)` on the engine it subscribed on, resends only that engine's watches on
  reconnect and drops a `github_changed` event from any other engine. Pull request snapshots, links,
  heads and authors are keyed by project too. No new machine operation or RPC exists.
  **The project's engine is a binding (PM-1060).** The `project_engines` table (migration 117:
  `project_key`, `engine_id`, `is_default`, `added_by`, `added_at`; one default per project by a partial
  unique index) says which engines run a project; the engine's owner (`engines.created_by`) and the
  project's owner bind (`PUT /api/projects/:key/engines/:engine`, `DELETE`, `GET`; own login only, no
  super command). `EngineRegistry.projectEngine` applies the pure rule `projectEngineOf` of
  `packages/shared`: the live default binding; none (`engine_offline`) when it is revoked, never a silent
  move to another machine; with no binding the global default engine, but only while its owner is among
  the project's owners and no other user created the project (`projects.created_by`, migration 119, PM-1062:
  null for a project the host owner registered, the creator's user id for one made in the app; no route
  changes it). The configuration names the owners and a project owner edits it freely, so an owner
  account's project reaches the host's machine only through an explicit binding of the host's own login.
  Revoking an owner account pauses the projects it created too. So a single-machine or `local` installation and a project nobody bound run as
  before. Each write is one transaction with an `engine` row of the project's change journal, then the
  wake, an `engine_changed` event with the `projectKey`, and `onProjectEngineChange`: the GitHub watches
  of that project move to the new base engine (`github.unwatch` on the old, `github.watch` on the new;
  an event from the old one is no longer heard). A binding cannot be removed while the project has an
  open session on the engine (`engine_in_use`) or, for the default, while another binding stays
  (`engine_is_default`). The engine-side `hello.projects[]` is only the local contribution (it fills
  `holdsProject` of the list); it never decides the binding.
  **Does this work on a remote engine?** This entry is the cloud's side of the remote engine: nothing
  here starts a process on the cloud's host. Without a connected engine a project cannot be created
  (`isDirectory` answers `engine_offline`, HTTP 409; PM-1062: the engine is the one the creator chose, an
  owner account must name one of its own, `engine_not_owned` / `engine_offline` / `engine_revoked`), a full test is refused with `engine_offline`, and
  the machine view is `engine_offline`. Moving the cloud onto a host with no CLIs is the goal; the
  `hello` paths are the engine's own and are never opened by the cloud.
  **Boundary proof (PM-667):** `test/cloud-engine.test.ts` (fixture `test/helpers/cloud-engine.ts`) joins
  the real cloud `buildApp({ engineMode: 'cloud' })` and the real `buildEngineApp` over the machine-key
  link on one machine, with disposable homes, a disposable repository, a fake runner and no CLI, `gh` or
  account. It shows: login, cards, clients and attachments work with no engine; a start and a message
  held offline each run exactly once when the engine connects; the checkout, the worktrees and the
  machine view are the engine's and the cloud's home gains none; the team-tools relay refuses a token of
  another session; a card's attachments reach the engine's `attachments-cache/` and a message's
  attachments its session folder, byte for byte; a drop, an engine restart, a cloud restart, a revoked
  key, a hello of another protocol (close 4409) and an engine of another version (flagged, accepted) end as
  described above; a `session.start` the link dropped in the middle of is not repeated (the cloud marks the
  session failed, the engine finishes the start, the cloud then stops that session, and nothing runs
  unseen). **Cloud restart:** the runner's shutdown cannot reach the engine, because the websocket plugin
  closes the links before `app.ts`'s close hook runs; the session the engine keeps running is ended by
  the reconciliation when the engine reconnects (its team-tools token is gone with the cloud's memory),
  and interrupted card work resumes automatically through admission from its transcript (PM-1092);
  general conversations resume on their next message. No session survives a cloud restart
  seamlessly. A session may read its card's `attachments-cache/<project>/<task>` folder on the engine
  (a read-only sandbox root; never a working directory).
  **Module:** `engine-link`

- **Cloud deployment and backup** — `deploy/cloud/{Dockerfile,entrypoint.sh,backup.sh,litestream.yml,smoke.sh,memory-probe.mjs,memory-profile.mjs,heap-summary.mjs,history-semantic-profile.mjs,history-semantic-fixture.mjs,history-semantic-image-check.mjs}`,
  `.github/workflows/history-semantic-profile.yml` (the release measurement on a GitHub-hosted `ubuntu-24.04-arm` runner, PM-913),
  `.dockerignore`, `auth/setup-code.ts`, `auth/index.ts` (the first setup), `apps/server/test/deploy-cloud.test.ts` (PM-317).
  PM-718 adds `scripts/cloud/images.ts`: an admin builder with existing Docker/Buildx docker-container
  driver and native builders/emulation exports separate single-platform Docker archives (PM-916:
  by default only the target machine's platform, `targetPlatform(config)`; `--all-platforms` both;
  the manifest holds one or two images, old two-image bundles stay valid)
  at one clean HEAD SHA, using a tracked-source-only context and the existing .dockerignore. The
  revision LABEL and PROJECTMAN_VERSION retain that full SHA. A strict, atomically published bundle
  manifest pins archive hashes/sizes and config digests after import/inspect verification. Output
  stays outside the checkout; no registry, upload service, build-host provisioning or engine RPC.
  The builder must be separate from EC2; ARM never builds on EC2. Actual two-platform native binary
  and disposable cloud smoke evidence, 1 GiB RAM/20 GiB disk capacity and digest-specific cutover
  approval belong to PM-675. A manifest is integrity metadata, not a signature of origin.
  PM-723: `smoke.sh` probes the engine door with four anonymous requests (GET link, GET download,
  GET upload, POST upload with an empty binary body), sending only the Cloudflare Access headers;
  none may answer 2xx, and an unreachable probe fails. It needs bash and curl on the machine that
  runs it and calls the hub URL; the engine has nothing new to do. `http/errors.ts` answers unknown
  `/engine` paths with 404 instead of the web app's index.html (hub HTTP routing only).
  PM-750's entry "Admin release preparation" runs that builder
  from its own clean checkout and smokes each image by its image ID before the receipt exists.
  PM-674's [rollback runbook](CLOUD-CUTOVER.md) closes the public edge and stops the cloud
  before downloading final data for Mac single activation. Deployment and backup remain on EC2;
  the single-Mac live watcher does not update either the cloud or the separate engine checkout.
  On AWS EC2 the same image runs under systemd on one Ubuntu machine, installed and operated by
  `npm run cloud` (the entry "The cloud machine and its operation (PM-535)").
  PM-775 (part of PM-772) adds to the same entry: `apps/server/src/logging/memory-log.ts`
  (`PROJECTMAN_MEMORY_LOG_SECONDS`, read in `index.ts`: a `memory` log line every 60 to 86400 seconds, off
  at 0), `PROJECTMAN_HEAP_LIMIT_MB` (read only by `entrypoint.sh`, which gives the server node's
  `--max-old-space-size`; 128 to 4096, empty keeps node's default) and a `curl` `HEALTHCHECK` instead of
  a node process every 30 seconds. **Machine assumption:** the heap ceiling is sized to the cloud
  machine's memory (docs/HYBRID.md "Settings"); the docker `--memory` limit, the systemd unit and the
  host (`deploy/aws`) are unchanged. **Remote engine:** none; the engine process does not read either
  variable and nothing crosses the server/engine boundary.
  The cloud runs in a container with `git` and without the `claude`, `codex` and `gh` CLIs, as an
  unprivileged user (the entrypoint starts as root only to hand the mounted volume over, then drops
  with `setpriv --no-new-privs`). Its processes: the server (`HOST=127.0.0.1`), Litestream
  (`replicate`), `cloudflared` (token-managed tunnel, outbound only) and a restic loop; each runs in
  a cleared environment with only its own variables, so the server's environment holds no tunnel
  token, storage key or restic password (an environment filter only: one uid, so `/proc/<pid>/environ`
  of the others stays readable to a compromised server). `PROJECTMAN_HOME` is the platform volume (`/data`): the
  database is replicated by Litestream (continuously, S3-compatible storage) and the rest of the
  home (`secret`, `secrets/`, `customization/` with `.git`, `attachments/`, `message-attachments/`,
  `feedback/`, `memory/`, `instance.json`)
  by restic into a separate encrypted repository (its password is not the storage key). A fresh
  volume restores both before the server starts and stops the start on any restore error other
  than "no replica / no repository yet". The first setup from a browser needs a one-time setup code
  from the server log (`auth/setup-code.ts`): `isLocalRequest` is false behind the tunnel, because
  the tunnel must not rewrite the Host header, and the code replaces "localhost" as the proof.
  **Assumptions:** one container and one volume at a time (two would replicate into one replica);
  the host knows the platform's volume semantics (a block volume attaches to one machine); the origin
  of the Cloudflare tunnel is `http://127.0.0.1:4700` with no Host override; the client address
  comes from `cf-connecting-ip` (`PROJECTMAN_CLIENT_IP_HEADER`), trusted from the loopback peer
  only; the Litestream replica is the SQLite database itself (not encrypted by Litestream), so the
  bucket's own encryption and a bucket-scoped key protect it. The Cloudflare Access service tokens
  of the engine (`linkHeadersFile`) and of the integrator are the only machine credentials that pass
  the edge.
  **Integrator isolation (PM-675):** `start.ts` reads optional `PROJECTMAN_INTEGRATOR_HOSTNAME` into
  `app.ts`; `http/integrator-host-guard.ts` runs on the hub before cookie/auth hooks, using the raw Host
  with case/port/root-dot normalization shared with the feedback guard. It blocks board bearer requests
  (403), board bare MCP (404), machine cookie-only requests (401) and machine non-API/MCP routes (404).
  Host preservation by the tunnel is required; forwarded-host headers and loopback source addresses
  confer no exception. The guard applies in private staging too; public mode without a hostname never
  restores bearer access on the board. This is a hub-only boundary; the remote engine needs no change.
  **Does this work on a remote engine?** This is the cloud's side only; the container runs no
  engine, no session and no machine-dependent part. What must run on the engine: everything in the
  "Cloud composition" entry. What crosses the boundary: the engine's `cloudUrl`, machine key and
  `linkHeadersFile` (`docs/HYBRID.md`, "Connecting the engine"); the restic repository holds the
  cloud's home, never an engine's worktrees or transcripts. The restore rehearsal
  (`entrypoint.sh rehearse`) starts a standby copy on the loopback with no tunnel and no
  replication, so it cannot disturb the production replica.
  PM-668 excludes provider homes, engine credentials, machine workspaces, logs and transient
  caches/spools from restic; the cloud-volume marker is rebuilt only after successful restore.
  Rehearsal requires an empty separate directory; temporary restore staging uses `TMPDIR`
  (default `/tmp`) passed through the cleared environment. The DB (1s sync) and files (21600s
  interval, first delay 300s) are separate recovery points: files may lag by 6 hours or longer
  after backup failures. A smoke pass is not complete recovery; the HYBRID/AWS runbook requires
  file/hash/reference checks and an earlier DB point when necessary. The fake-tool SQLite fixture
  proves coverage/error paths, while real S3/Docker acceptance belongs to PM-675. Storage secrets
  and backup execution stay on the cloud, never in engine payloads.
  PM-773 adds the memory tools `deploy/cloud/{memory-probe,memory-profile,heap-summary}.mjs` (the
  Dockerfile copies them beside the other scripts; `docs/HYBRID.md`, "Memory profile"). They are run
  by hand, on a disposable copy of a home (marker `<home>/.memory-profile-copy`), on the loopback
  with no network: the profile starts the server as a child process in a cleared environment, sends
  it SIGUSR2 for heap snapshots, reads `/proc/<pid>/status` (Linux; `ps` on macOS), and loads it with
  the web app's read requests over `127.0.0.1`. No tunnel, Litestream, restic or engine starts, no new
  RPC and nothing crosses the server/engine boundary, so a remote engine is not affected. Heap
  snapshots hold real data and stay on the machine that ran the tool; only `report.md` and the
  summaries (types, constructor names, numbers) may leave it.
  **Module:** `deploy`

- **Integrator credential** — `auth/auth-service.ts`, `auth/index.ts`,
  `db/integrator-keys.ts`, `db/integrator-key-audit.ts`, `runtime/sessions` (`session policy`),
  `runner/env.ts`, `services/super-operator`, `kernel/integrator-execution.ts` (PM-251, PM-758, PM-759).
  The host owner creates a separately attributed bearer key; the server stores only its hash.
  Authentication accepts it only on a local connection or HTTPS, using the existing loopback
  proxy protocol rules in `kernel` (`clientAddress`, `requestProtocol`).
  The host owner's own login manages explicit `super`/`read` keys with 1/7/30/365-day expiry
  or no expiry (`expiresInDays: null`, PM-825; default 7 days). The hub already stores a null
  `expires_at` and authenticates it until revocation; no migration or engine operation is needed.
  PM-1045: `AuthService.hasActiveSuperKey(ownerEmail)` (repository `hasActiveSuper`) tells whether an owner has
  a live (not revoked, not expired) super key; `integratorSideAvailable` reads it to decide where a machine todo
  waits. It reads only the hub database; no machine assumption is added.
  PM-1074 (decision 66): a step made with the key is the connected Claude's: it is recorded under the key holder's
  name (or the queue item issuer's), with `through` naming the holder and the key; the project needs no Operator for
  a key to bind. The key still carries no authority beyond the authenticated scope and the holder's rights.
  PM-1063: a further owner (an active owner account, PM-1062) with a password holds `super`/`read` keys of
  their own beside the host owner; the pure rule is `canHoldIntegratorKey` (`packages/shared/src/config/integrator.ts`),
  applied by `AuthService.keyHolderAllowed` at issuing, authentication, `assertActive` and `hasActiveSuperKey`.
  A key's scope is its holder's own projects (the existing owner-membership checks); revoking the owner account
  makes the key `integrator_key_invalid` (401). The team of a project is editable by its owners, so the reach
  also rests on a fact the team cannot write (`integratorKeyCoversProject`, `AuthService.keyCoversProject`):
  in a project an owner account created (`projects.created_by`, PM-1062) only the creator's key counts, even if
  the team lists the host owner; a project the host registered stays with its owner members' keys. The check
  sits in the scope's access check, `executeOwned`/`executeInstance`, `SuperRights.assertNow` and
  `hasActiveSuperKey(email, projectKey)` (the queue). Administration is the host's alone: `SuperRights.assertHost`
  refuses every non-host key with `host_only` (403) for the status, log and machine reads of the facade, for
  every `super_operate` administration command (hub or engine restart, deploy, process cleanup) and for the
  operator grant gate, which stays the host's. Instance-level REST routes are not `host_only` (PM-1058).
  Legacy keys are revoked with a lifecycle audit by migration 114 (PM-1037); the singular API is removed.
  Authentication rejects legacy rows, which remain readable in key lists and audit history. Before release,
  the owner must replace any active legacy credential on the integrator's machine with a super or read key.
  Replacement revokes only
  the same mode, with a database uniqueness constraint and transactional lifecycle audit.
  An instance-level call (`executeInstance`, `instanceUser`) is the host owner's through the key: it runs once, the
  key's policy and the super audit bind only the projects its holder owns, and the instance Operator actor comes
  from the first such project, never from another owner's project (PM-1058). The hub decides; nothing crosses to an engine.
  The shared credential resolver returns the stored mode and key id; `assertActive` rechecks
  that row and its owner without updating usage. Authentication records `mcp`, `cli` or `rest`
  alongside the last-use timestamp on first use, channel change or after five minutes.
  The exact external `/mcp` path takes precedence over the self-reported CLI header, which
  grants no authority. REST binds explicit modes through the Super Operator facade. The auth service
  registers immutable resolved principals in a private WeakSet; a copied principal or actor JSON grants
  no authority. The hub's request-local scope expires with its callback, and domain mutations recheck
  the active key and current project-owner membership after waiting for locks. Read credentials cannot
  write. Super credentials administer existing services but cannot decide human approvals, manage keys,
  or bypass fixed Operator invariants. The shared structured mutation projection (`ownerReservedEffect`,
  `packages/shared/src/config/super-mutation.ts`) reserves three effect classes for the owner (PM-870, the
  owner's decision of 2026-10-20): `deletion` (a member, repository, project or key removed), `security` (an
  access level or a new owner member, a human member's login e-mail or kind, an AI member's permission mode, approver and outbound network, the boundary delegation, the Operator approval waiver and the keys) and
  `cost` (the consumption-billed NanoGPT runtime); until PM-762 supplies an exact owner grant, these fail
  closed. Everything else (deploy and publishing, focus, repository and workspace paths, the other
  deletions, approval labels the key owner holds, decisions) the Operator does in its own name with the
  super key: `labelRefusal` opens the approval and human-only labels to a super actor when the key owner
  holds the label (self-review stays refused), and `superAccessVerdict` allows `approval` for the super mode. The repository merge queue's revision and complete permutation
  use one hub SQLite transaction (`merge_queue_revisions` and `task_merges.queue_rank`, migration 82,
  after PM-771's migration 80 and PM-761's migration 81); the running merge remains behind the existing
  BranchMerger facade.
  The external bearer MCP endpoint (PM-760, "The external MCP endpoint" below) uses this resolver on
  every HTTP request.
  Integrator todos (PM-782, `core/inbox`, `services/super-operator/todo.ts`) have a dedicated
  super-only resolution path for the integrator's own work, with authenticated actor/answer markers
  instead of an owner relay. `app.ts` supplies `IntegratorTodoAccess` through assembly: it checks
  current project owners, their existing users and active explicit super keys against shared access
  policy on every screening release. Only a boolean reaches the domain; no key id, prefix or secret
  enters question payloads or screening notices. Resolution and the durable 24-hour maintenance
  handoff run on the hub, even when the engine is offline. Remote engines need no new operation.
  The integrator stores its copy in `~/.config/projectman/integrator-key` on its own machine.
  Member file tools and local CLI sandboxes deny `.config/projectman`; the runner strips
  `PROJECTMAN_INTEGRATOR_KEY` before launching members.
  **Remote engine:** key authentication and audit stay on the server; the credential is never
  sent to an engine or member session. Engines must deny the same directory in their worker
  homes and strip the environment variable before spawning a CLI.
  **External MCP endpoint (PM-760):** `mcp/super-operator/*`, `mcp/http.ts`, `services/super-operator/relay.ts`,
  `scripts/cloud/cloudflare.ts` (`ingressRules`). `POST /mcp` takes the bearer key per request, with no session or
  engine. Machine assumptions: a local or HTTPS connection (`requestProtocol` trusts `X-Forwarded-Proto` only from a
  loopback peer, so the proxy or tunnel must run on the server's machine and keep Host and the protocol header) and a
  tunnel/proxy that refuses `/mcp/` and `/hooks` but passes `/mcp`. Remote engine: not affected; nothing of the endpoint
  runs on or crosses to an engine. Since PM-1045 this endpoint is the Operator's only door: the app starts no
  session for it. **The connected Claude as an actor (PM-1074, decision 66):** a super-key step is recorded as the
  key holder in person (`kind: human`, `via: integrator`, `through: {holder, credential}`), or, with
  `queue_item_id` on `super_operate` / `execute_super_handoff`, as the member who issued that open integrator queue
  item (`kind: ai`, the same `through`; `queue_item_not_yours` / `issuer_without_machine_access` refuse it). After the
  owner's own yes on a K3 question the step also carries `approvedBy`, set by the server only. The `operator`
  member and the old `operatorMode: super` events stay readable; `superActorOf` serves only the in-app Operator
  principal. The actor is created and stored on the hub (`actor_meta`); no machine-dependent part is added.
  **Two kinds of key holder (PM-1063):** a tool with `hostOnly: true` (`mcp/kit.ts`: `get_administration_status`,
  `get_administration_logs`, `get_machine_snapshot` and the two instance-knowledge tools; the host-request tools of
  PM-1064 take the same flag) is absent from `tools/list` of a further owner's key and answers `host_only` if called
  (`ExternalMcpBackend.isHost`). The server's `instructions` come in two kinds: the host's (the global Operator,
  unchanged) and a short one for a further owner (own projects, own machine with their approval, no secrets).
  Remote engine: not affected; the filter reads the hub's user and owner-account rows.
  **The global Operator on the endpoint (PM-1046, PM-1023 K7):** in the super mode `get_operator_instance_knowledge`
  and `update_operator_instance_knowledge` (`expected_revision`, `agreement?`, `principles?`) read and write the
  Operator's own knowledge with no `project_key` (`services/super-operator/instance-knowledge.ts`); the write is
  direct, with no app approval, and the super audit records it in every project the key's holder owns
  (`SuperOperator.executeOwned`). `list_integrator_inbox` takes an optional `project_key`: without it the items of every
  project of the key come in one list, each with its `projectKey`, and the access is checked per project. The
  server's `instructions` describe the Operator's role (decision 65). Remote engine: not affected; the Operator
  reaches the hub over HTTPS with the key and the knowledge stays in the hub's home.
  **Operator tools on the endpoint (PM-784):** `read_project_doc`, `write_project_docs`, `get_project_doc_write`,
  `get_role_configuration`, `propose_release`, `request_structural_review`, `ask_human`, `get_super_question`,
  `withdraw_question` and `read_attachment` (`mcp/*/tools.ts` `external` bindings, `mcp/super-operator/handler.ts`,
  `core/inbox/human-questions.ts`, `services/project-docs/doc-writes.ts`). They run on the hub with no session or
  engine. The only engine traffic is the one a member's call already has: a document write's git work
  (`merge.read_file`, `merge.commit_files`, `merge.push`, see "Merge") and a review request's usual member start. A
  queued write goes on under a fresh scope of its key (`auth.reactivate`, assembly's `DocWriteExternalRunner`) and
  checks the key, the owner and the Operator again before it starts and before the push; the origin (`ownerUserId`,
  key id and prefix, request id) is stored in `doc_writes.external_origin`, never taken from input. An attachment
  chunk is read from the hub's own attachment storage (at most 1 MiB per call, 25 MiB per file); on a remote engine
  nothing changes, since the hub already holds the stored files.
  **Cloud (PM-317):** in front of the cloud the integrator also passes Cloudflare Access with a
  service token of its own, kept beside the key in `~/.config/projectman/` (DEPLOY.md,
  "Integrator access"); the key still works only over HTTPS, which the container sees as
  `x-forwarded-proto: https` from the tunnel's loopback connection. The service token is a second
  secret with the same rules: never in a message, task, commit, prompt or engine payload.
  **PM-675:** when the explicit machine hostname is configured, the existing integrator client's
  origin changes to it; REST `/api` and MCP `/mcp`, key scopes and audit stay the same. Its Access
  token opens only that application's audience. Human key management, super audit and approval remain
  on the board's own cookie API. The app-principal's direct domain calls are not HTTP entrances.
  **Integrator client (PM-765):** `scripts/projectman/**` (the `projectman` bin: REST, `events follow` and the
  stdio `mcp-proxy`), `packages/shared/src/api/client-config.ts` (`ClientConfig`, exit codes, the channel
  header). Project writes use the common super-operation endpoint (PM-889), with the same request id in
  the body and header: task creation, fields, labels and starting; inbox decisions; configuration and
  member edits; credential revocation; project pause/resume and merge ordering. K3 operations return
  `waiting_owner` successfully; an inactive machine grant exits with status 3. Legacy inbox answer and
  fix-limit commands, instance pause/resume and merge prioritization retain their dedicated REST routes
  (no corresponding super command). `queue` reads the Operator's `MemberQueueView`, including closed items.
  `runner/env.ts` (`ACCESS_ENV_PREFIXES`) strips its credentials. It runs on the integrator's own machine, not on the
  server's or an engine's, and reads `~/.config/projectman/client.json` (paths and an origin only) with the key
  file and the optional Access service-token file it names. Machine assumptions: a home directory with
  `~/.config/projectman` (mode 700, files of the user with mode 600, no links; checked before any request), Node
  with the `tsx` loader, an HTTPS origin or a loopback one, a standard input/output pair for the proxy, and for
  `events follow --cursor-file` a writable local file (the cursor is not a secret). The client has no `--token`
  and no secret environment variable; it follows no redirect, redacts every error and debug line, and sends the
  non-secret `X-Projectman-Client: cli` label on REST and event requests (the server decides the channel by the
  path, so `/mcp` stays the `mcp` channel). Rights, expiry, audit and idempotency (the operations' request id)
  stay on the server. The runner strips the environment names of the Access service token
  (`CF_ACCESS_*`, `CLOUDFLARE_ACCESS_*`) next to `PROJECTMAN_INTEGRATOR_KEY`, and the live supervisor's
  allowlist keeps them out of the server. **Remote engine:** not affected; nothing of the client runs on or
  crosses to an engine, and neither the key nor the Access token is ever sent there.
  **Module:** `auth`

- **Codex project layer check** — `runner/ambient-config.ts` (`inspectProjectCodex`,
  `assertCodexMemberWorkspace`), `runner/runner.ts` (`assertWorkspaceConfig`),
  `runner/providers/codex/index.ts` (`launch`), `runtime/sessions` (`SessionLauncher` in `launch.ts`) (PM-357).
  The server reads the CLI's canonical working directory and each `.codex` layer from the
  nearest ancestor with a `.git` entry. Member starts and resumes allow only `config.toml`
  with model and project-document roots; confined reads reject links and nonregular files.
  Preflight runs before session rows/folders, and the adapter checks again before launch.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `session.assert_workspace_config` (PM-313) and run both inspections beside the CLI on the engine. The domain preflight
  becomes a server/engine call; return relative file names and key names only, never values.
  Today the server and CLI share the filesystem. NanoGPT retains its separate `any` rule.
  **Cloud mode (PM-315):** `RemoteRunner.assertWorkspaceConfig` calls `session.assert_workspace_config` on the
  session's engine; the engine refuses with its relative file names and key names only, never values.
  **Module:** `runner`

- **NanoGPT Codex home and key delivery** — `runner/providers/nanogpt/index.ts`, `runner/providers/codex/args.ts`,
  `runner/env.ts`, `app.ts`, `index.ts`
  (PM-329). The engine runs Codex >= 0.159.1 with a dedicated 0700 home under
  `PROJECTMAN_HOME/providers/nanogpt/codex-home`; any `auth.json` refuses startup. Only this
  adapter supplies the secret as trusted child environment and excludes it from CLI shell
  commands. Transcripts remain in that home; ChatGPT plan usage reads only the ordinary
  Codex home. **Remote engine (engine mode, PM-314: runs in the engine process):** use `session.start`,
  `provider.status` and `secret.nanogpt_key` (PM-313); PM-1061: only an engine the host owner owns gets the hub's key
  (`nanogpt_key_not_for_engine` for the others). **Own key on the engine (PM-1068):** any engine may hold its
  own key file (`nanogptKeyFile` in `engine.json`, set with `npm run engine -- nanogpt-key set|clear`, 0600, outside every
  session root and on the engine's sandbox deny list). An engine with a key file always uses it, the host's engine
  too: it re-reads the file at every start (`ownNanogptKey` in `engine-app.ts`), passes it as `nanogptKey` with
  `nanogptKeyInCloud: false`, registers no `nanogptStart` handler and says `nanogptKey: 'engine'` in its hello.
  The hub remembers that from `engines.last_hello` (`EngineRegistry.ownNanogptKey`), sets no key grant for such an
  engine and does not override its provider status with the hub's key fact. An engine without a key file keeps the old
  way (host's engine: hub key; another owner's engine: `nanogpt_key_missing`, the start waits). The CLI,
  home and transcripts belong on the engine; secret delivery requires an authenticated
  launch/resume boundary, never configuration, public status or logs. The current server and
  CLI share a machine and filesystem. A remote engine performs local version and auth-file
  checks and returns readiness status; it never asks for the key outside a start
  (`nanogptKeyInCloud`). The cloud adds whether it holds the key to the status it returns
  (`withNanogptKeyFact` in `engine-link/remote/runner.ts`, from its own key store, PM-736); only
  that fact is derived, never the key, and no engine method changes. The key goes out only to a
  starting session. A remote engine never persists or returns the delivered key,
  including in its spool; a replaced key affects only subsequent launches and resumes.
  Codex rollout `task_complete` (including an empty failed response) and `turn_aborted`
  events end the runner's turn even without a Stop hook; a later `task_started` supersedes
  that end (PM-377, `runner/providers/codex/transcript.ts`). The engine must parse these
  events beside the CLI and forward the resulting session state to the server.
  **Session folder and own TMPDIR (PM-522):** a NanoGPT session gets a session folder like a Codex
  one (`sessionFolderAccess`): with a writing sandbox (`workspace-write`, short tmp root present) the
  folder is writable, it gets its own `TMPDIR`, the browsers and the screenshot scope, and the shared
  `/tmp` is closed for its commands as for Codex; with a read-only sandbox the folder is read-only
  and only the server writes it. Without a safe tmp root a writing NanoGPT sandbox gets no folder
  and keeps the shared `/tmp` open as before.
  NanoGPT-only quota detection emits `rate_limited` over the existing RunnerEvent boundary;
  `runtime/usage` (`ProviderQuotaHolds`) keeps a provider-wide, in-memory hold on the server,
  blocking starts and message wakeups until the measured weekly reset. The adapter's
  `planUsage.get()` reads `GET https://api.nano-gpt.com/api/subscription/v1/usage` with the
  managed key, without logging credentials or response bodies (10-second timeout, no
  redirects). Unknown usage holds inference while only usage probes retry; initially
  known lower usage gives a fifteen-minute rate hold. Owners receive one alert per hold.
  `runtime/admission` (`MessageStarts`) persists the affected task's deferred continuation.
  Server restart loses the hold, but stored quota deferrals restore an unknown hold
  without an alert and require a usage probe before inference. **Remote engine:** usage HTTP runs on the server where the managed key
  is stored, as the key check already does, using the existing `api.nano-gpt.com` host;
  transcript parsing stays on the engine and sends `rate_limited` across RunnerEvent.
  No new machine-dependent boundary is required (PM-377).
  Startup checks `/etc/codex`, the dedicated home and workspace Codex configuration through
  `runner/ambient-config.ts`'s `inspectAmbientConfig`, refusing overrides with names only.
  NanoGPT also refuses nonempty workspace `.codex` directories and dedicated-home
  `hooks.json` files; escaped quoted TOML roots fail closed in the shared inspector.
  The shared inspector checks separate project and home hook files for every Codex caller;
  NanoGPT selects `projectFolder: 'any'`, also refusing symlinked or non-directory project folders.
  On a remote engine this inspection must run beside the CLI, before secret delivery.
  The engine also applies NanoGPT-only feature overrides disabling plugins, apps and
  skill-triggered MCP installation, an ephemeral authentication store, and disabled analytics
  and feedback. All child environments strip `CODEX_ACCESS_TOKEN`. Codex 0.159.1's public,
  unauthenticated GitHub announcement request remains a CLI network assumption.
  The environment filter also removes AuthManager's OAuth client-id and token-endpoint
  overrides, so a host environment cannot redirect child subscription authentication.
  **Cloud mode (PM-315):** the key stays in the cloud's secret store. The `secret.nanogpt_key` handler
  (`engine-link/remote/handlers.ts`) releases it only to the engine of a NanoGPT session that is starting
  (`RemoteRunner.takeKeyGrant`: a grant held only until the start call returns), never caches or logs it, and a key change asks each engine for its login state again
  (`provider.status`).
  **Module:** `runner`

- **Gemini (agy) CLI, conversation directories and keychain login** —
  `runner/providers/gemini/*` (PM-326; PM-319). The interactive PTY runs `AGY_BIN`/`agy`,
  authenticated with the executing account's Google consumer login in its keychain. Each
  conversation has a private directory under `PROJECTMAN_HOME/providers/gemini`; it stays
  for resume, holds hook/MCP configuration and local transcripts, and confines transcript
  reads (`Launch.conversationRoot`). POSIX sh plus curl (Node fallback) forwards hooks to
  loopback HTTP. Updates are disabled in launches and login probes; maintenance is manual.
  Commands currently run without a sandbox under owner decision T4: role shell rules allow
  listed developer commands, other calls use the inbox, and a missing hook answer denies the call.
  A command's actual working directory must stay in the session placement/writable roots;
  denied relative paths are resolved there. Read-only placements cannot use the unsandboxed
  shell-rule exception: commands pass through the inbox's existing read-only rules instead.
  The pre-tool hook uses the session policy's placement when newer agy versions omit `Cwd`
  (PM-874). It maps `read_file`, `write_file` and `edit_file` with `Path` as well as the
  older file tool names to the same permission checks (`runner/providers/gemini/hooks.ts`).
  This normalization runs on the engine using its session policy; no new boundary data is needed.
  **Quota exhaustion (PM-954):** `screen.ts` recognizes the agy terminal's
  `RESOURCE_EXHAUSTED (code 429): Individual quota reached` and `Resets in …` duration.
  `runner/session.ts` stops the failed process and sends `rate_limited` with an optional
  absolute `resetsAt` through `engine-link/protocol.ts`. The server's
  `runtime/sessions/provider-limits.ts` holds every Gemini member until that reset (30 minutes
  when no usable duration is available), records an owner alert and restores the hold from the
  latest Gemini quota alert on startup, including acknowledged alerts. Automatic developer
  selection skips the held provider; explicit starts wait with `provider_rate_limited`.
  An interrupted implementer's card is released through the existing handoff and work-start
  paths (`provider_quota`), so another provider can take it and an unassigned card waits if
  nobody is available. Expiry releases admission automatically, without changing leave settings.
  The hold is server-wide, matching the shared keychain login assumption; separate accounts
  on multiple engines would require a future `(provider, engine)` scope.
  On a remote engine terminal recognition and relative-to-absolute time conversion run on
  the engine; only the existing runner event and its additive `resetsAt` field cross to the
  server. Persistence, selection and expiry stay on the server; engine clocks must be synchronized.
  This does not contain code executed by allowed tests/builds; PM-361 investigates isolation.
  **Remote engine (engine mode, PM-314: runs in the engine process):** the binary, login/keychain, private directories, PTY, forwarder and
  transcript reader must run on the engine. Hook/MCP requests cross authenticated URLs;
  transcript access must stay confined to the provider's conversation root on the engine,
  rather than opening engine paths on the server.
  **Session folder (PM-522):** a Gemini session gets the per-process session folder (see **Session
  output folders**), named in `PROJECTMAN_SESSION_DIR` through the environment `launch` returns
  (`runner.ts` merges `launch.env`). Gemini has no OS sandbox, so the folder is written by its file
  tools under the pre-tool-use hook's gate (its own folder is allowed outside plan mode, another
  member's is asked about, reading is allowed), not by a sandboxed command; no tmp directory, browsers
  or screenshot scope. On a remote engine the environment is built on the engine side; an older
  engine without this launch environment leaves the variable unset (the folder is then not named, the
  path in a tool answer still works).
  **Module:** `runner`

- **NanoGPT secret store** — `runtime/usage` (`ProviderKeys`, `createNanogptKeyCheck`) (PM-328).
  See **NanoGPT Codex home and key delivery** (PM-329) for session-only secret delivery.
  PM-1061: the installation key is the host owner's; the hub delivers it only to an engine the host owner owns
  (`EngineRegistry.ownedByHost`), never to another owner's engine, and says so with `nanogpt_key_not_for_engine`.
  The server stores the installation key under `PROJECTMAN_HOME/secrets/nanogpt.json`,
  with POSIX directory/file modes 0700/0600 and an atomic same-directory rename. Only an
  host owner may change it (`canManageProviderKeys`, PM-1068; an owner of every project is not enough). It is the
  host engine's fallback only: an engine's own key file (see above) takes precedence, and each owner pays for their
  own engine. Save-time checking needs outbound HTTPS to NanoGPT.
  **Remote engine (engine mode, PM-314: runs in the engine process):** delivery uses `secret.nanogpt_key` (PM-313), with the starting-session guard in PM-315;
  storage and validation remain on the server; this card does not send
  the key to an engine. PM-329 must deliver it only to NanoGPT sessions over the authenticated
  server/engine boundary, without configuration, database or logging persistence on either side.
  **Module:** `runtime/usage`

This is a living inventory of assumptions that tie execution to a machine, account or OS.
The current local mode usually places the server and agent CLIs on the same host. The remote
actions below are requirements for planning, not implemented remote support or new contracts.
Keep entries current under the rule in `CLAUDE.md`.

Unless stated otherwise, server paths below are relative to `apps/server/src/`.

Core attachment and permission entries name their final implementation locations behind the
stable module facades (PM-645). This refactor changes no filesystem operation, machine
assumption or remote-engine RPC.

- **Session process liveness** — `runner/session.ts` (PM-376). Every 30 s the runner
  probes the attached CLI PID with signal 0, recovering a missing PTY exit event through
  the normal failed-session cleanup. Only `ESRCH` proves disappearance; permission errors
  leave the session running. An unreaped zombie also passes the probe.
  Since PM-621, `runner/session-clock.ts` schedules the probe with a ref'd Effect sleep: a running session keeps the process alive until shutdown stops it.
  The PID belongs to this host.
  **Remote engine (engine mode, PM-314: runs in the engine process):** run this probe beside the CLI on the engine and transport the exit event;
  a remote PID must never be checked against the server's process table.
  Since PM-311 the domain asks the workspace's engine (`EngineHost.processExists`, `contracts/engine.ts`).
  The local probe runs on the engine in `engine-host/local-engine.ts` (PM-611).
  **Module:** `runner`

- **Fake CLI pause test gates** — `runner/runner.integration.test.ts` and
  `apps/server/test/fixtures/fake-claude.mjs` (PM-344). Tests hold the fake's work/tool
  phase until a release file exists in the disposable session workspace; PTY readiness
  markers confirm the phase before a pause is requested. The test and fake must share
  that temporary filesystem. Interrupting a turn abandons its gate without a release.
  **Remote engine:** run this integration harness and its fake together on the engine;
  these test-only paths never cross the production server/engine boundary.
  **Module:** `runner`
- **Dependency clones and refreshes** — `worktree/{dependencies,dependency-copy}.ts`, `cloneDependencies`,
  `worktree/worktree-manager.ts`, `ensureForTask` (PM-334, PM-412).
  Copies installed `node_modules` from another checkout with the same lockfile using
  `cp -c -R`; only Darwin and checkouts on the same APFS volume pass the probe. Since PM-846 the
  probe also chooses the reference: a candidate on another volume (the repository, when the worktrees
  are on a work volume) is skipped for the next one, and the result is `unsupported` only when every
  candidate with the same lockfile is on another volume. The first worktree on a new volume is a full install. Missing or
  stale installations are cloned before a task session starts or resumes and before each tool
  via `runner/session.ts`, `RunnerModuleOptions.refreshDependencies`; staleness uses the
  local lockfile and hidden npm lockfile modification times.
  The merge check uses the same reference-selection rule via `findDependencyReference` on the engine
  (`engine-host/merge-check.ts`, PM-580), selecting against the merged lockfile. When no installed
  source matches, the card merge's `allowDependencyInstall` (PM-711) turns this into a
  `dependencyInstallRequired` answer for the executor's sandboxed preparation instead of copying old
  packages or asking the owner; without the switch it still blocks with `check_error` before the checks.
  The merge source copy and full-test dependency store use `copyDependencyTrees` through the worktree
  facade (PM-710): root plus two workspace levels, relative links preserved, Darwin clone with plain-copy
  fallback, existing targets and linked parents skipped, local `.vite`, `.vite-temp` and `.cache` removed.
  Its shared deadline and abort stop and await the copying child. Store skeletons create only the
  real workspace parents identified from the merged lockfile. Task-session cloning keeps its existing path.
  Per-worktree serialization and directory backups protect replacements; a server-start lifetime registry
  restricts targets, failed lookups retry in 60 seconds and copying is bounded to 90 seconds. Provider hooks allow
  time for preparation (`runner/hook-forwarder.ts`, 120 seconds for Claude and Codex).
  No npm install runs outside a sandbox.
  Member clones may opt in through engine-local `repos[].workspaceSetup: {kind: 'npm_ci', timeoutMs?}`
  (PM-741, owner option 1). `full-test/workspace-dependencies.ts` runs fixed `npm ci` outside the
  member session, in srt on macOS only: package trees and a private run home/tmp/cache are writable;
  only registry.npmjs.org and nodejs.org are reachable, with no local binding. The entire user home,
  app home, engine secrets and shared session temporary roots (Claude roots and the parents of
  session tmp/folder roots) are denied reads, following the merge installer's home-wide boundary.
  Node or npm installed inside the user home (for example through nvm or Volta) makes the sandbox
  runtime probe fail with `sandbox_unavailable`, as on the merge installer path.
  Only the target clone, the run's own sandbox and its empty npm configuration files are allowed
  within those denials; other repositories, attachments, session files and dependency markers stay closed.
  Local install hooks, npm overrides, binding.gyp and linked inputs/targets are refused using the
  merge installer's checks. The environment is the full-test allowlist without PROJECTMAN variables.
  A per-clone single flight survives caller/link timeouts; shutdown aborts and awaits its process group.
  The engine atomically records `{version:1,key,nodeModules,preparedAt}` under
  `<home>/workspace-deps/<sha256(JSON [project,member,repo])>/ready.json`, outside member write access.
  The byte-based npm dependency key includes manifests and runtime versions; listed trees must still
  exist as real directories. Persistent input/install/timeout/sandbox failures retry after ten minutes
  (a changed key retries immediately); queue and abort errors are not memoized.
  `workspace.prepareDependencies` runs after checkout and before binding/launch for work and review,
  including resumes. Pending/failed preparations release the session reservation and defer its start;
  checkout refuses while preparation is busy. Single mode and unconfigured/older engines skip it;
  a configured non-macOS engine fails with `sandbox_unavailable`. All files, copies, subprocesses
  and queue operations stay on the execution engine; only the key-bound request and result cross RPC.
  A running session is gated too (PM-743): before a command tool (`needsDependencies` in `runner/tools.ts`;
  not file, search, web or team tools) the PreToolUse path of `runner/session.ts` calls
  `refreshDependencies`, which in `engine-app.ts` finds the session's clone in the engine-local
  `worktree/member-workspace-registry.ts` (filled by `onEnsured` after each `ensure`; no RPC, the
  `MemberWorkspaceManager` contract is unchanged) and runs `worktree/dependency-gate.ts` over
  `prepareDependencies` with an 80 s wait (`DEPENDENCY_GATE_WAIT_S`). A pending preparation turns every
  command away through the adapter's `refuseToolOutput` (Claude, Gemini); a failed one once per clone,
  key and reason, then the command runs with the dependencies as they are. Codex and NanoGPT cannot
  refuse: the command waits at most 80 s and then runs (warn). Gemini's PreToolUse hook timeout grows by
  80 s. A command already running when an install starts is not stopped. A clone the registry does not
  know takes the worktree path above.
  The same `workspaceSetup` switch also keeps the engine's own checkout of the repository (`repos[].path`)
  installed (PM-1083, replacing the operator's polling `deps-watch.sh`): `refreshCheckout` in
  `full-test/workspace-dependencies.ts` runs for each configured repository at engine start
  (`engine-app.ts`) and after a merge `advance` that fast-forwarded a checked-out default branch
  (`onCheckoutAdvanced` in `engine-host/branch-merger.ts`, passed through `local-engine.ts`); it
  acts only when that checkout's real path equals the bound repository path. A fresh checkout (hidden npm
  lockfile not older than `package-lock.json`, `worktree/dependencies.ts` `dependencyState`) runs nothing;
  otherwise the same sandboxed preparation as a member clone runs in the background (copy from the
  `_merge-deps` store on an identical key, else sandboxed `npm ci`), with marker
  `<home>/workspace-deps/<sha256(JSON [project,repo])>/ready.json`, heavy-lock label
  `workspace-deps <project>/<repo> (checkout)` and a per-path single flight. It never throws or delays the
  merge: a failure is a log line and the next advance or start retries (10-minute memo). A newer advance
  during the install changes the key, so the run publishes nothing and starts over. Machine assumption:
  macOS/srt, npm and the repository checkout on the engine's own disk; a remote engine does the same
  locally, behind the same `workspaceSetup` switch. Other worktrees are never touched.
  Target workspace ancestors must be real directories: component-wise `lstat` checks run
  during selection and immediately before every copy, rename and removal, including rollback
  and cleanup. Symlinked workspace paths skip the clone as unsupported. Node has no `openat`,
  so a small check-to-operation race remains; checks never deliberately traverse a replaced parent.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `worktree.refreshDependencies` (PM-313), find reference checkouts and probe the filesystem on the engine;
  retain the existing skip/install fallback on other platforms. The server's installation
  cannot be cloned across machines, and native dependencies must match the engine. Keep the
  runner, registry, freshness checks and copies together on the engine; the callback is local
  there and adds no server/engine request.
  **Module:** `worktree`
- **Heavy-run queue and worker limits** — `full-test/{heavy-lock,heavy-lock-core,heavy-lock-dir}.ts`,
  `scripts/heavy/{cli,run}.ts`, `packages/shared/src/config/test-workers.ts` and the workspace
  `vitest.config.ts` files (PM-332, PM-336). A per-user lock directory under
  `/tmp/projectman-<uid>/heavy` uses local atomic directory operations, PID liveness and
  heartbeats; worker limits use the executing host's CPU and memory. Same-host runs must
  use the same lock directory; different users are not automatically one queue. An unusable
  folder stops a member's heavy command (exit 78); the server's full test runs without the queue
  and warns (PM-346), except a merge check (`FullTestSpec.requireHeavyLock`, PM-658), which ends as
  `error` / `heavy_lock_unavailable` before anything starts.
  Optional merge dependency preparation (PM-710, connected to the card merge in PM-711) shares that
  mandatory reservation with the test (one acquisition, one `full_test_started`) and
  publishes at most one current and one temporary dependency generation per repository on this host.
  Member dependency preparation (PM-741) also requires this lock, labelled
  `workspace-deps <project>/<member>/<repo>`, waiting at most 30 minutes. Queue time is separate from
  the configured install timeout; an unavailable queue refuses preparation before installation.
  **Remote engine:** queue competing runs on each execution host and size workers there;
  `requireHeavyLock` and the `heavy_lock_unavailable` result cross the `full_test.run` boundary and the
  lock directory, PIDs and queue stay on the engine's machine. An older engine's strict spec schema
  refuses the field before running anything; the cloud then blocks the merge check with an
  "update the engine" message and does not repeat the request without the flag (PM-658).
  do not use the server's PID namespace, lock or hardware measurements for another engine. The
  engine supplies `SandboxPaths.heavyLockDir` from its own `defaultHeavyLockDir()` or setting,
  and with it the `StartSessionSpec.sandbox.portable` paths; its runner renders the Codex
  arguments and makes the folder (PM-311, PM-312).
  The FIFO test (`full-test/heavy-lock.test.ts`, PM-408) starts local child processes and waits
  for each named ticket to be readable through `readHeavyQueue` before starting the next;
  temporary files from atomic writes do not count as queued waiters. Run it on the execution
  host, using its own temporary directory and PID namespace.
  Since PM-311 the folder is `EnginePaths.heavyLockDir` of the session's engine (`contracts/engine.ts`).
  Idle closure asks that engine through `EngineHost.heavyRunSessions` / `host.heavy_run_sessions`
  (PM-569). PID and heartbeat checks run on the engine; only its own running session ids cross
  to the server. An unavailable or older engine returns no sessions, retaining normal idle closure.
  The hybrid release coordinator (PM-751) takes the same machine's queue lock through the `HeavyLockPort`
  (`scripts/release/adapters.ts` `heavyPort`, `npm run heavy`'s lock) for the drain-to-end window of one
  attempt, so a card's full test never runs while the Mac engine is switched. The lock folder is the
  administration Mac's, not an engine's.
  The queue does not apply in GitHub mode (`FullTestSpec.githubActions`, PM-900): the machine does not run the tests.
  **Module:** `full-test`
- **Server and engine log files** — `logging/{rotating-file,server-log}.ts`, `index.ts` (`loggerOptions`)
  (PM-444), exposed through `logging/index.ts` to `index.ts` and
  `engine-link/engine-audit.ts` (PM-649). Every process logs pino's JSON lines to the terminal and, since PM-444, to
  `<PROJECTMAN_HOME>/logs/server.log` (single mode and the cloud) or `logs/engine.log` (engine
  mode); the terminal's scrollback alone lost the older lines. The file is appended across starts,
  rotated at 10 MB (`server.log` → `.1` → … `.4`, five files, so about 50 MB at most), mode 0600 in
  a 0700 folder. It holds exactly the lines the terminal gets, with the same serializers (request URLs
  have invitation, hook and MCP tokens redacted; no headers, bodies or keys). A failing file write is
  reported once on the terminal and never stops logging there. The engine's per-request audit
  (`logs/engine-audit.jsonl`) uses the same rotation helper but is a separate file. Assumes a
  writable local home on the host that runs the process and one process per home.
  **Remote engine:** each process writes its own log on its own host: the cloud's under the cloud's
  home, the engine's under the engine's home. Logs are not shipped across the link; to read the
  engine's log, read it on the engine's machine.
  **Module:** `logging`
- **Session output folders** — `index.ts`, `engine-host/session-folders.ts` (`SessionFolders`),
  `engine-host/sandbox-dirs.ts` (`prepareMemberSandboxDir`, `preparePortablePaths`),
  `engine-host/session-roots.ts` (`defaultSessionTmpRoot`, `sharedClaudeTmpRoots`, the roots'
  preparation), `engine-host/local-host.ts` (opening the folders, the overlap check with the queue's
  folder), `runtime/sessions` (`SessionOrchestrator`, `SessionLauncher` in `launch.ts`, `session policy`) (PM-268, PM-333, PM-339, PM-312).
  `runtime/sessions/permission-broker.ts` uses the existing readable-root calculation directly
  (PM-960); policy rendering and folder operations remain in runtime and on the engine. Legacy Claude
  sessions, and Codex sessions whose sandbox writes (`workspace-write`), receive a per-process
  writable folder below the server's real `tmpdir`; the server makes, sweeps and removes it. Since
  PM-522 Gemini, NanoGPT and read-only Codex sessions get one too (`sessionFolderAccess`):

  | Session                                                        | Folder                                                     | Own TMPDIR, browsers, screenshots |
  | -------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------- |
  | Claude; Codex or NanoGPT with `workspace-write` and a tmp root | write                                                      | yes                               |
  | Codex or NanoGPT read-only (`default`, `plan`, reader)         | read; only the server writes it                            | no                                |
  | Gemini                                                         | write by file tools under the hook gate (not in plan mode) | no                                |
  | `workspace-write` without a tmp root, `danger-full-access`     | none                                                       | –                                 |

  A read-only Codex or NanoGPT sandbox names the folder in `PROJECTMAN_SESSION_DIR`, reads it and
  opens its images with `view_image`, but does not write it. **Remote engine:** `folders.make` and
  `files.materialize_into_session` do not depend on the provider; an older engine's Codex adapter
  lacks the read-only `view_image` and the Gemini environment. A Codex session also gets its
  own short temporary directory, `<realpath('/tmp')>/projectman-<uid>-tmp/<home hash>/<12 random hex>`
  (`defaultSessionTmpRoot`, `SessionFolders.allocateTmp`/`make`), its `TMPDIR` and a writable root,
  removed and swept with the folder; without a safe tmp root Codex gets no folder. The root is 0700
  and a sibling of the heavy-run queue's parent `projectman-<uid>`, never below or above it (that
  parent is writable for every member's commands, so a path there could be pre-empted or read by a
  member; an overlap, compared as written and by canonical path through links, leaves Codex without a folder); a directory is new at every start and made
  without `recursive`, so a link put there beforehand stops the start. The path is short because a Unix
  socket's is limited to 104 bytes. The Codex adapter then closes the shared `/tmp` and the CLI's
  `$TMPDIR` for its commands.
  A legacy Claude session gets the same kind of directory (PM-353) and the Claude adapter's
  `launch` hands it to the CLI as `CLAUDE_CODE_TMPDIR`, so Claude Code's temporary root
  (`<CLAUDE_CODE_TMPDIR>/claude-<uid>`: the scratchpad, background command output, subagent
  output, `bash-edit-diff`) is the session's own instead of the machine's shared
  `/tmp/claude-<uid>`. The name is 12 hex digits (no session id) because Claude Code falls back to
  the shared root when the path is too long. The shared roots (`sharedClaudeTmpRoots`: `/tmp/claude-<uid>`,
  `<CLAUDE_CODE_TMPDIR of the server>/claude-<uid>`, `/tmp/claude`, each as written and by
  canonical path) are denied: to the file tools (`deniedPaths`), and to the commands of a
  developer's and a reader's sandbox (`denyRead`, `denyWrite`, with the own tmp re-opened). The
  tmp root's parent is closed to Claude sessions as well. A Codex session always gets the roots
  in `deniedPaths`. A Claude session without a safe tmp root (no folders, or an unusable root) runs
  as before and the shared roots are not denied for it (fail-open: the CLI still needs them).
  A session that is already running keeps its old rules until its next start.
  Fake app tests use `claudeTmpRoots: []` in `test/helpers/app-harness.ts` and
  `test/auth-restart.test.ts` instead of discovering the executing machine's shared Claude
  directories (PM-633). Tests that inspect these roots can supply explicit fixtures through
  the harness's `app` options. This test isolation leaves production root discovery and the
  server/engine boundary unchanged.
  Engine-host fixtures in `test/engines.test.ts` also supply explicit `claudeTmpRoots`
  (PM-635), so the remote/offline and engine-disk tests do not discover the user's directories.
  The tmp root is another machine-dependent assumption: a shared host-local `/tmp`.
  Every Claude session reads all the folders below the instance's root
  (`realpath(tmpdir)/projectman-sessions/<home hash>`), through the file-tool rules the policy
  renders (`filesystem.sessionFolder`, `sessionFoldersRoot`; `claudeToolRules`) and a developer's
  sandbox `allowRead`; it writes only its own folder. A resumed session gets a new folder, and its
  system prompt says that the old paths are gone and the card's attachments stay. Another
  instance's root (another home hash) gets no rule.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `folders.*`, `files.export` and `files.materialize` (PM-313), allocate and clean up on the executing host, generate its sandbox paths
  there, and transfer output through an authenticated attachment path rather than reading a
  remote absolute path on the server. The root is a property of the engine (the PM-312 host's
  file system), not of the server; the policy carries the two paths to the host that runs the
  CLI. A member reads only the folders of sessions on its own engine; images move between
  machines through `attach_file` → `read_attachment`. The Claude Code roots (`/tmp/claude-<uid>`,
  the server's `CLAUDE_CODE_TMPDIR`) are those of the engine's host too: compute `sharedClaudeTmpRoots`
  and allocate the session's tmp there, and pass `CLAUDE_CODE_TMPDIR` to the CLI on the engine.
  Since PM-311 the registry is `EngineHost.sessionFolders` (`EngineSessionFolders`) and the roots are
  `EnginePaths.sessionFoldersRoot`, `sessionTmpRoot` and `claudeTmpRoots` (`contracts/engine.ts`);
  `createLocalEngine` (`engine-host/local-engine.ts`) prepares them, with the same checks as before.
  Since PM-312 the disk work is the engine's too: `make`, `remove`, `sweep` and `releaseTmpRoot`
  are asynchronous (the domain awaits a session's pending removal before it makes the new folder at
  a restart, `Sessions.folderRemovals`), and the member's sandbox directory (0700) with its git
  settings (0600) is made by `EngineHost.prepareMemberSandboxDir`; a failure is the start's
  `session_start_failed` with `details.stage = 'member_sandbox_dir'`. The domain computes the paths.
  **Cloud mode (PM-315):** `RemoteEngineDirectory` (`engine-link/remote/host.ts`) makes, removes and releases
  the folders on the engine (`folders.*`, `host.*`) and keeps the paths in the hub's mirror, so
  `sessionFolders.of` answers without a call; a `link_down` while releasing the temporary root at stop is
  ignored (the engine cleans up when it is back).
  **Module:** `engine-host`

- **Card attachments (PM-644)** — `core/attachments/attachments/{service,storage,thumbnail}.ts`
  (through `core/attachments/index.ts`) and `contracts/attachments.ts`. Records and the private
  `<PROJECTMAN_HOME>/attachments` store belong to the server; local storage uses 0700 directories,
  0600 files and no-follow opens, and `sharp`/libvips generates thumbnails there.
  **Remote engine:** keep storage and image processing beside the server. Engine callers use
  the existing authenticated attachment/transfer boundary; their local paths are not server
  storage paths. No new RPC or payload is introduced by moving these files.
  PM-1059: the engine's cache folder of a card is on `projectEngine(projectKey)` and a file is given to
  the engine of the session that reads it (`runner.engineOf`, else the project's), never to another
  engine when that one is away; the stored files stay beside the server.
  **Module:** `core/attachments`
- **Message attachments (PM-516, PM-644)** — `core/attachments/message-attachments/` (through `core/attachments/index.ts`), `api/message-attachments.ts`, `mcp/attachments/tools.ts`
  (`read_message_attachment`), `mcp/server.ts` (`runTool`). The files of team messages live under
  `<PROJECTMAN_HOME>/message-attachments/<projectKey>/<id>` (0700 directories, 0600 files, `.thumb`,
  `.part`), written and read by the server process on its own disk (`O_EXCL`, `O_NOFOLLOW`), and
  reached only through the protected REST routes and the team tool. A session never gets a path into
  that store: `read_message_attachment` returns the content itself (an image, a small text), and for
  what the content cannot show (PM-518) a copy in the caller's own session folder (below).
  `contracts/sandbox.ts` includes the entire store in `sensitivePaths` (PM-524), denying
  direct file-tool and sandboxed shell access on the machine that hosts a session; authorized
  copies in its session folder remain readable. Remote engines use the same policy for their
  local app home and receive authorized files through the existing transfer boundary below.
  The unsent uploads older than 24 hours are removed by an hourly sweep and at startup.
  PM-1059 changes nothing here: the files stay on the server and the copy into a session folder goes
  to the session's own engine ("Message file in the session folder").
  **Remote engine:** the server (cloud) keeps the files and the database. The tool call reaches the
  server as `mcp.relay`, and an image travels back in the MCP result
  as base64 inside that frame. A frame is at most `ENGINE_MAX_FRAME_BYTES` (4 MiB), hence the
  downscale: the image is a WebP of at most 1568 px a side and 1 500 000 bytes (about 2 MB as
  base64), made on each request (`MessageImageRenderer`, `sharp`, the server's libvips). A text is
  at most 100 000 bytes. The home directory itself must be on one machine with the server, as for the
  card attachments. The hybrid move (PM-666) carries the store to the cloud's home as the entry
  `message-attachments` and brings it back with `hybrid back`, byte for byte.
  **Module:** `core/attachments`
- **Message file in the session folder (PM-518)** — `mcp/attachments/handler.ts` (`readMessageAttachment`,
  `sessionFileTarget`), `core/attachments/message-attachments/` (`source`, `locate`,
  `sessionFileName`), `engine-host/session-folders.ts` (`SessionFolders.materializeFile`),
  `engine-link/{methods,engine-handlers,engine-limit}.ts` (`files.materialize_into_session`),
  `engine-link/remote/host.ts`, `contracts/runner.ts` (`PROVIDER_MCP_IMAGE_RESULTS`). When the
  content of a message file is `none` (a PDF, a binary, a text too big), or an image for a provider
  whose CLI shows no image in an MCP tool result, the server has the caller's engine put a copy at
  `<session folder>/<id>-<name>` (0600, straight in the folder with no subdirectory since PM-523, see
  SECURITY.md; the same path for the same bytes) and the tool answers with that path. The caller is the session the MCP token names; the
  target is its own folder only, and a guest conversation of the Operator or of the project manager (no folder, `teamToolsOnly`)
  gets none. PM-1061: the copy goes only to the engine the session runs on, and the engine must be bound to the
  session's project (`files.materialize_into_session` is session-scoped, a project call is checked by the hub guard).
  A failure (engine offline or older, no folder, a disk error) is logged and the tool
  answers as before, without a path. `mcpImageResults` per provider: claude and codex true (Claude Code
  and Codex render an MCP `image` result), gemini and nanogpt false (the Gemini CLI has no place for
  one yet; NanoGPT is Codex over a custom provider, so it depends on the model): the first reading of
  an image gives them the file. Since PM-522 every provider has a session folder where the sandbox
  allows one (`sessionFolderAccess` in `runtime/sessions/session-policy.ts`: Gemini; Codex and NanoGPT with a
  writing sandbox or a read-only one), so a Gemini or NanoGPT session gets the path too. **Open:** that
  Gemini's `view_file` shows a PDF or an image to the model, and that a NanoGPT model uses
  `view_image`, are unproven; the path is returned either way.
  PM-1059: with several engines the copy goes to the engine whose folder the session has
  (`sessionFolders` of that engine), tested with two engines; no new RPC.
  **Remote engine:** the local engine copies from the server's disk (`O_NOFOLLOW`, a regular file,
  size and SHA-256 checked, staged in the folders root and linked into place). A remote engine gets
  the file with a single-use download token (`transfers.issueDownload`, the same way as
  `files.materialize`), `files.materialize_into_session` fetches it into a scratch directory of its
  own, checks size and checksum, and `SessionFolders.materializeFile` puts it in. The engine's limit
  allows the call only for a session whose folder `folders.make` created on it, with a plain name and a
  valid token. An engine without the method answers `unknown_method`, which counts as a failure above.
  **Module:** `mcp`
- **Browser installation and screenshots** — `index.ts`, `runtime/sessions` (`session policy`),
  `engine-host/screenshots.ts` (`resolveScenario`, `listImages`),
  `scripts/{browsers,shots}.mjs`, `scripts/lib/browser.mjs` (PM-268, PM-270, PM-312).
  Playwright loads local Chromium binaries from the configured browser directory (default
  `<PROJECTMAN_HOME>/browsers` in the server; the scripts also accept
  `PLAYWRIGHT_BROWSERS_PATH`). `shots` launches a disposable local instance and browser,
  and writes images to local output storage. For a Codex member, whose sandbox cannot start
  Chromium, the server runs `npm run shots` itself (`take_screenshots`, `get_screenshot_run`,
  PM-351): `services/full-tests/{screenshot-runs,screenshot-core}.ts`, `full-test/{screenshots,run-sandboxed,run-sandboxed-core}.ts` start it in the
  member's worktree inside the macOS `srt` sandbox, with the session's own read/write limits and
  the session folder as the output; it queues in the machine's heavy-run queue and is off outside macOS. Since PM-312 the scenario file is resolved and the images are
  listed by the session's engine (`EngineHost.resolveScenario`, `listImages`); a refusal reaches the
  member as the same `TeamToolError('invalid', …)` texts as before.
  Scenario resolution sends only `{ cwd, sessionDir }` as roots, without the browser directory
  or sandbox settings, matching the strict `files.resolve_scenario` contract in hybrid mode
  (PM-785). This adds no machine-dependent operation and leaves the engine boundary unchanged.
  **Cloud mode (PM-315):** `screenshots.run/cancel` run on the session's engine
  (`services/full-tests/screenshot-runs.ts` takes a remote executor, announced by the engine's `screenshot_started`
  event); a run with no connected engine is refused as `engine_offline`. The scenario and the image list come from the engine (`files.*`).
  `index.ts` builds no local screenshot executor in cloud mode.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `screenshots.run/cancel`, `files.resolve_scenario` and `files.list_images` (PM-313), provision a compatible browser on the engine, preserve the disposable
  instance's network fence and read-only browser access, and return images as artifacts. The
  screenshot run belongs on the engine that owns the member's worktree and session folder (the
  server cannot run it against a remote path); the server keeps only the tool and the run record.
  Since PM-311 the browser directory is `EnginePaths.browsersDir` and the run is the
  `EngineHost.screenshotExecutor` of the requesting session's engine (`contracts/engine.ts`).
  **Module:** `engine-host`
- **Machine display and orphan processes** — `machine/{probe,parse}.ts`,
  `runtime/watchers` (`MachineMonitor.stopOrphans`), `api/machine.ts` (PM-320, PM-300).
  Demand-driven rounds and bounded request waits run on the server in
  `runtime/watchers/machine-rounds.ts` (Effect, PM-617); measurement and signalling stay
  behind the existing machine probe boundary.
  OS probes (`ps`, macOS `vm_stat`/`sysctl`, Linux `/proc`) measure the local host; trees,
  ownership checks and signals use its UID and PID namespace, with process start times
  checked against PID reuse. **Remote engine (engine mode, PM-314: runs in the engine process):** use `machine.snapshot/processes/env_values/signal` (PM-313), measure and stop on the owning engine,
  identify the engine with every process identity, and preserve fresh ownership/orphan
  checks and owner access (the host owner's, not every project's owner, PM-1058). A remote PID must never be signalled on the server.
  **Cloud mode (PM-315):** `RemoteMachineProbe` (`engine-link/remote/machine.ts`) asks the default engine
  (`machine.snapshot/processes/env_values/signal`; `MachineProbe.signal` is asynchronous for it); with no
  engine the machine view answers `engine_offline` (409). Since PM-1059 "the default engine" is
  `EngineDirectory.hostEngine()`, asked at every call: the view, the identity and the signals of the
  orphan round always target the same host machine and never a project's engine.
  **Filtered diagnostics (PM-697):** `services/operator/project-state.ts` projects only
  CPU percentage, memory, sample time and free disk space through the assembly adapter.
  The latest card session selects the stored engine id; no session, offline or a different
  engine than the monitor's gives `machine: null`. Disk space comes from that same
  `EngineHost`. In v1 cloud mode always returns `machine: null`: the monitor's snapshot
  and CPU reference carry no engine identity or measurement generation, so a fresh
  timestamp alone cannot prove their origin. A future cloud metrics source must bind
  both to the owning engine and measurement generation. Server task, delivery
  and check records remain readable offline. No process details or transcripts are exposed,
  and no new probe or RPC is introduced.
  **Module:** `machine`
- **Instance identity for process attribution** — `app.ts` derives the first 16 hex characters of
  `sha256(realpath(home))`; `runner/env.ts` supplies `PROJECTMAN_INSTANCE` alongside
  `PROJECTMAN_SESSION_ID` (PM-320). This identifies a local installation by its home path,
  not a host-independent engine identity. PM-698 adds
  `PROJECTMAN_SCOPE_ID=scp_<16 random hex digits>` for each process start.
  A resumed conversation gets a new scope generation. Engine recovery requires the engine's own
  instance tag and uid; nested installations cannot adopt one another's marked scopes.
  **Remote engine:** plan instance/engine attribution
  explicitly, including reconnects and moves; equal paths on different hosts must not imply
  equal ownership.
  **Module:** `entry`
- **Session process termination** — `runner/session.ts` (`stop`, `kill`),
  `runner/runner.ts`, `runner/process-scope/{types,process-group,index}.ts` (PM-698).
  Each engine owns the scope of every session, including marked detached children. Pipe sessions
  start as process-group leaders; PTY sessions use forkpty/setsid. Closing sends TERM, polls for
  up to 5 s, then KILL and polls for up to 2 s. Individual signals recheck uid, pid/start time
  and generation; group signals require verified current members. Natural exit, stop, forced stop,
  startup failure and shutdown all close; idle turns do not. Startup recovery adopts this instance's
  marked scopes. `db/session-cleanups.ts` and `runtime/sessions/cleanup-failures.ts` retain every
  unresolved scope in `session_cleanups` (including chat, Operator and legacy worktree sessions),
  atomically with any member-workspace failure flag. The server retries at startup and every
  minute through `session.close_scopes` on the owning engine.
  The optional `sinceAgeMs` lower bound is an age derived from stored server-side start/failure
  times. The engine computes `clock.now() - sinceAgeMs - SCOPE_SINCE_MARGIN_MS` on its own clock;
  differing server/engine wall clocks therefore do not affect attribution. The 60 s margin covers
  transport delay and process-list time precision. PM-933 restricts unreadable candidates to those
  potentially related to the scope: they share the known leader's or an identified member's process
  group, or their parent chain reaches an identified member before a different scope marker or an
  ancestor older than the bound. Readable ancestors without markers are traversed. Parent chains
  use the same process snapshot, with cycle detection and a 256-ancestor limit; unresolved cycles
  or depth limits remain unverified. Unrelated orphans (launchd/XPC helpers on macOS included) and
  missing parents outside the scope's groups do not block best-effort cleanup. Without an age
  (an older server), ancestry has no time bound. Explicit marker matches are checked regardless of
  age. Failed and unverified closes retain known identities and the leader group for later retries;
  only clean closes discard them. Entire process/environment probe failures remain unverified.
  Dismissing an Operator notification cannot clear this fact. Session folders and task worktrees
  stay while cleanup is unresolved.
  Resume is refused while cleanup failed; only a matching clean generation releases the holder.
  The `process_group` driver is `best_effort`: a child that escapes the group and clears its marker
  cannot be attributed. Without a process list cleanup is `unverified`, never `clean`; PM-701 adds
  contained Linux cgroups. **Remote engine:** inspection, signals and recovery run on the engine.
  Exit carries `SessionCleanup` only after closure; failed cleanup holds the workspace and raises an
  owner-facing Operator signal, later `scope_recovered` releases it. Old engines without cleanup
  retain the process-probe fallback. A remote pid is never signalled on the server.
  **Audited release (PM-935):** when a cleanup cannot be proven clean, the owner, or the
  Operator on the owner's explicit request, runs the `workspace_release` super command
  (`scopeId`, mandatory `reason` without hidden or control characters; a routine mutation with no
  owner-reserved effect, reachable only through the integrator/owner super path, never by members).
  The Operator's `execute_operation` enforces the owner's request on the server: it runs only when
  the open request is the owner's own message or answer, never a queue item (`operator_owner_only`). `SessionOrchestrator.releaseCleanupScope`
  calls `CleanupFailures.release`, which in one transaction frees the member workspaces held under
  that scope and deletes the `session_cleanups` row, then appends the append-only
  `workspace_released` timeline event (scope, session, workspaces, reason, actor) and emits
  `session_cleanup_released`, which resolves the Operator signal. The minute retry skips a
  `closeScopes` result for a scope whose row is gone, so a late failed result cannot re-insert it;
  startup recovery is not guarded. **Remote engine:** only server-side SQLite state changes. No
  engine call is made, and the retry stops because `closeScopes` is sent only server rows, so any
  surviving process on the engine is left running and unmanaged.
  Lifecycle tests use `runner/test-helpers.ts` (`fixtureScopeProcesses`) and identity records from
  `test/fixtures/fake-tui.mjs`, with null-signal liveness checks limited to disposable fixture pids.
  This keeps pipe and PTY tests independent of host-wide `ps` permissions; production inspection
  and the remote-engine boundary remain unchanged (PM-698). The fake-CLI app harness
  (`test/helpers/app-harness.ts`) uses the same fixture process source for its runner, so
  conversation/resume tests do not depend on inspecting unrelated host processes (PM-928).
  **Module:** `runner`
- **Conversation transcripts and resume** — `runner/transcript/{reader,tailer,confined}.ts`,
  `runner/session.ts`, `runtime/sessions` (`SessionOrchestrator`, `SessionLauncher` in `launch.ts`), `runner/providers/{claude,codex}/transcript.ts`
  (PM-340). NanoGPT uses the separate home in **NanoGPT Codex home and key delivery** (PM-329).
  The reader selects the shared Codex transcript format with `usesCodexCli` from
  `packages/shared/src/domain/provider-model.ts` (PM-330); this changes no path or engine assumption.
  Claude conversations live under `~/.claude/projects`; Codex rollouts under
  `CODEX_HOME/sessions`. The server reads and tails hook-reported files, and resume eligibility
  checks transcript content. A task session's cwd is the member's workspace, whose path uses the
  member's storage handle (PM-1024), so a rename of the member leaves the cwd, and with it the
  conversation's place under `~/.claude/projects`, unchanged.
  PM-342 adds `TranscriptReader.summary` (`runner/transcript/summary.ts`): when a member's new
  conversation replaces one that could not go on (provider changed, lost, moved) or a card is
  handed over without a note, the server reads the old transcript for the CLI's compaction
  summary plus the last replies (at most `HANDOFF_SUMMARY_MAX` = 8000 characters) and puts it in
  the new conversation's first message.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `transcript.has_content/read/summary` and runner events (PM-313), keep CLI conversation state and resume checks on its engine/account,
  stream conversation events to the server, and preserve confinement. A conversation ID
  without its engine's saved state is insufficient for resume. `summary()` runs on the engine,
  next to the conversation; only the `HandoffSummary` (at most 8000 characters) crosses the
  server/engine boundary.
  PM-766 carries the public super-mode `Actor` (id/prefix, never the bearer secret) from
  `core/messages/messaging.ts` and `runtime/delivery/delivery.ts` in a separate injected metadata
  line. The shared chat formatter/parser and `runner/transcript/chat-items.ts` preserve it in
  `ChatItem.actor` for single, information and batched messages. On a remote engine the same
  injected text travels to the engine; live chat and `transcript.read` return this display
  provenance to the hub. Missing or invalid metadata keeps historical rendering and grants no rights.
  Since PM-311 a session records its engine (`sessions.engine_id`, `Session.engineId`), the transcript
  reader calls carry the optional `engineId`, and a conversation resumes only on the same engine (a
  different one counts as `relocated`).
  **Cloud mode (PM-315):** `createRemoteTranscripts` (`engine-link/remote/transcripts.ts`) asks the session's
  engine (`transcript.has_content/read/summary`); the transcript text crosses as a single-use transfer.
  **Module:** `runner`
- **Hooks and team MCP over loopback** — `index.ts` (`loopbackBaseUrl`),
  `runtime/sessions` (`SessionOrchestrator`, `SessionLauncher` in `launch.ts`, `LiveSessions`), `runner/runner.ts`, `runner/hook-forwarder.ts`,
  `kernel` (`nonLocalReason`), `runner/providers/{claude,codex}/args.ts` (PM-341; PM-286, PM-310,
  PM-311). CLI hooks and MCP target the server's loopback URL (`127.0.0.1:4800` for the live
  instance; the port is configurable). The internal guard also checks the peer, Host and
  forwarding/origin headers; merely changing the URL to a public server cannot work.
  **Codex team server stays optional (PM-1070):** `runner/providers/codex/args.ts` passes
  `mcp_servers.team` with only its `url` and tool approvals. PM-1055 had set
  `required = true`, a 20-second startup timeout and `mcp_optional_startup_grace_ms = 0`;
  from that deploy every Codex session exited at start ("agent CLI exited before it was
  ready"), so it was reverted. A failing team MCP must cost the tools, not the session.
  The root cause of the team MCP start failure is investigated separately.
  **Remote engine:** unchanged; the token-bound loopback relay supplies the catalog. PM-1061: the relay (`mcp.relay`)
  serves a token only when its session runs on the requesting engine and the session's project is bound to that
  engine; another owner's engine cannot reach a project it is not bound to through a stolen or guessed token.
  **Team MCP relay log (PM-1072):** the engine logs each `initialize` and `tools/list` relay
  (method, status, elapsed time) at info, and every refused (non-2xx), failed or badly
  answered relay at warn; the cloud logs why it refused a relayed token. Neither logs the
  token or the body. A Codex session without team tools therefore shows in the engine log
  where its handshake stopped (no call, a slow one, a refusal); the cause of the intermittent
  missing tools was not yet reproduced with a real Codex run.
  Submission timeouts (PM-442) log retry count, elapsed time, command/idle state and bounded
  CLI diagnostics from `runner/input-queue.ts` and `runner/session.ts`: prompt/resume flags,
  the last hook name/time, blocking-screen detection and at most 500 characters from the last
  15 terminal rows. Message bodies are not logged separately. This assumes the runner owns
  the terminal and receives the CLI hooks; it changes neither delivery nor retry semantics.
  On a remote engine these diagnostics run and are logged on that engine; no new message or
  diagnostic payload crosses the server/engine boundary.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `permission.decide/cancel/forward_question`, `refused` events and `mcp.relay` (PM-313), plan an authenticated engine transport/local relay for hooks, decisions
  and MCP while preserving token isolation and the internal endpoint guard.
  `runtime/sessions/permission-broker.ts` owns the broker and uses the command policy
  directly (PM-960); no hook payload or transport changes.
  **Cloud mode (PM-315):** the cloud registers no hook routes (`registerHookRoutes` is empty) and listens
  on no loopback for the CLIs. `permission.*` and `mcp.relay` are handled by `engine-link/remote/handlers.ts`;
  the relay runs the request through the cloud's own `/mcp/<token>` route and answers 404 for a token whose
  session runs on another engine.
  **Module:** `runner`
- **Private session launch configuration (PM-156)** — `runner/session-config.ts`, `runner/runner.ts`,
  `runner/hook-forwarder.ts`, `runner/session.ts`, `runner/providers/{claude,codex,nanogpt,gemini}`,
  `contracts/sandbox.ts` (`SESSION_CONFIG_DIR`), `app.ts`, `engine-app.ts`. The MCP and hook tokens are
  not on a command line: the runner writes them to `<app home>/run/<session id>.<random>/` (the folder
  0700, files 0600, one folder per start, removed when the session's process has exited, orphans swept
  at start-up) and gives the CLI the file paths (`--settings`, `--mcp-config`) or the forwarder the
  path of its target file. **Machine assumption:** POSIX file modes and ownership on the disk of the
  machine that runs the CLI, and the machine's process list (`ScopeProcessSource`) for the sweep; the
  sandbox rules keep the session's own commands and file tools out of the root.
  **Remote engine (engine mode):** the folder, the files and the sweep live on the engine that spawns
  the CLI: `engine-app.ts` passes `<engine home>/run` as `sessionConfigRoot`, and the sandbox rules name
  the engine's own paths, so nothing crosses the server/engine boundary and the cloud never sees a file.
  The cloud's runner (`engine-link/remote`) creates no real runner and needs no root.
  **Cloud mode (PM-315):** unchanged; the token still arrives with the start command and is written on the
  engine. Related: "Session output folders", "Hooks and team MCP over loopback", "Native sandbox and
  canonical paths" (the root is in `sensitivePaths`).
  **Module:** `runner`
- **Work volume (PM-846)** — `engine-host/work-roots.ts` (`resolveWorkRoots`, `WORK_ROOT_MARKER`,
  `WorkRootError`), `engine-link/engine-config.ts` (`workRoot`), `engine-app.ts`, `app.ts`,
  `index.ts` (`PROJECTMAN_WORK_ROOT`, single mode only), `scripts/engine/{commands,move-work-root}.ts`
  (`npm run engine -- move-work-root`). An optional work root puts `worktrees/`, and `workspaces/` below one
  directory, so that a separate APFS volume with `.fseventsd/no_log` takes the file churn that made
  `fseventsd` grow to 17 GB. The full test's `pmft-*` run directories stay in `os.tmpdir()` (PM-848): the full
  test sandbox denies the home for reading and allows only the run's own directory, so a run directory
  inside the home leaves its parents unreadable. Absent: the
  paths below `PROJECTMAN_HOME`, as before. The start fails closed (`work_root_invalid`): an absolute
  path, an existing directory, a regular `.projectman-work-root` file in it (an unmounted volume is an empty
  directory on the system volume) and a real path strictly inside the real home. Inside the home, because the
  session sandboxes keep the other members' work unreadable by denying the home. The code uses only the real
  path (Seatbelt compares real paths). Machine assumption: an APFS volume mounted at a path inside the
  home (fstab/`vifs`), steps in `docs/DEPLOY.md` "Separate work volume on a Mac". The sessions' `$TMPDIR`,
  the Claude temp directory and `member-caches` stay where they are (Unix socket path limit, PM-339).
  `move-work-root` runs with the engine stopped: it copies, repairs the git links, checks them, renames
  the old directories to `*.pre-PM-846` and then writes `engine.json`; no database migration, because the
  sessions' relocation and the workspace generation start a new conversation with a summary.
  **Remote engine:** yes. The setting is in that machine's `engine.json` and the volume step runs on the
  engine's machine; `EnginePaths.worktreesRoot/workspacesRoot` already describe the engine's own paths, so
  nothing new crosses the server/engine boundary. On Linux there is no `fseventsd`; the marker check is
  platform independent and a separate disk works the same way.
- **Task worktrees and shared git storage** — `worktree/worktree-manager.ts`,
  `worktree/member-workspace-manager.ts`, `worktree/paths.ts`, `runtime/watchers` (`WorktreeSweep`),
  `index.ts` (PM-243; PM-311, PM-312; PM-770). With a work root (PM-846) the worktree and workspace
  roots are `<workRoot>/worktrees` and `<workRoot>/workspaces`. The sweep picks its candidates from the server database
  (paged `closed-worktrees` reads, no whole card list); the worktree itself is still found, checked and removed
  on the card's engine. Task worktrees default to
  `~/.projectman/worktrees/<project>/<task>-<repo>`; git links them to the main repository's
  common git directory. Canonical paths, branch ownership and cleanup are local filesystem
  operations. A member's workspace (`<workRoot>/workspaces/<project>/<member>/<repo>/repo`), its
  `.home`, its sandbox directory (`member-caches/<project>/<member>`) and its `member_workspaces`
  row use the member's storage handle (PM-1024), so a rename does not move them; the
  `MemberWorkspaceKey.member` the server sends to the engine is that storage handle, and the engine
  RPC schema is unchanged. PM-368's `core/messages` and `runtime/delivery/delivery.ts` also use
  `SessionOrchestrator.sourceHead` to snapshot the local branch for sent messages and input batches;
  PM-342's `runtime/admission` (`HandoffService`) uses it for the branch, last commit and uncommitted state of a handoff note or fallback.
  PM-712 uses the existing engine-local `sourceHead` read again before loop triage and human
  fallback, so a review fix committed since detection closes the loop. Only commit/time facts
  reach the server; unavailable heads never count as progress. No new git or shell capability.
  PM-818: `runtime/sessions/sessions.ts` resolves an unassigned card's source engine from its latest
  branch-bearing `work` binding's member placement, in the same order as `MemberWorkspaces.workOf`.
  With no such binding it uses the latest task session with a branch or reviewed commit (including legacy
  remote task worktrees), read by the bounded `SessionRepository.latestSourceOfTask` query.
  If the card has no assignee, no work binding and no source session, and LOCAL is not registered, there is no engine source to read:
  `sourceHead` returns null without RPC. Single-machine assembly always registers LOCAL; a registered
  but disconnected engine and a recorded developer workspace retain strict read failures. Remote git
  still runs on the selected engine; no engine path is read by the hub and no RPC contract changes.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `worktree.*` and `workspace.*`, run this git query beside the worktrees and return the attributed branch head
  to the server for its version and input formatting; maintain repositories/worktrees and git metadata there;
  plan branch/commit transfer and remote status/cleanup rather than treating server paths
  as shared storage.
  **Handing a commit over (PM-739):** a member workspace is an independent clone without a remote, so
  the repository, the reviewers and the merger do not know a developer's commit.
  `MemberWorkspaceManager.publishTaskBranch(key, taskKey, branch, commit)` (RPC
  `workspace.publishTaskBranch`, params `[key, taskKey, branch, commit]`, result strict `{path, ref}`)
  runs on the engine that holds both the developer's workspace and the repository: it checks that the
  commit is on the developer's task branch, takes the branch tip through `WorkspaceAccess.transfer`
  (the same keyed lock and isolated git as every other workspace operation) into a temporary
  `refs/projectman/incoming/<member>/<TASK-KEY>/<random>` ref, proves the commit is in the fetched
  history and creates `refs/projectman/workspaces/<member>/<TASK-KEY>/<commit>` in the repository only
  if it is missing (`update-ref` with a null old value; an identical object id is accepted, another
  one is refused). Nothing else of the repository moves: no push, no remote, no branch write, and
  snapshots are never removed. The cloud sends no path or ref; `engine-limit.ts` binds the repository
  and checks the full object id. A review round pins `sourcePath/sourceRef/sourceCommit` to the
  snapshot; rounds pinned before keep their direct workspace path. A task branch can also be found
  through its snapshots (`findTaskBranch`); several distinct commits are chosen only by the exact
  one named. An engine that does not know the RPC makes the hand-over fail with
  `workspace_source_missing` (`details.reason: engine_update_required`). **Does this work on a remote
  engine?** Yes: the workspace, the repository and the transfer are all on the engine; only the
  request and the `{path, ref}` answer cross the link.
  **Design review before stage hand-over (PM-828):** a member with `ux_design` and without
  `implementation` duties, who is not the assignee, uses a review copy whenever another member
  has a branch-bearing work binding on the card, in any stage. Planning without such a binding
  keeps its writable workspace. A developer's action message starts a new round on the current
  developer tip through the same immutable snapshot transfer, including after a rebase. A manual
  design-review resume also starts a new round when the developer tip changed. A running
  planning session is marked for restart too; its current turn finishes before the review starts.
  Its local branches remain intact. `REVIEW_DUTIES`, stage hand-over pins and the RPC contracts
  stay unchanged. The design review runs on the engine beside the other member workspaces;
  no path is read on the hub and no new machine assumption is introduced.
  **A fresh base at every start (PM-740):** a member workspace has no remote, so its default
  branch goes stale unless the server fetches it. `MemberWorkspaces.prepare` calls
  `MemberWorkspaceManager.fetchBase` (RPC `workspace.fetchBase`, unchanged) once per session
  preparation, after the reservation and `ensure` and before any checkout: for new and continued
  developer sessions and for new and continued reviews. A failed fetch is `workspace_fetch_failed`
  and the session does not start (the reservation is released). The fetch moves only
  `refs/remotes/upstream/<default>` (forced, so it shows the fetch result) and fast-forwards the
  member's own default branch when it is not checked out and does not diverge (a divergence is
  logged, never overwritten); the task branch, its files and the binding's `baseCommit` or review
  pins of a continued round stay as they are, and a new task or review round pins the commit
  fetched for that start. A reviewer's valid action message to the assignee's running session is
  preceded by `SessionOrchestrator.refreshWorkspaceBase(config, task, member)` (from
  `runtime/delivery`), the same fetch without a start or checkout; when it fails the message stays
  waiting and is retried. **Does this work on a remote engine?** Yes: the fetch runs on the engine
  that holds the workspace and the repository; only the existing RPC crosses the link.
  Since PM-311 the worktrees are `EngineHost.worktrees` (and `memberWorkspaces`) of the session's or
  card's engine, and the project's directory is `EngineHost.workspacePath` (`contracts/engine.ts`).
  PM-741 adds a read-only consumer of the engine's `_merge-deps/<sha256(JSON [project,repo])>/current`
  store: member dependency preparation copies a complete matching generation under the same heavy
  lock, replacing only validated package trees. Member installations never publish into this store.
  PM-797: the close of a collecting card with no code of its own reads no worktree or source commit; it decides on
  the hub's data (`TaskRepository.sourceEvidence`), so a missing or offline engine does not hold it back.
  **Cloud mode (PM-315):** the worktrees are the engine's (`worktree.*`, `workspace.*`). The local worktree manager object still exists, unused, because `DomainOptions.worktrees`
  is required.
  **Module:** `worktree`
- **Free-disk admission guard** — `runtime/watchers` (`DiskGuard`, engine `freeDiskBytes`),
  `runtime/admission` (`Admission`) (PM-243). `statfs(PROJECTMAN_HOME)` supplies the local free-space
  value for `minFreeDiskGb`; a low value defers new sessions. With a work root (PM-846) the engine
  reports the smaller of the home's and the worktrees volume's free space. It does not measure other
  hosts or even every local worktree volume. **Remote engine (engine mode, PM-314: runs in the engine process):** use `host.free_disk` (PM-313), report capacity for the
  engine's execution/storage volumes and plan admission against those as well as server
  storage; keep unavailable measurements distinct from low capacity.
  Since PM-311 `DiskGuard` asks the target engine's `EngineHost.freeDiskBytes` (`contracts/engine.ts`);
  since PM-312 the `statfs` itself is `freeBytesOf` in `engine-host/disk.ts`, not in `domain/`.
  **Cloud mode (PM-315):** the engine directory answers with `host.free_disk` of the target engine.
  PM-1059 keeps the target: the member's (or the session's) engine that admission already resolved, with
  no host fallback; no new machine operation.
  **Module:** `runtime/watchers`
- **Control socket, pause and deployment** — `control/socket.ts`, `runtime/sessions` (`PauseService`),
  `scripts/control/{client,cli}.ts`, `scripts/migrate/instance.ts` (PM-219, PM-143).
  `PROJECTMAN_HOME/control.sock` is a local Unix socket (0600), authorised by filesystem
  access. Pause and shutdown act through the local runner; activation checks local instance
  markers and database use. Deployment scripts using the control client need access to that
  host's socket (see [DEPLOY.md](DEPLOY.md)); the client is not a remote engine API. The socket's system-wide
  pause right is unchanged; the app's instance pause (`POST /api/pause`) is the host owner's (PM-1058).
  Release flow (PM-491, `services/releases/releases.ts`, `PROJECTMAN_RELEASE_TARGET`): the release watcher reads, claims and
  reports on this same local socket, so it must run on the server's host; the instance's repository is on
  the engine of the target project, and only `BranchMerger.isAncestor/prepare` cross the engine link
  (see "Release of the instance"); no new boundary.
  `publish_release` (PM-968, `services/releases/publications.ts`; the durable row is `release_publications`):
  the tag is made and pushed on the engine that holds the repository (`merge.remote_tags` lists the tags of the base's
  upstream, `merge.push_tag` makes an annotated tag on a commit and pushes it, never forced, `--no-verify`; checked in
  `engine-limit.ts` like `merge.push`), and the GitHub release on the `github.*` engine (`github.publish_release`:
  `gh release view`, then `gh release create --verify-tag`, the owner's gh login; `engine-limit.ts` binds no
  repository for it, like the other `github.*` calls). Only the commit, the tag name, the notes and the URL cross the
  boundary; an engine from before PM-968 answers `unknown_method`, which the publication reports as
  `release_publish_failed`. The engine of the call is `engines.engineFor(projectKey, member)`, local when there is none.
  PM-1059: the GitHub release goes through the project-aware `GithubService.publishRelease(projectKey, ...)`,
  which the cloud sends to `projectEngine(projectKey)`; the `github.*` RPC and its parameters are unchanged.
  **Hybrid deployment (PM-752):** with `PROJECTMAN_RELEASE_ENGINE_ID` and `PROJECTMAN_RELEASE_TARGET_HASH` the
  cloud server keeps the durable deployment attempt (`release_deployments`, `services/releases/deployments.ts`)
  and the maintenance fence (`ReleaseWorkGate`), and the `release_deploy_*` ops read and change them over this
  same socket. The server checks the second target (the engine's id, online state and version) from its own
  engine registry, never from the caller's word; the switch of the engine's program itself crosses the
  server/engine boundary in PM-751, not here. The pause the attempt owns is an ordinary instance pause row.
  **Cloud admin channel (PM-749):** on the cloud machine the same socket is reached through
  `npm run cloud -- release-control` (`scripts/cloud/release-control.ts`): one request line on the Mac's standard
  input, the verified SSH/SSM host session, `host.sh release-control`, then the fixed `docker exec -i -u 10001:10001
projectman-cloud /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 /usr/local/bin/node
/app/apps/server/dist/control/cli.js /data/control.sock` (`control/cli.ts`, built by
  `apps/server/scripts/build.mjs`), and one response line back (PM-754: `env -i` clears the environment `docker exec`
  inherits from the container before Node starts; the relay gets exactly those two values). Assumes the Docker
  container name, the data uid/gid, the `/usr/bin/env` and `/usr/local/bin/node` binaries of the official
  Node-based cloud image and the `/data/control.sock` path; the control socket is never published or mounted
  ([SECURITY.md](SECURITY.md) "The control socket and the admin channel"). A remote
  engine needs nothing of it: the socket is the cloud server's, and `engine_status` only reports the engine
  registry. The request is sent once; a lost answer is reconciled with `release_get`.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `session.pause/force_pause/release/stop` (PM-313), keep the administrative socket local, propagate pause/stop to engines
  with acknowledgements and reconnect handling, and require the existing human deployment
  decision before activation; local process exit is not proof that remote work stopped.
  **Cloud container (PM-317):** the container has no pause script (since PM-749 only the packaged relay
  `control/cli.js` of the admin channel above reaches its socket, and only through `docker exec`);
  the platform stops it with SIGTERM, which the entrypoint forwards to the server (its own
  shutdown pause and stop) before Litestream ships the last writes and the process ends. A
  deployment is replacing the container; the restored or rehearsed copy is a `standby` home
  (`instance.json`) that starts no session, and only one container may replicate into a replica.
  (PM-318: `instance activate` from the `engine` role, the way back to the single-machine mode, also
  needs the person's statement that the cloud is retired, no running engine and a database that
  holds the cloud's `engines` row, so that a stale pre-hybrid database never replaces the cloud's work;
  `--discard-cloud-data` states the opposite on purpose.)
  **Module:** `control`
- **Native sandbox and canonical paths** — `runtime/sessions` (`session policy`),
  `engine-host/{disk,within,work-roots}.ts`, `runner/providers/claude/args.ts`, `worktree/paths.ts`, `index.ts`
  (PM-846: a work root is used by its real path and lies inside the real home, so the `denyRead` of the
  home keeps the other members' worktrees unreadable; the engine limit's session roots name
  `<workRoot>/worktrees` and `<workRoot>/workspaces`)
  (PM-87, PM-333, PM-355, PM-312, PM-425; the canonical-path and directory checks of the domain are the
  engine's `realpath`, `isDirectory`, `isRealDirectory`). `runtime/sessions/permission-broker.ts` (PM-960)
  uses `EngineHost.realpath` to validate the tool's working directory and uses the runtime's
  policy functions directly; path validation still
  runs on the session's engine and requires no new RPC.
  PM-691 fixes the Operator's effective approver to `human` on the server through
  `packages/shared/src/config/permission-level.ts`, including historical session overrides.
  `runtime/sessions/{sessions,launch}.ts` checks updates and carries the effective member into
  the existing start/context path; `runtime/sessions/permission-broker.ts` uses it for human routing. Local and remote
  engines consume the same start intent. This changes no OS assumption or RPC and never
  turns a CLI escalation into boundary authorization.
  Legacy Claude execution uses the CLI's native sandbox (macOS Seatbelt); allow/deny paths
  are local and canonicalised, including `/var` → `/private/var` and real temporary paths.
  The member's "Outbound network" setting (PM-355) becomes `SessionPolicy.network.outbound`; a
  Claude member with it on gets the sandbox network allowlist `*` minus the blocked hosts, with it
  off only the npm registry.
  Codex has its own permission mapping in `runner/providers/codex/args.ts`: local sessions
  receive an inline `projectman` profile extending `:read-only`, with `sensitivePaths` and
  the adapter's Codex home denied (PM-356).
  PM-360 adds the shared `SessionReadBoundary` schema and optional
  `AgentSandbox.portable.readBoundary` to the strict `session.start` contract. Under the owner's
  2026-10-26 scope decision, developer runtime paths do not automatically populate it:
  absent means the existing broad non-sensitive home reads and session/tmp behavior.
  Claude's existing `worktreeSandbox` read/write rules remain unchanged. Explicit boundaries
  contain reopenable roots and typed file/directory exceptions, separate from unconditional
  policy/adapter denials. Local adapters resolve lexical/physical paths and reject invalid
  explicit inputs using the shared `runner/tool-decision.ts` matcher (exported through
  `runner/index.ts` for the engine): glob component boundaries, case handling and macOS
  `/System/Volumes/Data` firmlink aliases have one implementation. The engine
  (`engine-link/engine-limit.ts`) adds its own homes/temp roots and checks
  exceptions and required private directories only when a boundary is supplied. Existing
  engine-root, permission-mode, environment and sensitive-path checks always apply.
  PM-425 populates it for every reading session (`placementReadsOnly`: a `read_only` placement,
  a review copy without the test permission, a taskless chat, the non-super Operator) and for
  every provider: `sessionSandbox` (`runtime/sessions/session-policy.ts`, `readerReadBoundary`)
  builds one list; `launch.ts` copies it into `policy.filesystem.readBoundary` (new optional
  field, `SessionPolicy.version` stays 1) and `withReaderDenials` adds `~/.claude/projects` to the
  reader's `deniedPaths`. Rendered from it: Claude's `denyRead`/`allowRead` and file-tool rules
  (`claudeToolRules` drops the blanket `Read`/`Grep`/`Glob` allow), the PreToolUse refusal and
  `permissionRequest()` in `runner/session.ts` (`readBoundaryVerdict` in `runner/tool-decision.ts`),
  Gemini's `decideToolCall` and the Codex/NanoGPT profile. `engine-limit` validates and
  canonicalises the boundary for all providers and replaces the policy's copy with its own.
  **Remote engine:** `paths()` supplies the executing engine's roots; only the optional,
  validated portable contract crosses the boundary, never authentication files. This uses
  the same policy locally and remotely and introduces no new mode or switch. A cloud hub
  does not isolate an engine's disk; OS-user/VM/container and tenant isolation are separate
  requirements. Explicit boundaries need their own OS/provider native probe when enabled
  (`docs/SANDBOX-PROBE.md`); prior PM-356 evidence does not certify them. Approved host commands
  and the parent CLI remain outside this boundary. PM-425 owns the reader's policy and rollout.
  Writing sessions retain workspace protections
  and the roots of `AgentSandbox.portable` (the member's npm cache and development data,
  the queue's parent, the session folder and
  the own tmp, PM-339). With an own tmp, no shared `/tmp` or CLI `$TMPDIR` write is inherited.
  Task worktrees also grant the shared git `objects`, `refs`, `logs` and their own admin
  directory (PM-399), plus only `packed-refs.lock` (PM-411), so Codex
  can finish rebase pseudo-ref deletion and loose branch deletion. The common git directory as a whole, other
  worktrees' metadata, configuration, hooks, alternates and admin links remain read-only.
  PM-731 (engine limit, `engine-link/engine-limit.ts`): the engine's read candidates are its
  write candidates plus the user's own files from `SANDBOX_HOME_READS` (`.gitconfig`,
  `.config/git`, `.claude/shell-snapshots`, `contracts/engine.ts`) and the existing regular
  `core.excludesfile` of its own `userHome`; they are never write candidates, and one whose real
  path is, or holds, a sensitive place is dropped. The `db.sqlite*` pattern of the denials, the
  cloud's and the engine's own, becomes the four file names (a file tool's rule is a path, not a
  pattern); other wildcard entries stay as sent. A member workspace (an independent clone: a
  `task_worktree` with `placement.workspace` and no shared `gitDir`) lets a writing Codex session
  write its own `.git`, with `config`, `config.lock`, `config.worktree`, `commondir`, `gitdir`,
  `hooks`, `modules` and `objects/info` read-only (the links and submodule directories would
  redirect the host's git to a path the session wrote); a read-only sandbox or a placement without that marker gets nothing.
  The Codex adapter lifts only the lock entry from `sharedGitDenials`; `packed-refs` itself
  stays read-only, as do packed default-branch and replacement refs. Claude's denials remain.
  A packed branch deletion that needs a packed-refs rewrite is not granted. Residual risks:
  a leftover lock can block host ref deletions, and lock replacement during a host packed-refs
  rewrite can inject content into that rewrite. The owner accepted these two risks on PM-411
  on 2026-10-08, conditional on the mitigation follow-up PM-413; see SECURITY.md for the separate, still
  unverified hard-link probe required before release.
  This file-path exception relies on macOS Seatbelt enforcement. A Linux engine may keep a
  nonexistent lock path closed; verify provider grants on that engine before claiming rebase
  support. The hard-link probe must fail at link creation, without writing through the link.
  PM-356 adds local startup checks in `runner/runner.ts` and `runner/ambient-config.ts`:
  a numeric CLI minimum and refusal of loaded sandbox/profile configuration, reporting only
  setting names through `codex_setup_incomplete`. User MCP names are resolved beside the CLI;
  ambiguous names refuse startup. `runner/providers/codex/args.ts` disables each user server
  and the eight plugin/app/computer/browser features for every Codex provider. The native
  Codex 0.159.1 probe on macOS 14.6 arm64 is recorded on PM-356 (2026-10-06): glob and
  symlink denials work, `:workspace` and shell-snapshot overrides are unnecessary.
  `runner/cli.ts` resolves the real executable on the session PATH; the profile reopens
  only its `packages/standalone` installation ancestor read-only beneath a denied path,
  provided that ancestor contains no denied path. Unknown layouts stay closed.
  macOS MDM-managed Codex preferences are not inspected yet (PM-375).
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `session.start`, `session.assert_workspace_config` and `host.*` (PM-313), build the policy from its filesystem and supported OS/provider
  enforcement, preserve protected paths and fail closed where required; do not copy Mac
  path grants or infer Codex permissions from Claude syntax. The outbound network intent
  (`SessionPolicy.network.outbound`) is abstract: the remote engine enforces it with its own
  tools (sandbox, firewall, proxy) and keeps the blocked hosts closed.
  For PM-399/PM-411, resolve the common git directory and the task's own admin directory
  on the engine hosting the worktree, and render these narrow grants there. The existing
  placement paths must describe that engine's filesystem; no new server/engine contract
  is introduced by PM-411.
  Version/config inspection must run on the engine hosting the CLI, against that engine's
  filesystem, PATH, user home and administrator/workspace configuration, including executable
  symlink resolution and installation grants. Only sanitized setting names and
  structured setup errors cross back to the server; host-side inspection is not a substitute.
  Since PM-311 the paths the policy is built from are the session's engine's `EnginePaths`
  (`userHome`, `home`, `worktreesRoot`, `workspacesRoot`, `installDir`, `gitExcludesFile`;
  `contracts/engine.ts`).
  **Module:** `runtime/sessions`
- **CLI token and plan usage** — `runner/providers/claude/{usage,plan-usage}.ts`,
  `runner/providers/codex/{transcript,plan-usage}.ts` (`CodexTranscriptParser`),
  `runner/session.ts`, `runtime/usage` (`PlanUsageMonitor`) (PM-341; PM-286, PM-310).
  See **NanoGPT Codex home and key delivery** (PM-329): token usage is parsed as Codex,
  but NanoGPT rollouts never feed the ChatGPT plan gauge. PM-1068: NanoGPT usage is billed to the key the
  session was started with, i.e. the engine owner's own key when the engine has one.
  Token counts come from the running CLI's transcript/hook data. Claude plan usage probes
  the locally logged-in CLI without a conversation; Codex reads local rollout rate-limit
  events. These observe the local account, not an arbitrary remote sponsor.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `usage.plan` and `provider.status` (PM-313), obtain usage where that sponsor's CLI is logged in and send attributed,
  timestamped measurements; leave credentials there and retain subscription-only execution.
  **Cloud mode (PM-315):** `createRemotePlanUsage` (`engine-link/remote/transcripts.ts`) asks the engine
  (`usage.plan`, `provider.status`); the cloud keeps only the measurements, with the engine that sent them.
  PM-1059: `usage.plan` is asked of one named engine; the monitor and the cache key a value by
  `(engine, provider)` and a board reads the project's representative engine (see "Cloud composition").
  PM-1091: the NanoGPT quota and rate hold (`ProviderQuotaHolds`, in memory on the hub) is per key: the
  cloud's key is `'host'`, an engine with its own key file is held under its engine id
  (`EngineDirectory.nanogptKeyHolder`). Only a `usage.plan` measurement on the engine that owns the key
  lifts or moves its hold, so a friend's limit does not stop the host's members and the reverse.
  **Module:** `runtime/usage`
- **Claude workspace trust** — `runner/providers/claude/trust.ts` (PM-341).
  The runner updates workspace trust in `~/.claude.json` (or the configured Claude config directory).
  **Remote engine (engine mode, PM-314: runs in the engine process):** trust is part of `session.start` (PM-313); prepare trust on the engine as the executing account, for the actual
  canonical checkout path; changing the server account's trust cannot unblock a remote CLI.
  **Module:** `runner`
- **Server full test before review** — PM-909: with `reviewTest.beforeReview: github_actions` the run is not
  local: no sandbox, `srt` or local checkout; see "GitHub Actions merge check" for its machine assumptions and
  for the remote engine (the run needs only an engine with a full test executor and `gh`). `services/full-tests/full-tests.ts`, `engine-host/disk.ts`
  (`resolveGitDir`: the checkout's real `.git`, asked of the engine), PM-846: with a work root the
  executor gets only `worktreesRoot`; the `pmft-*` run directories stay in `os.tmpdir()`, outside the home (PM-848),
  `full-test/{index,sandbox,run-sandboxed,run-sandboxed-core}.ts` (PM-217, PM-336, PM-312; PM-351 shares the spawn with the
  screenshot runs). The executor runs the pinned checkout on the server host, using local
  git metadata, a short temporary run directory, process-group signals and macOS `srt`;
  it is unavailable without macOS/`srt`. PM-847: the run directory is a byte-measured, canonical path
  (`canonicalRoot`, `runDirOf`: at least 40 bytes below its `tmp` and `home` within 100; else
  `/private/tmp/pmft-*`; else `sandbox_unavailable`), and the sandbox may bind and connect Unix sockets
  below the run's own `sandbox/tmp` only (`allowUnixSockets`, `allowAllUnixSockets: false`); the installer
  and screenshot profiles have none. The engine that creates the sandbox is the installed one, so this
  takes effect there only after a separately approved engine update. Remote engine: all of it is the
  engine's own private run root; the cloud receives only the existing full-test result.
  Timeout and cancellation retain the detached process group's cleanup scope through the TERM
  grace period, then send SIGKILL to the negative group id even if the launcher has already
  closed its output pipes (PM-829, `full-test/run-sandboxed-core.ts`). The engine owns these
  POSIX signals and waits for escalation before returning the result or releasing the heavy lock;
  remote engines use the same engine-local cleanup, with no new data crossing `full_test.run/cancel`.
  The group leader is an inline plain-Node watchdog (`full-test/process-group-guard.ts`), outside
  the sandbox. It starts `nice srt ...` without detaching again. An engine-owned stdin pipe stays
  open for the run; EOF on engine death (including SIGKILL or restart) triggers group SIGTERM
  and then SIGKILL after the grace period, independently of engine finalizers. The watchdog
  ignores SIGTERM itself so it can kill TERM-resistant workers even after the launcher exits.
  Normal command exit codes and signals are relayed to the engine. This assumes POSIX groups
  and pipe EOF on process death; all watchdog and sandbox processes stay on the executing engine.
  PM-754: with that permission the control socket integration tests (`control-relay` and `control-socket`,
  `*.integration.test.ts`, test paths checked in bytes by `test/helpers/socket-path.ts`) run in the merge check and
  prove the real socket boundary; Linux has no equivalent guarantee and no fallback. `npm run merge-test` exits 2
  for any scope that runs the server's tests when `PROJECTMAN_SKIP_PTY_TESTS=1` is set (the members' sandbox signal,
  which `fullTestEnv` never passes), and its cloud scope names the two integration files.
  Its sandbox (`fullTestSandbox`, `closedTmpRoots`; PM-353) denies reading Claude Code's shared temporary roots
  and the session tmp root's parent: other sessions' and projects' command outputs lie there.
  **Remote engine (engine mode, PM-314: runs in the engine process):** use `full_test.run/cancel` (PM-313), plan where the pinned commit and dependencies are tested, equivalent
  isolation and resource queuing there, and transport of the attributed verdict/cancellation.
  An unavailable executor must not become a passing verdict.
  Since PM-311 the executor is the `EngineHost.fullTestExecutor` of the card's engine, with that
  engine's `EnginePaths` (`userHome`, `home`, `claudeTmpRoots` and the `sessionTmpRoot` parent as `closedTmpRoots`).
  **Cloud mode (PM-315):** the executor of an engine is a remote one (`full_test.run/cancel`) that is
  available only while the engine is; without it a run is refused with `engine_offline`
  (`FullTestErrorReason`), never a passing verdict. `index.ts` builds no local executor in cloud mode.
  **Dependency preparation (PM-709, PM-710):** optional `FullTestSpec.npmCi` prepares dependencies under
  the required heavy lock before the test. `full-test/npm-ci.ts` and `assertNpmCiCheckout` bind it to a real,
  canonical `<worktreesRoot>/_merge/<mergeId>` checkout. The engine limit additionally checks the registered,
  merge-enabled repository and its exact full-test command. Both app factories receive their engine-local
  `<home>/worktrees`; an absent root refuses preparation. The card merge (`services/merges/steps.ts`,
  PM-711) is the only caller: it sends `npmCi` when the check checkout answered
  `dependencyInstallRequired`. Review, other full-test and screenshot callers never send it. Over the link
  an older engine's strict schema refuses `merge.checkout_for_check`'s switch (the merge blocks with
  `check_error` and an "update the engine" message, without a retry) or the spec's `npmCi` (the result is
  `dependency_install_failed` with the same message). When `full_test.run` times out, the cloud
  sends `full_test.cancel` with the run id and ends the run as `error` / `timeout` (`killed` when the merge
  was cancelled); a lost link stays `engine_offline`. No installation is left running unattended.
  A separate installer settings file allows only root/local workspace `node_modules` writes and the run's
  own home/tmp/npm cache; source, lock/manifests and git metadata remain read-only. Linked input files,
  workspace parents, package targets and tracked package paths are refused. The fixed `npm ci` command
  refuses any root `.npmrc` or `npm-shrinkwrap.json` entry, including links or directories, at every input
  read: neither may override the lock/configuration identified by the shared dependency key.
  Every input read also refuses local `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`,
  `prepare`, `postprepare` or `dependencies` scripts and any `binding.gyp` entry in the root or a lock-listed
  workspace, preventing unkeyed source from affecting the shared installation; external dependency scripts still run.
  Its tracked-path probe emits fixed NUL-terminated records so diagnostics cannot masquerade as paths. It
  includes dev/optional packages and lifecycle scripts, uses two distinct empty npm config files and an
  environment allowlist, and permits only registry.npmjs.org and nodejs.org, without local binding.
  The test retains its original settings and no outward network. Private registries, other lifecycle
  download hosts, source-writing scripts and missing toolchains fail preparation without expanding access.
  `full-test/npm-dependency-key.ts` hashes complete lock/root/workspace manifest bytes and engine OS/arch/Node/npm.
  The supervisor stores the latest installation at
  `<worktreesRoot>/_merge-deps/<sha256(JSON.stringify([projectKey,repo]))>/current/`, outside git worktrees.
  A strict version-1 `ready.json` contains the key and copied relative package paths; every listed directory
  and the root hidden npm lock must be real. Invalid or missing metadata is a miss; linked store roots
  are refused. The installer cannot write the store. After a successful install, unchanged inputs and a
  complete staging copy, the supervisor writes a 0600 marker in a 0700 generation and publishes it by rename,
  removing the old generation under the same lock. A hit copies into the new checkout without `npm ci`.
  Filesystem, changed-input and npm errors return `error/dependency_install_failed`, no failed files and
  the npm exit code (null for filesystem errors); sandbox/spawn/timeout/killed/queue errors keep their reasons.
  Probes, installation, copies and test share the post-wait time budget. Cancellation settles the child
  before cleanup and lock release. These operations all run on the macOS/srt engine; only the existing
  `full_test.run/cancel` request/result crosses the boundary, with no new config/env/RPC/database shape.
  `engine-link/remote/host.ts` maps older-engine `invalid_params` to the preparation error without retrying
  a weakened request. No Linux sandbox support is added.
  In GitHub mode (`FullTestSpec.githubActions`, PM-900) the sandbox does not run: the engine's
  `withGithubActions` executor takes the request (see "GitHub Actions merge check").
  **Module:** `services/full-tests`
- **Merge-test file watchdog (PM-1054)** — `scripts/merge-test/{npm,reporter}.ts`.
  Every test invocation, including reruns, uses the default and hanging-process reporters plus
  controller-side start/end events for each file (from collection through teardown). The npm
  supervisor gives each active file 180 seconds, with 20-second test and hook defaults. On a
  file deadline it prints all active file names as `FAIL` lines and stops the command through
  the existing `scripts/lib/child-guard.mjs`; exit 1 and an unhandled-error diagnostic prevent
  the flaky-file rerun rule from hiding the timeout. **Machine assumption:** POSIX process
  groups, already required by the child guard, stop even synchronously blocked workers and
  clean up descendants when the supervisor dies. **Remote engine:** the supervisor and guard
  run where the tests execute (GitHub Actions or the engine); only existing output and verdict
  data cross the boundary. No new server/engine contract.
- **Merge-test step cache (PM-845, PM-841)** — `scripts/merge-test/{steps,run}.ts`,
  `full-test/{index,sandbox,step-cache}.ts`, `app.ts`, `engine-app.ts` and `index.ts`.
  The executor stores passed command keys in the engine-local
  `<app home>/cache/merge-test-steps.json`, outside the sandbox, and exposes only a disposable key list
  in the run's sandbox directory. It assumes a writable app home on the executing machine;
  an unavailable or invalid cache only disables reuse. The cache stays in app home even with a
  separate work root. **Remote engine:** the remote engine uses its own home and performs the same
  reads, expiry, bounded merge and atomic writes; no cache data crosses the server/engine boundary.
  `FullTestSpec`, `FullTestResult` and engine-link schemas are unchanged.
  **Module:** `full-test`
- **Merge check measurements (PM-876)** — `scripts/merge-test/{steps,run}.ts`, `full-test/index.ts`,
  `engine-link/{methods,engine-handlers}.ts`, `engine-link/remote/host.ts`,
  `services/merges/check-runs.ts`, `db/merge-check-runs.ts` (migration 92), `mcp/merges`.
  The merge-test script, running in the executing machine's sandbox, prints one timing line per step
  and the worker count it saw (`VITEST_MAX_FORKS`); the executor on that same machine parses its own
  output into a bounded `MergeTestReport` (scope kind, workers, step timings; at most 64 steps). The hub
  records every merge check (a card's merge, a train's group check, a member's diagnosis) in
  `merge_check_runs` with the `maxWorkers` it passed, the queue wait and the report. **Machine
  assumption:** none new; the clock is the executing machine's `Date.now()`. **Remote engine:** yes, it works:
  the measurement stays on the engine, the full output never leaves it, and only the bounded report
  crosses, in the separate `full_test.report` call (the `run`/`attach` schemas are unchanged). An older
  engine answers `unknown_method`, so its checks show unknown steps. Related task: PM-876.
  **Module:** `full-test`, `engine-link`, `services/merges`
- **GitHub Actions merge check (PM-900, PM-907)** — `full-test/{github-actions,github-verdict}.ts`
  (`withGithubActions`), `engine-host/check-branch.ts` (`createCheckBranchGit`),
  `services/github/actions.ts` (`createGithubActionsClient`), wired in `assembly.ts` (single machine) and
  `engine-app.ts` (engine process), and the repository's `.github/workflows/merge-check.yml`. For a
  `full_test.run` that carries `githubActions`, the engine pushes the merge commit to a check branch
  `pm-check/<time36>/<runId>` of the base's upstream remote (never forced), dispatches the workflow with
  the inputs `check_id` and `files` (PM-909: or `all`, for the review test, with a four-shard scope check), follows the run (`gh api`), and builds the `FullTestResult` from the
  jobs' conclusions and logs (the `merge-test` marker lines and timing report the local run prints).
  A timeout or an abort cancels the run; the check branch is deleted at every end, and a run sweeps a few
  check branches older than two hours. **Machine assumptions:** `gh` installed and logged in on the executing
  machine with the right to run workflows of the repository (`repos[].github`); the base's upstream remote
  is that repository on github.com and `git push` works to it unprompted; outbound HTTPS to GitHub. The
  tests do not run on the machine: no macOS, no `srt`, no heavy-run queue, no step cache.
  The `macos-15` workflow installs Homebrew Bash and puts its `bin` on `GITHUB_PATH` before the
  tests: cloud scripts require Bash 5 (`local -n` is unavailable in the runner's `/bin/bash` 3.2).
  CI stays on Node 22, also used by the cloud image; migration copies restore directory permissions
  explicitly to handle its `cpSync` regression (nodejs/node#65488, PM-923). **Remote engine:**
  the same on the engine's machine with its own `gh` login and remote; the server sends only the existing
  `full_test.run` request and receives the result (the run page in `externalUrl`); nothing else crosses.
  PM-1059 does not touch this check: it keeps running on the engine the card's merge already uses, and the
  engine-side `gh` client keeps its project-less `MachineGithubService` contract.
  PM-909: the review test before review uses the same path (`all: true`, `engine-link/methods.ts` accepts the
  optional field; an engine older than PM-909 refuses it with `invalid_params`, shown as `github_unavailable`).
  The server side (`FullTestRuns`) needs only an engine with a full test executor, not a sandbox.
  Real dependency-clone integration tests (`worktree/{worktree-manager,dependencies}.test.ts`)
  use `test/helpers/apfs.ts` to check that the test temp volume is APFS, rather than assuming
  every macOS temp volume supports cloning (PM-928). The injected dependency-clone unit tests
  still run on other filesystems; clone failures on APFS remain failures. The process-group
  timeout tests leave 5 s for the Node guard and shell to start on slower CI hosts; the
  TERM-resistant case checks its readiness output and retains the grace-period KILL assertion
  (PM-947). The background-grandchild cleanup test in `full-test/run-sandboxed-core.test.ts`
  polls for POSIX `ESRCH` every 50 ms for up to 5 s, allowing asynchronous reaping on loaded
  hosts (PM-948). After run completion the executor re-reads empty or nonterminal shard job states
  for up to 120 s, bounded by the original check deadline, before reporting a missing verdict;
  cancellation still stops the wait. This uses the existing engine-local GitHub client without
  a new dispatch or server/engine contract. The `runner/cli.test.ts` output-preservation timeout test gives Node startup
  and initial pipe writes 5 s; `test/permission-delegation.integration.test.ts` polls each fake-CLI
  phase for up to 30 s within a 150 s test budget (PM-936). These are test-host assumptions only;
  remote engines need no new capability or server/engine messages.
  Related tasks: PM-900, PM-906, PM-907, PM-909, PM-923, PM-928, PM-936, PM-947, PM-948.
  **Module:** `full-test`, `engine-host`, `services/github`
- **Merge conflict fix worktrees** — `services/merges/`, `runtime/sessions` (`SessionOrchestrator`, `SessionLauncher` in `launch.ts`), `runtime/watchers` (`WorktreeSweep`),
  `worktree/worktree-manager.ts`, `runtime/sessions` (`session policy`), `engine-link` (PM-471).
  The nominated merger receives a separate writable `merge-fix/<KEY>` checkout, even without
  a file-changing duty, only while the card is `fixing`. Placement changes when its session
  restarts after the turn. The checkout starts at the approved commit; the merger merges the
  recorded conflict base, resolves mechanical conflicts, commits, and submits a resolution note.
  Git cleanliness and ancestry are checked on the card's engine before queuing the fix head.
  Human mergers use the same checkout (PM-481), editing directly on the card's engine machine.
  `fix.path` is an absolute path on that engine; remote use requires the human to have filesystem
  access to its machine, which projectman does not provide. The existing checkout metadata
  carries this path across the server/engine boundary.
  Assumptions: git and writable worktree storage on that engine, shared git metadata there.
  **Remote engine:** checkout creation, head/status/ancestry reads and cleanup run on the card's
  engine through the worktree and merge contracts; only checkout metadata, commit ids and the
  resolution note cross the boundary. A merger assigned to another engine is refused. The
  server stores the fix state and resolution attribution; it never edits conflict files.
  Both task worktree and member workspace modes use this checkout (PM-794). In member workspace
  mode the approved commit is first published as a snapshot from the developer's clone into the
  engine's project repository; the submitted fix head already lives there and is not published
  from the developer's clone, including when a newer base causes another conflict-fix round.
  Placement remains `task_worktree` with `mergeFix.branch`, without
  reserving the merger's member workspace. `MemberWorkspaces.check` bypasses clone admission for
  the nominated fixer, and `roundDue` ignores sessions outside member workspaces, so a pending
  review refresh cannot restart a fix session. On restart the old process scope's cleanup releases
  its clone reservation. Shared git protections also deny session writes to `refs/projectman`,
  including the server-managed workspace snapshot refs, in both Claude and Codex sandboxes.
  The server's shared
  `kernel` (`MergeCardLock`) lock serializes fix creation, session placement and cleanup;
  cleanup rechecks open merge rows and live fix sessions immediately before the engine call.
  Orphaned fix branches and registered checkouts (including dirty or detached ones) are swept
  at startup and periodically. The engine revalidates the canonical fix path under its
  repository mutex, refuses symlinks and leaves unregistered directories in place.
  **Module:** `services/merges`

- **Member initiated merge (`merge.*`)** — `contracts/engine.ts` (`BranchMerger`, `EngineHost.merger`),
  `engine-host/{branch-merger,merge-check,doc-files,merge-repo,git-output,merge-git,merge-input}.ts`,
  `engine-link/{methods,engine-handlers,engine-limit,engine-config}.ts`,
  `engine-link/remote/host.ts`, `engine-host/local-engine.ts` (`repoPath`), `services/merges/`
  (PM-451 and PM-452, parts 1/5 and 3/5 of PM-448). The gate queries the card's engine too;
  the server keeps the queue and member authorization, and never receives git credentials.
  PM-797: a collecting card with no code of its own, whose subtasks are all closed, skips the gate on the hub's
  own data (`TaskRepository.sourceEvidence`, "Collecting card closes with its parts"), so its close makes no
  engine call and adds no machine assumption; a card with a trace of a source keeps the gate.
  PM-818 keeps that evidence rule. The normal gate can find no engine source for an unassigned card
  without a work binding or a source session when the hub has no registered LOCAL engine; it then needs no source RPC.
  Recorded handovers and review pins retain precedence, and a previous developer workspace is read
  on its member's engine, with offline reads still refused.
  PM-1059: the merge queue's pull-request reads (`services/merges/{steps,train}.ts`) name the card's project
  and go to that project's engine; git and the checks stay on the engine the merge already used, no new RPC.
  PM-791 adds `services/merges/engine-wait.ts` and reconnect loops in `steps.ts` and `train.ts`:
  the cloud holds the repository slot for up to 15 minutes per lost link and resumes through
  prepare/publication recovery. Persistent or repeated loss becomes `engine_offline`. Remote
  git and checks remain engine-local; only calls, run ids, results and link readiness cross the boundary.
  The member-workspace source handover (`runtime/sessions/workspaces.ts` `prepareMergeSource`)
  preserves link-loss errors for these loops; ordinary session preparation keeps its domain error mapping.
  Structure map reads (PM-682, PM-683) reuse this boundary: `services/structure/index.ts`
  invokes `listPaths`, `readFile` and `changedPaths`. Git and repository registration stay
  on the selected engine; remote engines return bounded file names and descriptor text.
  Merging a card's approved commit into the repository's default branch and sending it up is git work on
  the repository and uses this machine's git login (the owner's). It runs as nine calls — `merge.prepare`
  (fetch of the upstream and the state of the base), `merge.is_ancestor`, `merge.build` (a merge commit made
  with `merge-tree`/`commit-tree`, the branch not moved), `merge.checkout_conflicts`,
  `merge.checkout_for_check` and `merge.release_check` (a detached check checkout under
  `<worktreesRoot>/_merge/<mergeId>`, its `node_modules` copied from an installed checkout with a byte-identical
  merged lockfile, an APFS clone `cp -c` on macOS; PM-580). PM-790 centralizes the checkout path in
  `contracts/engine.ts` (`MERGE_CHECK_DIR`, `mergeCheckPath`). Before recreating or releasing a check
  checkout, `engine-link/engine-handlers.ts` aborts all active full tests whose resolved working
  directories are that checkout or its descendants and awaits executor cleanup, including dependency
  preparation and the heavy-run lock. It then forgets those runs and logs their run/merge ids at info
  level; other merge ids are unaffected. The comparison uses the same engine-local
  `realpath(worktreesRoot)` as checkout creation alongside the configured root, so a symlinked engine
  home matches either test working directory form; relative paths exclude parent traversal at directory
  boundaries. It requires no cloud filesystem access or new machine assumption. The engine tries the bounded preferred source,
  its repository checkout, then repository worktrees under its root outside `_merge`; it rechecks the
  source after copying. Callers that do not request dependency preparation block with `check_error`
  before checks if none matches. Since PM-681
  `checkoutForCheck` takes an optional `allowDependencyInstall` (default false) and may answer
  `dependencyInstallRequired` (missing: false) in the strict `merge.checkout_for_check` schemas (PM-709).
  Standalone merges, train checks and lone-member diagnoses pass `true` through
  `services/merges/check-preparation.ts` (PM-711, PM-897); the engine then answers `dependencyInstallRequired: true`, without
  copying old packages, when the root has a regular non-symlink lockfile and no installed source matches,
  and the shared helper hands the preparation to the executor under the required heavy-run lock
  (see "Server full test before review"). Checkout creation and sandboxed installation run on the
  selected engine through the existing contracts; no new server/engine boundary field is needed. `merge.push`
  (never forced, `--no-verify`), `merge.remote_tags` and `merge.push_tag` (PM-968, the release tag: listed with
  `ls-remote --tags`, made with `tag -a --no-sign` and pushed without force, so a tag the remote has is never moved)
  and `merge.advance` (a
  fast-forward of the local branch, or an `update-ref` with the old value when it is checked out nowhere).
  Every git call is an argument array with no shell, with hooks, signing and the filesystem monitor switched
  off, no terminal prompt and the billing variables removed; the output is scrubbed of credentials. The
  repository is found from the engine's own binding (`engine.json` `repos[].path`, in single-machine mode the
  project's config), never from the call; branch, commit and merge ids are checked in `engine-limit.ts` and
  again in the merger. The pure commit/merge-id and branch syntax rules live in
  `packages/shared/src/domain/merge-input.ts` (PM-659), also used by the server's train storage;
  `engine-host/merge-input.ts` still runs `git check-ref-format --branch` after the shared branch
  syntax check. No git or process crosses into server-side DB validation.
  For a train (PM-660), the server calls the same build operation for every approved source
  and a final first-parent commit, then uses one `_merge/<trainId>` checkout and one strict
  full_test.run. The manifest, ordered locks and attribution stay on the server; all members
  must share an engine and no new RPC or command allowlist entry is required.
  Diagnostic bisection (PM-661), its transactional requeue and parent/size limits stay on the
  server; smaller attempts reuse these same engine operations and the required heavy lock.
  Conflicting train sources use that same server-side requeue with a one-card limit (PM-778);
  individual attempts read current main and retain the full check and review gates. Git and checks
  still run on the selected engine through the existing RPCs, with no new machine assumption.
  Generated files (PM-1050): when `reviewTest.regenerate` names path patterns and command, a standalone
  merge whose conflict is only in files matching them calls `merge.build` again with `regenerate`; the
  engine answers the conflict with a `provisional` merge commit (parents `onto` and the commit) made
  without those files, in a temporary index file in the engine's `os.tmpdir()` (the checkout's index is
  never used). The server runs the configured command in the full test sandbox (`full_test.run`, not
  recorded as a merge check) on a `_merge/<id>` checkout of it that has an id of its own (not the
  merge's), so a process the run leaves behind never reaches the merge check's checkout. Only that run
  may write: its spec carries `regenerate: { ref, mergeId, patterns }` (like `npmCi`), and the engine
  derives the writable directories itself (`regeneratedWriteDirs`: the literal directories before the
  last segment of each pattern; real directories of that canonical checkout, never links; the rest of
  the checkout, its `.git` and `node_modules` stay read-only). A remote engine accepts that spec only
  with the command of the repo's `regenerateCommand` in its `engine.json` (the owner sets it;
  `fullTestCommand` may not run with the descriptor) and only for that repo's `_merge` checkout; without
  `regenerateCommand` the merge falls back to the old `conflict` failure with that detail. A local
  engine uses the server's `reviewTest.regenerate.command`. Then `merge.commit_regenerated` has the
  engine commit the written files: it first `rename`s the writable directories below a fresh
  `.pm-regenerated-*` directory of the checkout (no longer writable there) and reads only from that
  copy: an `lstat` walk, each file through one `O_NOFOLLOW` descriptor and `fstat` (regular, one link,
  at most 1 MB), hashed from the bytes read with `hash-object --no-filters`, never `git add`. Only
  files that are new, changed or deleted against the provisional commit and match the patterns are
  taken (never a `.git*` name, `.husky` or `node_modules`); a change in the directory outside the
  patterns, a link, a flood of files (`too_many`) or a missing conflicting file refuses it. Git does
  not discover the checkout: the worktree git directory is found from the repository and named in
  `GIT_DIR`, and the indexes are temporary files outside the checkout. The merge check checks that
  commit as always. Any other conflict, any refusal and any failure keeps the old `conflict` failure;
  an engine from before the field refuses `regenerate` (`invalid_params`) and the merge fails as
  before. The call count above is nine with `merge.commit_regenerated`.
  Machine-dependent parts: the regeneration run and the commit step run on the card's engine in its
  `_merge` checkouts, with the same sandbox assumptions as the full test (srt/Seatbelt write
  allow-list, `rename` within the checkout filesystem); a remote engine additionally needs
  `regenerateCommand` in its `engine.json`.
  Member workspaces (PM-739): a developer's commit lives only in their remote-less clone, so before the
  first `merge.prepare`, `merge.is_ancestor` or `merge.build` of a standalone merge, a train (also its
  recovery and its candidate selection) and the merge gate, the server calls
  `MergeSessions.prepareMergeSource(config, task, commit)` for every commit involved. It reaches
  `workspace.publishTaskBranch` on the card's engine (see "Task worktrees and shared git storage"),
  which makes the commit readable in the engine's repository as a snapshot ref; a refusal blocks the
  attempt through the usual `merge_error` path, a train candidate that cannot be handed over stays
  out of the train. A task without a developer workspace binding changes nothing.
  No new local machine assumption or server/engine boundary field is introduced.
  **Does this work on a remote engine?** Yes, it is built for it: the git work, the
  check checkouts and the push run on the engine beside the repository and the git login; only ids, paths
  of the changed files and short results cross the link, and a merge to a repo or branch not named by
  `mergeBranch` is refused there whatever the cloud asks. Machine assumptions: `git` on the `PATH`, the
  engine's user's git credentials for the push, and macOS APFS for the cheap dependency copy (a plain copy
  elsewhere). Two more calls serve the Operator's project documents (PM-494, PM-388): `merge.read_file`
  (`cat-file` of one file at a commit, or at the head of the base after the fetch of its upstream; a path
  that fails `isRepoFilePath`, a file over 1 MiB or one that is not UTF-8 text is refused) and
  `merge.commit_files` (a commit on `onto` with one or two files set, built in a temporary index file
  with `hash-object`, `update-index`, `write-tree` and `commit-tree`: no ref, index or working tree is
  touched). The engine limit bounds both like the other `merge.*` calls (the repository must be
  registered with a `mergeBranch`, a `base` must be that branch, 1–2 different paths, 1 MiB of text each
  without NUL, a message that `isMergeMessage` accepts); they run on the engine, so no new
  machine-dependent part is added. The temporary index is a directory under the engine's temp directory.
  PM-1004 uses the same calls for autonomous lessons writes. The hub owns the lessons-only permission,
  session/queue binding, configuration and durable provenance; reads, commits, push and advance stay on the
  Operator's selected engine, including remote engines. Only existing path/text/commit data crosses the link.
  The service rejects a third document path before queueing; no RPC or engine limit changes.
  Two read-only calls serve the structure map (PM-595, PM-682): `merge.list_paths` (`ls-tree -r` of the
  local base head: the tracked file names, sorted, at most 20 000) and `merge.changed_paths` (per item,
  at most 25: a branch tip, a commit or a merge commit, its changed file names against the merge base
  with the local base head, or against the merge's first parent, `diff-tree --no-renames`, at most 1 000
  each; `{ ok: false, reason: 'unknown' }` for what is not known). They do not fetch and only file names
  cross the link, so the largest reply stays near 2 MB, under the 4 MiB frame. The engine limit checks
  the repository and the base like the other `merge.*` calls, each branch with `isBranchName`, and each
  commit or merge id as a commit id. No new machine-dependent part is added (`engine-host/path-reads.ts`).
  **Module:** `services/merges`
- **Disposable instances and migration tools** — `scripts/lib/{instance,ports,processes}.mjs`,
  `scripts/migrate/{inventory,database,git,instance,copy,package}.ts` (PM-270, PM-318, PM-923, PM-1033).
  Disposable instances reserve loopback ports, spawn local server/web process groups and
  use local temp homes; migration inventories local repositories, paths and database use,
  packages only hybrid cloud entries; repositories and their paths stay on the engine host.
  Home copies restore source directory modes after `cpSync`
  (Node 22 can otherwise widen 0700 to 0755); the permission walk uses `lstat` and never follows
  symlinks. This requires POSIX modes on both source and destination. Cross-machine activation already requires a person's
  confirmation that the source is retired. **Remote engine:** execute local probes and
  process management on the target host, inventory engine state separately, and preserve
  explicit source retirement and rollback checks rather than inferring remote liveness.
  **Hybrid move (PM-318, `scripts/migrate/{hybrid,hybrid-entries}.ts`, [HYBRID.md](HYBRID.md)):**
  PM-674's [rollback sheet](CLOUD-CUTOVER.md) uses protected package/return
  directories outside the source and repositories and brings final stopped-cloud data back
  before activation. Package/home is the seed input;
  seed dry-run checks buckets, while the live host check precedes upload. No second writer or
  automatic clearing of used targets is allowed; data transport is the owner's administration path.
  `hybrid plan|package|back` and `instance engine` move the Mac between the single-machine mode and the
  hybrid mode. The cloud package is made on the Mac from a stopped source and holds a closed list
  (`db.sqlite`, `secret`, `secrets`, `customization`, `attachments`, `message-attachments` (PM-666: the files of team messages, which the
  database and `core/attachments` reference), `feedback`, `memory`, `HYBRID_CLOUD_ENTRIES`; a package made before
  PM-666 has no `message-attachments`, which is accepted, and `REPLACED_ENTRIES` of the way back lists it too);
  it never holds a CLI home, provider logins, worktrees, workspaces, repositories, `github-publish`,
  `spool`, `logs`, the instance marker, `engine.json` or `engine.key`
  (`HYBRID_NEVER_CARRIED`, checked again by `verify --hybrid-cloud` as `forbidden_entry`). The machine
  key is made on the Mac (`newMachineKey`), written to `engine.key` (0600, `wx`) last, and only its
  hash enters the package's database; `engine.json` is made with it. After a way back the revoked engine
  row stays as an audit record (PM-728): only a non-revoked engine makes `hybrid package` refuse, and the
  package makes its new engine the default explicitly (`setDefault`; `create` marks only the first engine
  ever as the default). **Does this work on a remote
  engine?** The tool is the one place that reads the Mac's home and repositories to build the
  engine's configuration (`engineProjects`), so it runs on the engine's machine by definition; the
  package is the only thing that crosses to the cloud, by a person's copy, and the key never does.
  The way back verifies the cloud's data directory as downloaded: it tolerates, and does not carry,
  what a running cloud writes itself (`logs/`, `engine-spool/`, Litestream's `.db.sqlite-litestream`,
  a restored copy's `instance.json`), refuses while the engine runs or its LaunchAgent is installed,
  and moves the Mac's former entries (old database, cookie key, secrets, machine key) to
  `pre-hybrid/<date>/`. That folder and the staging folder `.hybrid-back/` are in `sensitivePaths`
  (fixed names, so one path denies the tree); the package (`--out`) and the downloaded copy (`--from`)
  are the person's folders outside the home, which the sandboxes' deny-only reads do not cover, so the
  guide tells the person to delete them after use.
  **Module:** `scripts`

- **Engine service (launchd)** — `scripts/engine/{service,snapshot,logs,commands,cli}.ts`,
  PM-674's [rollback runbook](CLOUD-CUTOVER.md) uninstalls KeepAlive before hybrid back.
  Updates are manual owner-approved steps in
  the engine's own checkout; neither credentials nor launchd operations cross engine RPC.
  `deploy/mac/com.projectman.engine.plist` (PM-318). `npm run engine -- service install|uninstall|status`
  renders the plist template with this machine's absolute paths (node, the checkout, the home, the
  `PATH` of the installing shell, without the `node_modules/.bin` folders `npm run` puts in front) and loads it as a LaunchAgent in the user's `gui/<uid>` domain, so the
  engine starts at login and is restarted after an exit (`KeepAlive`, 30 s throttle). It is an agent,
  not a daemon, because the CLIs of the sessions need the login keychain and the user's files. The job
  gets only the variables the plist names (`PATH`, `PROJECTMAN_MODE=engine`, `PROJECTMAN_HOME`): no
  API key and no integrator key. `install` runs the same preflight as `start` and refuses another
  home's installed agent; `uninstall` leaves the logs (`<home>/logs/engine-service.{out,err}.log`).
  PM-1087 adds `service start|stop|restart` and the machine-readable state, the one contract of the menu bar
  app and any other shell: `start` loads the file (`bootstrap`, with the busy retry) or `kickstart`s a loaded
  idle job (no file: `service_not_installed`); `stop` is `bootout` (the file stays, `RunAtLoad` starts it at
  the next login) and waits up to 100 s for the process to leave; `restart` is `kickstart -k` (an unknown job
  is started); none touches another home's agent (`service_other_home`). The plist has `ExitTimeOut` 100:
  the engine's shutdown pause is 60 s (`APP_DEFAULTS.shutdownPauseMs`) plus a 20 s cap, while launchd sends
  SIGKILL after about 20 s by default; an existing machine needs `service install` again for it to apply.
  `status --json` prints one line (`EngineLocalSnapshot`, `scripts/engine/snapshot.ts`, exit 0 in every
  state, 1 only when it cannot be built) from `engine.json`, `engine-status.json`, one `launchctl print` (none
  off macOS: `service.supported` false) and the disk and memory of the machine; `overall` has one rule,
  `overallState`. `logs [--lines N] [--json]` prints the last lines (50, at most 200, from the last 256 KiB)
  of the two service logs.
  **Assumptions:** macOS, `launchctl`, a logged-in user, and the checkout the command ran from being
  the one that should run the engine (the plist names it). **Does this work on a remote engine?**
  This is the engine's own start-up: it must run on the engine's machine, as the user who owns the
  CLIs; nothing of it crosses to the cloud. On Linux the equivalent is a systemd user unit (not built).
  PM-750 prepares the engine candidate checkout that a later switch points this agent at (see the
  entry "Admin release preparation"); preparing it starts, stops and reconfigures nothing here.
  **Module:** `scripts`

- **Admin release preparation (PM-750)** —
  `scripts/release/{prepare,config,checkout,smoke,engine,receipt}.ts`,
  `apps/server/test/release-prepare.test.ts`. `prepareHybridRelease(context, {releaseId, commit,
outputDir, engineReleasesDir})` builds, from one exact commit, the linux/arm64
  image bundle (the existing `runImageBuild` with `HYBRID_PLATFORM`; PM-916 dropped the unused,
  QEMU-emulated amd64 image, so the receipt holds one smoke, old two-smoke receipts stay valid) from
  its own clean admin checkout of `repository.url` (the full object id is checked after the fetch),
  smokes the image by its image ID, and prepares an engine candidate checkout at `<engineReleasesDir>/<releaseId>-<sha>`.
  The smoke runs a disposable container with `--network none`, no mount, no port, a fixed
  entrypoint and a fixture home with a standby marker, no storage, mail or Access credential: native
  better-sqlite3 with a temporary database, the `cloudflared`/`litestream`/`restic` versions and the
  cloud server's `/api/setup`. The members' CLIs never run. The candidate's `npm ci` and server
  build run in the Anthropic Sandbox Runtime through the full-test facade (`runSandboxed`,
  `srtSettings`, `installerSettings`): only the install reaches `registry.npmjs.org` and
  `nodejs.org`, nothing else has a network, writes go only to the candidate's package trees or server
  bundle and a throwaway home, the sensitive-path list, the engine home and the temporary roots the
  machine's sessions share (Claude Code's `claude-<uid>`, the sessions' tmp base, `projectman-sessions`,
  as the full test closes them, PM-353) are unreadable, and the
  environment is the full-test allow list (no token, key or `PROJECTMAN_*` of the server). A missing,
  refusing, timed-out or interrupted sandbox ends the preparation; nothing runs on the host instead.
  The machine's heavy-run queue is held for the whole run (an unusable queue is a failure). The
  receipt `<outputDir>/preparation.json` (directory 0700, file 0600, strict zod, never overwritten)
  is written last, after the manifest hash, the archive, the image ID, the candidate's HEAD and
  clean state and the lockfile hash were verified again; a finished candidate carries a sibling
  `<candidate>.candidate.json` marker, and only a directory that matches it is reused.
  Foreign or partial directories are refused and never overwritten. A failed run leaves its
  `outputDir` (with `build-source`) as it was; a rerun needs a new `outputDir`, because an existing one
  is refused.
  **Assumptions:** an admin Mac with Docker and a pre-existing docker-container Buildx builder for
  linux/arm64 (native on an ARM Mac; as PM-718), Node and the Sandbox Runtime of the full test, `git` and https access to the
  configured repository, and `outputDir`/`engineReleasesDir` on a local disk of the user, outside the
  source checkout and the engine home. It writes no cloud resource, no engine home, no LaunchAgent and
  no registry; the receipt is neither an approval nor a signature of origin.
  **Does this work on a remote engine?** The image half is admin-side by design (the builder is
  never the engine or EC2) and needs nothing from the engine. The candidate checkout is the engine's
  own code, so it must be prepared on the engine's machine, as the user who runs it: a remote engine
  needs `engineReleasesDir` on its disk and its own Sandbox Runtime and Node, and the receipt (a path
  and hashes) crosses to the coordinator as data only, not the checkout. The real arm64
  Docker evidence comes from an approved admin trial; the fakes in the test do not replace it.
  **Module:** `scripts`

- **Non-interactive editors in member sessions** — `runner/env.ts` (`NON_INTERACTIVE_EDITOR_ENV`,
  `buildSessionEnv`) (PM-428). Every member session gets `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`,
  `EDITOR` and `VISUAL` set to `true`, so git (a rebase's message or todo list) never opens
  Vim on a terminal nobody types into. The values override the service's environment and are
  set for every provider. **Remote engine:** the engine builds the session
  environment beside the CLI with the same function (or the same four variables).
  **Module:** `runner`

After this inventory reaches `main`, the architect must compare the PM-286 hybrid plan and
its breakdown with it before PM-311 starts, including the related remote-work directions
PM-310 and PM-331. PM-341 is PM-311's prerequisite; that planning review is separate from
this documentation change.

## Housekeeping: worktrees of closed cards and free disk space (PM-243)

`WorktreeSweep` (at start and every 6 h, `DomainOptions.worktreeSweepMs`) goes over the done and cancelled cards
that have been closed for 3 days (`CLOSED_WORKTREE_KEEP_MS`) and have no running session, and removes the worktree
of each that is clean (`WorktreeManager.remove`, which keeps the branch; `ensureForTask` makes the worktree again if
the card restarts). A worktree with uncommitted changes is never removed: the owners get one `worktree_kept` alert
per closing of the card. What was removed and about how much space it freed goes to the server log only. The sweep reads
the closed cards past the keep time in pages of 100 by number (`closed-worktrees`, PM-770), with the closing time of
a round fixed at its start, instead of the project's whole card list; a card reopened between two pages is not on a
later page, and the removal looks at the card again right before it.

`DiskGuard` (every minute, `DomainOptions.diskCheckMs`) measures the free space of `PROJECTMAN_HOME` with `statfs`.
Below `team.limits.minFreeDiskGb` (default 10, 0 turns it off) the owners get one `disk_low` alert, withdrawn when
there is room again, and `Admission.check` refuses a new AI session with `disk_low` (deferrable: the start waits).
Running sessions finish their step. A measurement that fails never blocks anything.

### Loop watch

`LoopWatch` (`runtime/watchers`, PM-261; it replaced the message storm alert of PM-186 and
its `team.limits.messageBurst`, dropped from old configurations by the `dropMessageBurst` migration) catches AI
members writing to each other on a card without progress. The rules are pure and live in
`packages/shared/src/domain/loop-watch.ts` (`countsForLoop`, `findLoop`, `loopWatchers`, `loopDeciders`), also
used by the web's fake backend. Only team messages between AI members count; people's messages do not. Progress
is a stage change, a label change, a new commit on the card's branch (`SourceHead.committedAt`), or, since PM-431,
the work of a team that does not write code: a note, an attachment or a new description (`isLoopWork`; the
`task_work_recorded` event ends the open loop, `latestWork` in the timeline repository moves the progress point of a
new one; an imported comment is no work); the window
and the count are `team.limits.loopWatch` (`enabled`, `count` 3..50, `minutes` 5..240; default on, 6 in 30).
A loop is a row of `task_loops` (migration 29) with the phase `notified` → `owner` → `let_run`, and the card
carries it as `Task.loop` (a "Körbe fut" mark; every member sees it). Since PM-712 the selected PM gets a
report-only `loop_suspected` signal in its internal general session, even when it participates.
`triage_loop` records an attributed `loop_triaged` event: `progress` keeps observing from the current count;
another threshold of unchanged messages starts a new generation. `loop` asks the existing human deciders
(`stop_work` or `let_run`), once. The private note stays in `triage_json`, outside the public DTO and timeline.
Missing/on-leave/AI-disabled PMs and definitive delivery failures fall back to people after a fresh progress
check. Deferred delivery uses the existing durable `operator_signals` queue; no queued signal alone reaches
people. Ten minutes after successful delivery, counting only online engine time, the same guarded fallback
applies. The watcher rechecks card, work and branch head under its task lock before each assessment or fallback.
A loop closes itself when the card moves on, its labels change, work is recorded on it, a commit lands, nobody wrote for a whole window,
or the watch is switched off; its decision then closes with the `loop_ended` rule. `let_run` ends the loop at once
too (end reason `let_run`, PM-431): the mark goes, and another loop needs new talk after that, with no progress.
The phase `let_run` and the `let_run` event only remain for loops let run before PM-431. The timeline event is
`task_loop` (`raised`, `escalated`, `let_run`, `ended`).

### Fix round limit

`FixLimitWatch` (`runtime/watchers`, PM-262) puts an upper limit on a card's fix rounds. The
rules are pure and live in `packages/shared/src/domain/fix-limit.ts` (`countFixRounds`, `fixLimitReached`,
`fixLimitLead`, `fixLimitPlanner`, `fixLimitDeciders`), also used by the web's fake backend. A round is a
`code-review-changes` label put on the card, a `design-review-changes` label (the project's label list gets it
when the owner adds it; the designer's review step names it only when it exists and the member may set it), or a
send-back into a work stage (the counter of PM-222, `countCardRounds`), counted from the card's `counted_from`.
The limit is `team.limits.maxFixRounds` (1..10, default 3) plus the rounds people let the card have
(`extra_rounds`); a card is held when `rounds >= limit` and its assignee is an AI member.

While a card is held, what AI members and the system (the review watch's send-back) write to its assignee is
stored as waiting and does not wake it (`Messaging.send` with `held`), and the hand-over into the work stage
does not tell it; only people's messages pass, and a person's Start is "one more round". A decision that lets the card go on
(`another_round`, `continue`) also starts an AI assignee that has no session (a stored message and a
deferred wake-up when admission refuses, PM-420). When the card goes to
another implementer (`reassign`) the waiting messages stay with the first one and do not wake it. Who decides: the lead developer first (an AI member who holds
`technical_direction` and `code_review`, is not on leave and is not the assignee) with the MCP tool
`decide_fix_limit` (`continue`, `replan` to another `technical_direction` holder, or `to_owner` with a reason);
the planner then lets it start with a fresh count (`fixLimitPlannerForOwner`: when a person asks for the plan,
the planner is not the lead who passed the card on either; if none is left by then, it is one more round). The
people decide (an inbox decision with `replan`, `reassign`
and `another_round`, only the options that can be carried out) when no AI member can, when the lead passed it
on (`passed_on`), or when the card reaches the limit again after one more round (`again`). The state is a row of
`task_fix_limits` (migration 30); the card carries it as `Task.fixLimit` (every member sees it) and
`TaskDetail.fixRounds`. The hold ends with a decision, a change of the assignee (the count then starts anew) or
the card's closing; its inbox decision closes itself with the `fix_limit_ended` rule. The timeline event is
`task_fix_limit` (`reached`, `passed_on`, `decided`, `ended`). The notices to the lead, the planner and a
running assignee are not stored team messages (the timeline would show their English text): a `delivery.notice`
into the member's running session of the card, or the first input of a new one, like the loop watch's; only
when admission cannot start the session now is the notice stored as a message from `system`.

Extra rounds are capped and the lead decides first (PM-714, PM-801). `MAX_FIX_EXTRA_ROUNDS` is 3: while fewer
extras have been given, the lead decides at every limit reach (a card that reached the limit again after an extra
round goes back to the lead, reason `again`); once three extras are used, and the card reaches the limit again, the
decision has reason `extra_exhausted`. The decision item goes to the integrator (the PM-782 queue, `recipient:
'integrator'`) when extras are exhausted, when the lead passes it on with `to_owner`, or when no AI member can
decide; it falls back to the owners when the Operator does not work its queue or passes it on (no clock;
timeline event `fix_limit_recipient_escalated`, reasons `integrator_unavailable` and `integrator_passed_on`;
older events keep `integrator_timeout`). `decide_fix_limit` with `to_owner` requires an `assessment`
(`recurrence`, `currentState`, `recommendation { optionId, reason }`; errors `fix_limit_assessment_required`,
`fix_limit_invalid_recommendation`). The item carries the whole text (body, round history `fixRoundHistory`, extras,
assessment, each option's label and consequence), written in the project language by `core/inbox/fix-limit-text.ts`
from the `fixLimitItem` locale section, so REST, the MCP tools and the CLI show the same words. The integrator's
only right is `InboxService.resolveIntegratorFixLimit` (REST `POST /api/projects/:key/inbox/:itemId/resolve-integrator-fix-limit`,
external MCP `resolve_integrator_fix_limit` in super mode, CLI `projectman inbox fix-limit`): `replan`, `reassign`,
`another_round`, or the same item passed on to the owners with a reason; the resolution carries
`integratorFixLimit: true` and the super actor. Every other approval boundary is unchanged, and the generic
resolve path refuses an item addressed to the integrator until it is escalated. Does this work on a remote engine?
Yes, unchanged: the decision, the clock and the resolution are hub state; no engine operation, path or credential
crosses the boundary, and no machine-dependent inventory entry changes.

### Automatic stage advance (PM-445)

A card in a `step` or `release` stage whose next gate lacks nothing but humans' approvals must not sit unseen.
The rule is pure, `stageAdvance` in `packages/shared/src/config/gates.ts` (also used by the web's status line):
`move` when no condition is missing, `approve` when only human-only labels are, `null` otherwise (never from a
`work` or `queue` stage, never for a gate with unmet conditions). `AutoAdvance`
(`runtime/watchers`) acts on it as the system: it calls `moveToStage`, which moves the
card or opens the same "Döntés" inbox item a person's move attempt opens (source `system`; the item names the
label). It looks at a card when its labels or stage change, when a session of it goes idle or ends, and at every
open card once after the start. It does not move a card a session works on (an idle one does not count), does not
act on closed, blocked or theme cards, and does not ask again after the approvers rejected the request in the same
stay in the stage until the card's labels change. A person's drop on the board that
names a place replaces the system's open request, so that the place is kept with the request. It touches no
machine-dependent part: it is server state only. Automatic moves carry their source stage and its entry
time into the write transaction (PM-477); an asynchronous preparation that finishes after the card has
left that stay is discarded, so it cannot undo a human's move or reopen a finished card.

### Collecting card closes with its parts (PM-647)

A collecting card's work is its subtasks' work, so the gates of the stages on the way to Done (a plan, a review of
work nobody did on the card itself) say nothing once every subtask is closed. The rule is pure and in
`packages/shared/src/config/collecting-close.ts`, used by the server and the web's fake backend:

- `partsClosedWaiver`: an open card (not a theme) may enter a `done` stage without the gates when it has subtasks,
  every one is `done` or `cancelled`, at least one is `done`, and no blocking label (an open question) is on it. When
  every subtask was cancelled the plan fell, not the work, and a person decides. `TaskMoves.move` and `prepareMove`
  (`core/tasks/moves.ts`) and `TaskService.update` use it for every move path, a person's or the system's, so the
  board drop, the card update and the hand-on decision need no rule of their own. The waiver skips the gates, and
  the merge check only for a card with no code of its own (PM-797, below); a card with its own unmerged branch is
  still refused (`task_not_merged`). The `task_stage_changed` event carries `partsClosed` (the subtasks by outcome).
- `collectingSourceStateOf` / `canSkipCollectingMerge` (PM-797): the merge check reads a source commit from the
  engine, so a collecting card with nothing to merge must not need one. The state is `none` only when the hub's own
  data proves it: `TaskRepository.sourceEvidence` reads SQLite only (links, review pins, hand-overs, workspace
  bindings, sessions with a branch, merge records, and the timeline for the same facts and for the creation event) and
  reports whether a source was ever recorded, whether anybody worked on the card (an assignee now or in the
  history), and whether the card was created natively. A card with a source trace is `present`; an imported or
  legacy card, one with work recorded, an assignee or a gap in the evidence is `unknown`; both keep the merge check,
  so a gap never reads as "no source". `prepareMove` (before the unit of work) and `move` (inside the
  transaction) each re-read the evidence and recompute the waiver, so a trace or a reopened part that appears in
  between sends the move back to the normal check. A database error propagates and never releases the card. No
  engine call is made on the skipping path, so it works while the engine is online, offline or remote.
- `collectingAutoClose`: the system closes the card itself when the waiver holds, the card is `active` or `waiting`
  and it stands before the development stage (before Done when there is no development stage). A card somebody
  works on is not closed under them; a person's move gets the waiver anyway.

`CollectingCloser` (`core/tasks/collecting-close.ts`) acts on it as the system, in the background, one card at a time
(a keyed mutex): when a subtask enters the done stage or is cancelled, and when a card loses its last blocking label.
It reads the card fresh, then calls `moveToStage` with `expectedFrom` (the stage stay it read) and `partsClosed`
(valid only while the waiver holds, never falling back to the gates), so two parts closing at once make one move and
a person's move in between wins. A refusal (`gate_blocked`, `task_not_merged`, `task_closed`, `approval_requested`)
is logged and the card stays for a person to move. A recovery sweep at startup and every 15 minutes (PM-982) applies
the same rule to open cards, catching lost triggers (a restart between the commit and the background work).
It skips cards whose stage history records a move out of Done, preserving intentional reopening.
It touches no machine-dependent part; the only machine-near step is the merge check
a card with a source of its own makes (`engine_unavailable` leaves that card open). A card with no code of its own
makes no engine call (PM-797), so its close does not depend on the engine.

### Assignee handoff (PM-342)

`HandoffService` (`runtime/admission`, PM-423) hands a card's work from the old assignee to the new
one. The plan is pure and in `packages/shared/src/domain/handoff.ts` (`planHandoff`, `handoffBlocksStart`), also used by
the web's fake backend. A handoff starts when the assignee of a card changes and the old one is an AI member who has a
conversation on the card: by a person's change (`manual`), a fix-limit `reassign` (`fix_limit_reassign`), the removal of
the member (`member_removed`) or an automatic assignment (`auto_assign`). A change of the assignee is no longer refused
for a live session of the old assignee (only a change of the repository is).

- **Live.** `planHandoff` yields `live` when the old member can go on with its conversation (same provider, not on
  leave, a transcript exists). The session is stopped at a runner safe point (`pause`), told to write the note with the
  MCP tool `hand_off` (`ContextPackBuilder.handoffInstruction`), and closes after the note. The note is at most
  `HANDOFF_NOTE_MAX` characters and is stored with the branch, the last commit and whether anything is uncommitted
  (`sourceHead`). An idle resumable session is started for it. The time limit is `HANDOFF_TIMEOUT_MS` (10 minutes,
  decision 43); a pause (`PauseService`) stops the clock and a resume restarts it.
- **Fallback.** Otherwise, or on the timeout, the transcript summary stands in (`TranscriptReader.summary`, no compact;
  decision 43). The reasons are `on_leave`, `member_removed`, `no_conversation`, `provider_changed`, `provider_limited`
  (the quota refuses the start), `not_startable` and `timeout`.
- **The receiver waits.** The row of `task_handoffs` (migration 40; at most one open per card) carries the step
  (`waiting_point`, `writing`, `paused`, `closing`). The admission guard `task_handoff_open` holds back the receiver's
  start (the card shows it as `handoff_open`); messages that wait for the old assignee are forwarded to the receiver.
  When the handoff ends, the deferred start runs as an `AutomaticStart` of kind `handoff_takeover`, and the receiver's
  first session gets `ContextPackInput.handoff` and `previousConversation.lastNote`.
- **Cancel and restart.** A change of the assignee while a handoff is open calls it off (the card went back to the old
  member) or retargets it (to a third member); the old session is told so. `sweep()` ends the handoffs whose time ran
  out; `resumeAfterStartup()` brings the open ones on after a restart.
- **Visibility.** `Task.handoff` and `Task.lastHandoff` are read like the rest of the card (a client reads like a viewer, PM-79);
  a closed handoff is read with `GET /api/projects/:key/tasks/:task/handoffs/:id`, and the `PATCH` of a card answers
  `handoffStart` (`live` or `fallback`). The timeline event is `task_handoff`.

**Remote engine:** the only machine-dependent part is the `sourceHead` git query for the note and the fallback record
(see the inventory entry "Task worktrees and shared git storage"); the conversation state, the stop at a safe point and
the transcript summary go through the existing runner and transcript entries.

### Obligation tracking (PM-806, part of PM-796)

An open step of an AI member must not get lost when its session exits, stalls or misunderstands.
`services/obligations` (`ObligationsService`) gives every such step a responsible and a deadline of
`TeamLimits.obligationMinutes` minutes (5–1440, default 30, in `WAIVER_LIMITS`). Kinds in this card:
`merge`, `work`, `review_step` and `refinement_turn` (`fix_limit` and the PM path follow in other cards).
Each kind has a source (`sources.ts`) that derives, from the task waits, the merge requests and the
refinement turn, which steps are open now; the sweep writes one row of `obligations` (migration 88, not
journaled) per card, kind, responsible and subject, and closes a row whose step ended.

**`review_step` (PM-809).** One entry of a card into a `step` stage (the code review), for each AI owner of the
stage (`stageOwners`) who may set a label the next stage's gate lacks (`stepResult` in
`packages/shared/src/config/gates.ts`: the gate labels the member sets, `gate`, and with the other labels of
their groups, `results`: `code-review-ok` and `code-review-changes`). The subject is `<stageId>@<stageEnteredAt>`
and the clock starts at the entry. Unlike the other kinds this source derives the step from the stage, not from
the card's wait (`derivesWhilePaused`): whoever else works on the card or holds it, the step stays open until
its result is there, and the pause of the sweep stops the clock. A fix round limit on the card (`held`) and the
other pauses stop it too; the responsible's own working session moves the deadline, an idle session that holds
the card does not (the reminder goes into that session). A result label added since the entry (any of `results`)
or a move forward fulfils the row, so a `code-review-changes` ends the step and the same entry opens no new one;
a move back, a lost stage ownership or a closed card cancels it, and a new entry is a new subject and a new
clock. A queue stage (Ötletek, Indulhat) has no such step: its cards are the owner's, and a card under
refinement has its `refinement_turn`; the rows an older build opened for a queue stage end as `cancelled` on
the first sweep, whatever holds the card. A card in a merge has no review step: the `merge` kind follows it.
A card imported into the stage (its `task_created` event carries `imported` and the entry time) was not handed
over, so it has no step until it enters the stage again. Known gap: a second review round on the same entry (after a `code-review-changes` and the developer's fix)
opens no new row.

The pure clock is `planObligation` in `packages/shared/src/domain/obligation.ts`: the first expiry sends
one action message from the system to the responsible (`obligation_woken`), the second makes one integrator
todo (`obligation_handed_over`, `core/inbox` `openIntegratorTodo`). Activity of the responsible moves the
deadline; a person's open question, a held card, a pending permission and a refused start (team paused,
engine offline, `PAUSING_REFUSALS`) stop the clock and a resume restarts it. A restart, a double sweep and
a crash between the todo and the row write repeat nothing: the rows hold the clock and the todo is found
again through its `payload.obligation`. The system never merges, decides or sets a label. The hub job
`obligations` runs the sweep at start-up and every minute.

**Remote engine:** everything runs on the hub. The reminder goes through `Messaging` and `ensureSession`,
whose start takes the engine path as any message; an engine that is offline is a `start_refused` pause of
the clock, not an error. No machine-dependent part is added, so the inventory does not change.

### Project focus (PM-427, PM-435)

A project has one ordered focus list of at most `PROJECT_FOCUS_MAX_ITEMS` (20) themes or cards the team works on now.
The contract and the pure rules are in `packages/shared/src/domain/project-focus.ts`: `projectFocusRefusal` (who may
set it) and `projectFocusPlaces` (key -> `FocusPlace`, the 1-based place and the item that covers the card). The
later parts of PM-427 (the order of deferred starts, the AI members' brief, the web) build on both.

- **Storage.** Table `project_focus_items` (migration 43; `(project_key, task_key)` is the key, `position` the order,
  `added_by` the actor as JSON), repository `repos.projectFocus` with `list(projectKey)` and `replace(projectKey, items)`.
  `ProjectFocusService` (`core/tasks`) replaces the list and appends the timeline event in
  one unit of work; the `project_focus_changed` WebSocket event leaves when that commits, then the `onChange` listeners
  run. A write that leaves an item where it was writes nothing. The service takes nothing off by itself: a closed item
  stays until a person removes it, covers nothing, and still counts in the numbering.
- **Coverage.** A card covers itself and its subtasks; a theme covers itself and every card whose `themeKey` it is,
  with their subtasks. A closed item covers nothing and a closed card has no place; the smallest place wins.
- **Who sets it.** A person (`actor.kind === 'human'`, through the integrator too) who owns the project
  (`ownerHandles`) or holds the `prioritization` duty (`dutyMembers`); no approval. An AI member or the system gets
  `focus_humans_only`, any other person `focus_not_allowed`.
- **Access.** There is no REST route for the focus list (PM-1030 deleted them; nothing called them): the MCP tools and
  `ProjectFocusService` read and write it, and the domain refuses a write to anyone without the prioritization duty.
- **Timeline.** `focus_changed` (`added`/`removed` on the item's own card or theme, `moved` without a card, so it shows
  only in the project's changes). `task_stage_changed.data.pulled` (`StagePull`: `{ reason: 'urgent' }` or
  `{ reason: 'focus', position, key, title }`) marks a card the system pulled into the work stage (below).
- **Order of deferred starts (PM-436).** `Admission.retryDeferred` ranks the stored starts by `startClass` /
  `compareStartClass` (shared): urgent (the card's priority is `urgent`), then focus by place, then the others; within
  a class the `senior_busy` waits first, then the store order, so without focus or urgent cards the old order holds.
  The places are read once per project and round. Rounds run one after the other: a start being retried is out of
  the store, so an overlapping round would not see it; a round asked for while one runs makes the running one go once more.
- **Pull (PM-436).** At the end of every `retryDeferred` round (so on every event that retries the deferred starts) the
  `FocusPull` (`admission/focus-pull.ts`) gives a free developer a ready (Indulhat) card from the queue stage before
  the work stage (`pullSourceStage`): `pullCandidates` takes the urgent cards (board order), then the focus cards by
  place. A candidate is an active card, not a theme or a collector with any subtasks (closed ones included, PM-818), with no assignee,
  no open prerequisite, no start block
  (`startBlock`, so no `waiting-answer`) and nothing more asked by the gates on the way: a card that would need
  `approvals` is left out, so a pull never requests one. The developer is picked as for any start (`chooseDeveloper`: a card
  whose points exceed a developer's limit never goes to that developer) among the AI owners of the work stage who are not
  temp workers, not on leave, have capacity and are not waited for by a stored deferral (that one goes first, a
  `senior_busy` wait waits for the developers whose limit reaches its points). One card per developer per round; nothing is pulled while AI work is off or
  the project or the instance is paused, and no temp worker is hired. `WorkStarts.pull` takes the admission lock per
  card and starts it like a deferred start (`startLocked` in the system's name, `automatic`, `StartTaskOptions.pulled`
  into the stage change), so the Start button and a pull on the same card make one start; a failure after the
  assignment falls back to the usual `work_start` retry. Refusals are logged at debug level and write no timeline.
  Automatic work starts also leave themes and collectors with any subtasks unassigned (PM-586, PM-818), using
  `canAutomaticallyStartTask` (shared) before choosing a developer and again before assignment. A deferred
  work start is dropped on retry when its card gains a subtask. Explicit manual starts remain available.
  A new round starts at once on a focus change (`ProjectFocusService.onChange`), on a priority set to `urgent` (the
  internal `task_priority_changed` event) and on a card entering the queue stage, besides the freeing of a developer.
  The start round (`StartRound`) reads the whole active queue (`queue` read), assigned cards too (PM-879): an
  assigned card is offered to its own assignee when they are free and never pulled. The offer asks the pm for
  `start_task`, not a move: a move forward starts nobody (PM-119), while `start_task` keeps the assignee, moves the
  card and starts the session. Without this a card assigned in the queue stage was never offered and nobody was woken.
  The round also offers a card that stands in the work stage with an AI assignee who has no session on it at all
  (no open handoff, not held by the fix round limit), also with `start_task` (PM-556 stalled this way; an update_task
  move of an assigned card leaves the offer open). Assigned cards reserve their own developer before any other
  card, a busy assignee gets no offer and no hold, and the `start` obligation ends once the assignee has a session.
- **Targeted reads (PM-770).** The retry, the pull and the startup recovery do not read a project's whole card list.
  `TaskSchedulingReader.readSchedulingTasks(projectKey, query)` (`contracts/task-scheduling.ts`, implemented by
  `TaskService` over `TaskRepository.readScheduling` in `db/tasks.ts`) returns stored rows with their own links, in
  ascending number, without the board view and the derived fields. The queries are `keys` (exact cards), `focus` (the
  cards a project focus covers: the focused roots, the open cards of a focused theme, and their subtasks), `pull` (the
  open cards of the queue stage that are urgent or focused), `children` (the open subtasks of cards), `open` (every
  open card) and `closed-worktrees` (closed cards past a closing time, paged by number). The pure rules stay in
  `packages/shared` (`pullCandidates`, `startableCards`, `openPrerequisites`, `startClass`, `canAutomaticallyStartTask`,
  `startBlock`, `stageAdvance`, `mergeReadiness`, `cardMerger`) and run over these rows; SQL only narrows the set they
  see, it copies none of them. `startContext` (`core/tasks/scheduling-context.ts`) adds all subtasks (with `includeClosed: true`) and
  prerequisite targets the rules look at to the candidates, and `prerequisiteCards` reads just the cards a card's
  `prerequisite` links name. `FocusPull` looks for a free developer first: with none, no card is read. Migration 78
  adds the partial indexes `tasks_scheduling_pull`, `tasks_scheduling_open` and `tasks_scheduling_closed`. The
  startup recovery (`AutoAdvance.sweep`, `Merges.reconcileProject`) reads the open cards, and for merges also the
  cards of the open merge records, a closed card too, so a record is still reconciled; `Merges.reconcileCard` decides
  on the stored row first and reads the board view, the reviewer's timeline and the source head only for a card with
  a record or a ready gate. The assembly runs one stage-advance per card at a time; an event that comes meanwhile asks
  for one more round that reads the card afresh.
- **Operator history reads (PM-771, PM-783).** The Operator's 60 second sweep (`OperatorSignals.sweep`) and the structural
  report (`StructuralPatterns.report`) no longer walk a project's closed history. The board cases (`boardCases`, one
  map per sweep, no cache kept between sweeps), the pending list and the step targets work from the `open` read;
  `TaskWaits.of` and `MemberService.rosterFor` read the open cards and only the cards the `prerequisite` links name
  (`keys`), which is the same answer because a closed prerequisite is not an open one. The 7-day evidence comes from
  `TimelineRepository.structuralEvidence`, now through the partial index `timeline_structural_window` (project,
  creation time) instead of a walk of the project's timeline, and the structural report reads only the cards those
  events name (`keys`). A collecting card's completion is reconstructed at the closing event: the internal
  `TaskStateHistoryReader.latestTaskStatesBefore(projectKey, taskKeys, before)` (`contracts/task-scheduling.ts`,
  provided by the timeline repository) returns for each sibling its last state event (stage change, cancel, reopen)
  created strictly before the window start, found through the partial index `timeline_task_state_before` (project,
  card, creation time, seq) with one probe per card; the window's own events are then replayed in seq order. A sibling
  without any state evidence stays unknown and does not count as closed. Migration 80 adds both indexes and rewrites
  no event. The query plans are asserted in `test/timeline-state-history.test.ts`; the tenfold-history read counts in
  `test/structural-history-reads.test.ts`. A lazy `StructuralPatterns.evaluate` object shares each exact window's
  event/card read, pattern grouping and milestone reconstruction within one synchronous phase (PM-783). Pattern
  subjects use a map; milestone card/event pairs use a set. Only a currently present pattern subject causes its
  original `raisedAt` window to be read, and that historical read computes patterns alone, without parent/sibling
  reconstruction. Conflict request history is read once per card (the existing 1000-request limit and first match),
  merge records once per id, including missing records, across all windows in that evaluation. Nothing is cached
  between phases: the sweep report shares its evaluation only with the immediate pre-admission delivery check;
  after reading configuration asynchronously, start validation and the facts payload share a new evaluation.
  Every actual `stillValid` call and every public `structuralFacts` call creates a fresh evaluation; review requests,
  owner decisions and `assertStart` retain their independent checks. No cached evaluation is reused across an await,
  approval or admission boundary. `test/periodic-work-performance.test.ts` adds opt-in PM-783 workloads with real patterns,
  milestones, repeated conflicts, shared/distinct original windows and signals held by budget/admission/engine
  refusal, preserving the PM-769/771 seed and scenarios. It records CPU user/system time, wall median/p95, hydrated
  rows and computation/read counts separately from startup and seeding.
- **Clients.** A client sees the focus like a viewer (PM-79): the endpoints, `project_focus_changed`, `focus_changed` and
  the `pulled` mark of a stage change; they cannot set it.

**Remote engine:** the pull and the order are server-side domain rules over stored data and the existing start path; no
new machine-dependent part (the start itself is the inventory's existing work start), so the inventory does not change.
The targeted reads of PM-770 are server database reads too; only the sweep's candidates changed, and the worktree
entry above says so. The Operator history reads and synchronous evaluations of PM-771/PM-783 stay on the server, over its own timeline
and card tables (no engine operation, RPC or payload is added, and no local path, process or socket is involved), so
the inventory stays unchanged: on a remote engine the Operator and its signals still run on the server, within the
existing "Cloud composition" and "Provider and engine outage watch" boundaries.

### Coordination belongs to the PM (PM-707)

PM-780 keeps `structural_pattern` and `milestone_closed` exclusively with the coordinator. The shared
`isCoordinatorOnlySignal` rule filters them from owner channels, counts and websocket signal events,
including historical closed signals; timeline entries and message text remain readable. The PM never
presents their IDs to owners: it summarizes worthwhile reviews once per wake-up and closes the rest
with `dismiss_signal` and a note. Open structural signals expire after seven days.
Migration 86 closes existing pending/open structural signals with a traceable upgrade reason and adds
`operator_signal_arms`, keyed by project and kind. Only a sweep arms a detector, once; evidence windows
start at the later of this durable timestamp and the seven-day boundary. Earlier events never create
retroactive signals, including after restart. Detection and migration stay on the server; no engine or
machine-dependent boundary changes.

PM-696 adds report-only `structural_pattern` and `milestone_closed` signals. The server's
`services/operator/structural-patterns.ts` reads structured timeline evidence in a seven-day window:
the same repository-relative conflict or failed-test file on two independent cards, or at least three
fix rounds on each of two cards. Retries on one card and raw output never form a pattern. Signal cases
retain a short SHA256 fingerprint; their original timeline window reconstructs the evidence after restart.
The same fingerprint is suppressed for seven days and structural deliveries share a daily project budget.
Theme closure and collecting-card completion use actual transition events, never ordinary card completion.
`request_structural_review` is restricted to the selected PM's internal general session. Without an open
owner request it creates a question with server evidence and approve/reject options. The registered
`operator_structural_review` decider requires the owner's own login. Its answer opens a separately
validated `CoordinationRequests` approval continuation for the PM, never an Operator request; approval
itself starts nobody. The PM then requests the review again, rechecking the signal and selecting a live
`technical_direction` AI holder by capacity, load and handle. `start_member` carries the short review
through the existing message/session boundary and records the source request and decision. The review
reports suggestions (including no change), creates no cards automatically and never writes Operator knowledge.
No machine-dependent part changes: detection and selection run on the server, delivery uses the existing
session boundary and works with remote engines.

The selected live PM (`coordinationMemberOf`, shared `config/project-manager.ts`) receives every
coordination signal and screens AI questions, including the Operator's. Its own questions go directly
to people. `coordinationActorRefusal` accepts only this PM's direct AI actor. The four coordination
mutations (`combine_questions`, `screen_question`, `dismiss_signal`, `start_task`, `start_member`) additionally require its
actual internal general session; other people, customer conversations, other members and external
tokens cannot use them (`project_manager_only`, HTTP 403 / MCP forbidden). The Operator and internal
PM may read `get_project_state`; guest access is unchanged.

`CoordinationRequests` uses the existing request/step repositories with separate PM session rows.
Only delivery of an owner's own-login message or answer opens its request. It expires after 30 minutes
or at turn/session end; an Operator request and a signal round never authorize a PM start. Filtering
the Operator channel by the request's session member keeps its own request list separate. Audit actors
come from the real session; earlier request, message and timeline actors are never rewritten.
`source: approval` remains reserved and is refused until a validated structural-review continuation
exists; the Operator's knowledge approval cannot fall back to a PM message request. A human accepting
the current PM's actionable proposal may open a separate `message` request only after actual delivery:
the accepted signal, deciding owner, presentation author and delivery binding must all match. Saving
the decision, pending delivery or replay alone opens no request.

Migration 69 adds nullable `operator_signals.delivered_to`; public `OperatorSignal.deliveredTo` is
optional for older DTOs. Successful delivery records the PM handle and time together. Unpresented
legacy or changed-recipient signals are delivered again with the same id, case, evidence and budget.
Leave invalidates their binding. Presented/accepted legacy proposals retain their original decision
route. The current actor, target, delivery binding, case facts and persisted step budget are rechecked
before writes; one in-flight step per signal is allowed. `team.operatorWatch` retains its name and
report/unblock/drive meaning, without becoming a permission switch or a separate PM budget.

For `answer_stalled`, report allows no start; unblock/drive allow only `start_member` for the same
card's current assignee, with the existing one/three-step budget, 30-minute gap and task/member mute.
Gates, prerequisites, permission waits, fix limits and normal admission still bind it. There is no
signal authority for task movement, configuration, labels, approvals, stopping or critical operations.
The Operator keeps its existing agreement, settings, knowledge, waiver, document and approval rules.
The historical Operator coordination paths described below are superseded by this section.

`start_blocked` (PM-455, migration 120) speaks for a card whose start waits for `repo_required`,
`workspace_dirty` or `workspace_fetch_failed`: one open signal per card and reason (`start_blocked:<card>:<reason>`),
read from the card's start wait (`TaskService.startWaitingOf`, which also covers the raw scheduling cards the sweep
reads). It closes by itself when the wait ends or changes reason; a wait that is silent only because the system is
trying the start right now (`startAttempting`: the deferral is taken for the attempt, a fetch may take a minute)
leaves the signal as it is. A `workspace_fetch_failed` signal is raised at once but not delivered before ten
minutes have passed without it closing (the retries of the system may mend a network blip); one that mends sooner
closes without ever reaching the project manager. Facts: reason, member, branch, repositories (for `repo_required`)
and the card holding the branch (for `workspace_dirty`); never the git error text. Step targets at unblock/drive:
`workspace_dirty` → `start_member` for the waiting member on the card that holds the branch (`heldBy`);
`workspace_fetch_failed` → `start_member` for the deployment-duty AI members on the waiting card;
`repo_required` → no step. The one repository exception of the project manager's prompt (set the card's
repository on a `repo_required` signal) is prompt-level only: the server adds no restriction, as `update_task`
with `repo` is open to every member and refused only for an unknown repository or a live session. A question
about a signal is asked with `ask_human` and `signal_id`: only the coordinator the signal was delivered to may
bind it, to an open signal of its own project; the question defaults to the signal's card, stores the id in its
payload, and closes with the rule `signal_resolved` when the signal's case ends.

This works on a remote engine: selection, storage and checks stay on the server; the existing engine
link and session admission boundaries carry the same messages and starts. No machine-dependent part,
engine protocol, login, sandbox or cloud AI is added. For `start_blocked` the wait comes from the engine's
refusal code (`workspace_dirty`, `workspace_fetch_failed` and their `branch` detail) as the deferred start already
records it; the signal itself lives on the server, so no machine-dependent part is affected.

### The Operator (PM-447, PM-462, PM-463, PM-464)

Every project has an Operator: an AI member of the built-in role `ai_operator` (duty `project_operation`, AI only;
handle `operator`, `operator-2`, ... when taken) whom the owner asks to change how the project runs. The project
manager stays the dispatcher. The human built-in role `operator` keeps its id and duties (`final_decision`,
`release_approval`, `monitoring`); only its display name is now "Owner" ("Tulajdonos"). The pure rules are in
`packages/shared/src/config/operator.ts`: `isOperator`, `operatorOf`, `isRequiredOperator` (the only Operator cannot be
retired, `operator_required` 409; it cannot go on leave), `isOperatorActor` (an AI actor without `via`).

- **Works only on request.** `WakeFacts.recipientIsOperator` and `fromOwnLogin` (a person's own login, not the
  integrator key): only a person's message wakes the Operator; any other action message is blocked with `WakeBlock`
  `operator_owner_only`. The server fills the facts in `wakeFactsFor`.
- **Three levels of a configuration change.** `operatorConfigVerdict(previous, next, { operator, invitationBinding })`
  compares the end results and returns the rows (`ConfigChangeRow`: area, target, field, before, after, level) and the
  highest `OperatorLevel`: `now` (an AI member's `model`, `effort`, `capacity`, `onLeave`, `schedule`, except the
  Operator's own member; a stage's `name`; a role's `instructions`, except the Operator's own role), `never` (any
  change to a human member, `owners`, `admin_or_account` of `ownerOnlyChanges`) and `approval` for everything else, so a
  new configuration field is closed until a rule opens it. What `integratorConfigRefusal` or `ownerOnlyChanges` names
  is at least `approval`; the exception is the four member fields above, which the integrator rule would cover but the
  owner asked to go straight through.
- **Approval waiver classification (PM-691).** The verdict additionally returns `waiverEligible`, true only for
  an `approval` change whose full end-state diff is on the explicit shared allow lists. Protected rights,
  authorization duties, gates and approval labels, locations, sharing and the Operator's own settings still
  need approval; unknown fields are closed. New AI members expose non-default permission fields beside their
  presence row. Approval labels use `isOwnerApprovalLabel` in both end states (human-only, author exclusion or
  a gate requirement); their actual holders and resolved reviewer/authorization duties remain protected even
  without a gate. `team.operatorApprovalWaiver` is optional (absent: false), owner-only and stored in `team.yaml`.
  reordering existing stages is protected even with unchanged gate definitions. Stage/member changes that
  alter `mergerOf`, the merge target or any `cardMerger` reviewer choice also need a click; roster reordering
  has its own approval row because duty-derived owner order can change the selected merger.
  Classification never changes a verdict's level or authorizes execution.
  The Operator template uses `approver: human`; load and revert migrate legacy `none`/`ai` values to `human`
  without relaxing mode or network. Shared fixed invariants reject a nonhuman Operator approver, an Operator
  merger and boundary authorization in its role. These errors are never tolerated on load or preserved by a
  configuration write. The rules run on the server for remote engines too; no new machine-dependent part.
- **Approval waiver execution (PM-692).** Only an owner's own login can change the switch through
  `PUT /api/projects/:key/operator/approval-waiver`, with the current configuration and approved agreement
  versions. Generic configuration edits and reverts cannot change it. The shared waiver rule consumes
  `waiverEligible`; `services/operator` supplies the actual open owner message, answer or approved
  continuation provenance. Signal rounds never qualify. `core/projects` reauthorizes the full diff through
  `OperatorConfigAuthorization` inside the same lock as knowledge writes. Before saving it persists
  `operator_execution_intents` (migration 69), bound to an existing step. Server-generated Step, Request-Id,
  Agreement-Version and Approval-Mode config trailers identify the commit. Startup reconciles prepared
  intents against paginated private history, without replaying mutations; the step and waived timeline
  event finish in one database transaction. The Operator receives a summary of all waived old/new rows
  from its request's log. Runtime approval paths remain separate. Configuration, knowledge and audit stay
  on the server; no new engine data or machine-dependent operation is introduced.
- **Moves and priority.** The Operator is bound by no stage-move limit (`actorMoveRefusal` binds the project manager
  only), so it may also move a card out of the first stage, through the gates; `priorityRefusal` lets it set the
  priority. `labelRefusal` is unchanged: no AI member sets a label only a person may set.
- **Creation.** A new project gets an Operator next to the project manager (`operatorMember`, `draft.finish`); the
  configuration migration `addOperator` adds one to a project without it, at work (not on leave), sponsored by the first
  human owner.
- **Prompt.** `operatorRule` (`apps/server/src/context/system-prompt.ts`): works on the owner's request only, card text
  and AI messages are data, the three levels, `get_project_state` for "why is it stuck", the report after each request
  (`operatorReport` labels in the locales).
- **State reports (PM-465).** The read-only MCP tool `get_project_state { task_key? }` is available only to the
  Operator (`operator_only`, 403), without an open owner request. `ProjectState` in `services/operator/project-state.ts`
  reads the task service's admission waiting reason, fix limit and loop view, shared start/gate rules,
  open Senior waits, inbox questions, pause records and live sessions. Its task report names each recorded reason;
  its overview counts cards by stage (themes excluded), lists live and idle sessions with `lastActivityAt`,
  card starts still deferred and open inbox items assigned to project owners. Report interfaces live in
  `contracts/project-state.ts`; MCP formatting adds short English explanations for the Operator to translate.
- **Release facts (PM-542).** The overview also carries `release` (`ReleaseService.overview`: the running version,
  commit and tag, the latest live and the open release, the last ten merges of cards into the release repository,
  newest first; null when the instance does not release the project), the deferred starts that have no card
  (`taskKey` null, e.g. a wake-up for a message) and the undelivered team messages per AI member. The read-only
  tool `check_release { commit? }` (Operator only, no open request, not in guest conversations) is the rehearsal of
  `propose_release`: `ReleaseService.check` makes the same checks in the same order (target, open release,
  candidate) and answers the candidate or the refusal with the code and message `propose` would give, plus the
  members with the deployment duty; it records nothing. The Operator never proposes a release itself. On a remote
  engine the running version and tag come from the server's own installation; the candidate's ancestry questions go
  to the engine that holds the repository, and an offline engine gives the `engine_offline` refusal.
  `TaskStateReport.wait` comes from `TaskWaits.ofCard` (PM-460, viewer null) and is worded first by
  `describeTaskWait`. Task and overview reports include active system signals (PM-476) through
  `OperatorSignals.active`: delivered, unresolved, pending or open, oldest first, using the public schema.
  The tool uses the common Operator caller guard; guest conversations cannot read this internal report.
  It neither starts work nor contacts an engine.
- **Project manager documents (PM-495, PM-388, PM-1004, PM-1044).** Tools and their handler live in `mcp/project-docs/`.
  `read_project_doc`, `write_project_docs`, `list_decision_candidates` and `mark_decision_candidates` belong to the
  selected available project manager (`coordinationMemberOf`), only in its own internal general conversation.
  The app has no Operator since PM-1045, so only the PM holds them. The PM uses its own `CoordinationRequests`;
  an Operator request, guest conversation, signal or approval continuation grants no document-writing authority.
  Document procedures and lessons guidance belong to the PM's prompt and role guide.
  `read_project_doc { doc, from_line?, line_count? }` is a read tool
  (`OPERATOR_READ_TOOLS`, not a guest tool): decisions, roadmap or lessons at the fresh head of the default branch,
  read through `BranchMerger.readFile` on the caller's engine, with the commit it was read at.
  `write_project_docs { base_commit, message, edits }` writes: the selected PM or transitional Operator (`operator_only` otherwise), in the owners'
  own conversation (`{ type: 'general' }` without `with`, from an owner's request; `operator_owner_only`
  otherwise) and with an open request (`operator_no_request`); `OPERATOR_TOOL_ACTIONS` maps it to `docs_write`.
  The edits are checked against the text at `base_commit` first (`applyDocEdits`, `isAppendOnly`, both pure, in
  `services/project-docs/doc-edits.ts`; the decision log only takes new lines; 422 `docs_edit_not_found`, `docs_edit_ambiguous`,
  `docs_not_append_only`, `docs_unchanged`), then the write is queued (`doc_writes`, one open per project:
  409 `docs_write_pending`) with an Operator step in `queued` status, and runs in the repository's merge slot (see
  "Merge"). The call waits up to 60 seconds for a write that starts at once and answers `published`, `queued` or
  `running`; a write that ends without a waiting call updates its step (`done`, `stale` or `refused`, with the
  refusal: `updateStep(…, refusal)`) and sends the author an English `info` system message, read with the owner's
  next message. A file that changed since `base_commit` is `docs_stale`, never a blind edit. The commit carries the
  trailers `Projectman-Operator`, `Projectman-Request` and `Projectman-Requested-By`. Never forced. The server owns
  the queue, the lock and the step log; the git runs on the engine. No new machine-dependent part.
  PM-1004 adds the narrow lessons-only exception (`isLessonsOnly` in shared): the selected PM or transitional Operator reads/writes lessons
  in its own internal general session without an open owner request, including an Operator queue request whose server-side
  `queueItemId` identifies its own processing item in the same project and session. Guest conversations,
  non-owner message/answer requests and approval continuations remain forbidden. Mixed edits, decisions,
  roadmap and decision offers retain the owner-request rule. Paths are explicit in `RepoDocs.lessons`, with no
  implicit default or migration, and all configured document paths must differ. A write touches at most two
  paths (422 `invalid_request` before queueing). Autonomous rows alone carry `autonomous_lessons = 1`
  (migration 109), with null owner request, owner, step and external origin; the commit trailers are
  `Projectman-Operator` and `Projectman-Operator-Mode: autonomous-lessons`. Reauthorization at start/recovery
  and before push/advance checks the selected PM or transitional Operator, repository/default branch and lessons path; conflicting
  provenance is refused. Delayed results use the existing system-message path, and stale lessons request a
  reread and retry. Super MCP lessons still use `requestExternal`, key provenance and key/owner/Operator
  reauthorization; read keys cannot write and legacy keys fail authentication (PM-1037). See the `merge.read_file` /
  `merge.commit_files` machine inventory above for the unchanged remote-engine boundary.
- **Searchable document copies (PM-744, PM-788).** `services/history/document-sync.ts` maintains a cloud SQLite
  copy of each configured repository's fixed `docs/DECISIONS.md` and `docs/LESSONS.md` paths. The assembly reader
  uses the same engine selection as structure-map base reads; the second file is pinned to the first file's commit.
  Published document writes (including the local-checkout warning) and `task_merged` notify it after commit;
  these reads do not fetch. Startup/configuration changes and ten-minute head reads cover other changes, with
  one-minute retries while pending/stale/unavailable. Searches only read SQLite. Missing files remove their old
  copies; engine/git failures preserve old text as stale, or mark a never-read copy unavailable. The last received
  snapshot survives restart and remains searchable offline, with its status (owner, 2026-10-18). A configured
  custom decision-log path is not followed by this fixed-path copy. See the `merge.read_file` inventory above
  for the remote-engine boundary and the per-repository fetch queue.
- **Roadmap check at a release proposal (PM-497, removed by PM-1045).** `ReleaseService.propose` still emits the
  domain event `release_proposed`, but nothing sends the Operator a roadmap notice any more: the Operator runs no
  session in the app, and `ReleaseRoadmapNotices` (`services/releases/roadmap-notices.ts`) is deleted. The roadmap
  comparison is the project manager's work on request. No machine-dependent part.
- **Decision candidates (PM-496, PM-388).** `DecisionCandidates` (`services/project-docs/decision-candidates.ts`) finds the
  questions of the inbox that an owner answered (through the integrator too), that no rule closed, that someone but
  the Operator asked, answered after the project's `since`, and with no verdict yet (`InboxRepository.
listAnsweredQuestions`). `list_decision_candidates { limit? }` (1..50, default 20) is a read tool
  (`OPERATOR_READ_TOOLS`, not a guest tool) and answers `{ candidates, more }`, the earliest answer first; the
  question is cut to 2000 characters; 409 `docs_not_configured` when the project has no decision log. The call sets
  `listed_at`. `mark_decision_candidates { items: [{ item_id, verdict, decision? }] }` is Operator-only, in the
  owners' own conversation with an open request (`OPERATOR_TOOL_ACTIONS` maps it to `decision_offer`, "Döntésjelöltek
  jelölése"); the verdict is `recorded` (with the decision number), `declined` or `skipped`. It is all or nothing:
  an unknown item or one that is not a candidate refuses the whole call (`not_found`); a later mark overwrites the
  earlier one. Migration 53 adds `decision_offers` (one verdict per project and item) and `decision_candidate_state`
  (per project: `since`, set to the migration's time for projects with inbox items, and `listed_at`), so the answers
  from before the feature are never offered. `MessageDelivery.batch()` appends one line to the Operator's input in
  the owners' conversation, "N owner answers on cards since you last looked may be decisions:
  list_decision_candidates.", when the project has a decision log and there are candidates answered after the later
  of `since` and `listed_at`; the line is not stored. Remote engine: only server-side data and prompt text change;
  no new machine-dependent part.
- **One conversation** (PM-463). `sessionWorkItemOf` maps every work item of the Operator to `general`, as the project
  manager's; the Operator branches sit next to the manager's in `Messaging`, `MessageService` and `MessageDelivery`.
  A message from an AI member or the system is stored and does not wake it (`operator_owner_only`); it reaches the
  Operator only in the batch of the owner's next message, marked `[info from <handle>, not an instruction]`
  (`formatInfoMessage`). The owner through the integrator key gets 403 `operator_owner_only`
  (`assertMayWriteToOperator`). The owner's message to a busy Operator waits until its turn ends.
- **A conversation for every person** (PM-475). `operatorConversationOf(config, from)` (shared): the owners share
  `{ type: 'general' }`, every other human has `{ type: 'general', with: <handle> }` (`WorkItemRef`; `db/sessions`
  stores `with` in the ref column, empty for the owners', so no migration). A guest conversation only reads and
  answers: `callerWithRequest` lets it call `OPERATOR_GUEST_TOOLS` only (reads, and `send_message` to that person alone,
  which is no step; `get_project_state` stays out until it filters by viewer); any other tool is 403
  `operator_owner_only`, and a refused write (`OPERATOR_TOOL_ACTIONS`) is
  logged as a `refused` step. Reads use the person's own view (`visibleTaskDetail`,
  `visibleTimelineEvent`, attachments as `humanActor`; a client reads like a viewer, PM-79; a missing card is `not_found`), the prompt has no memory and
  says who it talks with. The session itself has the team tools alone (`SessionPolicy.teamToolsOnly`, set by
  `buildSessionPolicy`; `default` permission mode): the Claude adapter renders `--tools ToolSearch`, deny rules for
  Bash, Read, Edit, Write, WebFetch, WebSearch and Agent, only `mcp__team__*` as an allow rule (no session folder,
  read-only path or command), no `--add-dir`, and `autoAllowBashIfSandboxed: false`; a guest conversation on another
  CLI (Codex, Gemini, NanoGPT) is refused with `provider_unsupported`. It runs in an empty directory of its own (`guestSessionDir`, made through
  `preparePortablePaths`, so it works on a remote engine) and its permission requests are refused in `Inbox.decide`
  without an item. Raw terminal input into an Operator session is the owner's only. Requests are listed by sender, so `GET /operator` gives a person their own
  (`OperatorChannel.readOnly`). The Operator's sessions are seen by owners and admins only
  (`canSeeOperatorSessions`: REST, WebSocket events and terminal, the member profile). Capacity (1) counts the guest
  conversations only (`Admission.memberLoad`): the owner's never waits; a guest conversation closes after
  `OPERATOR_GUEST_IDLE_CLOSE_MINUTES` (5) idle. No machine-dependent part is affected.
  (PM-1045: the app starts no Operator session any more, so these Operator guest conversations are history; the
  project manager's follow below. Old Operator sessions and events stay readable.)
  **The project manager has the same guest conversations (PM-1080, PM-1023 K3b).** One rule decides who has them,
  `hasGuestConversations(config, member)` in `packages/shared/src/config/project-manager.ts`: the selected project
  manager (`coordinationMemberOf`); the Operator lost it with PM-1045. The route (`nominalMessagePlace`, via
  `managerConversationOf`; the `operatorConversationOf` alias is gone), the session start
  (`message-starts.ts`), the write guard (`prepareSessionChat`), the message wait and the prompt all ask it instead of
  `isOperator`. A `with` conversation of any project manager stays restricted even when it is no longer the selected one
  (`guestOfConversation`, fail closed): `ToolCaller.callerWithRequest` lets it call `OPERATOR_GUEST_TOOLS` only (no new
  tool; the refusal is the same `operator_owner_only`, the feedback tools and the lessons path ask
  `assertNotManagerGuest`), the session is `teamToolsOnly` on Claude Code (another CLI is `provider_unsupported`), runs in
  `manager-guests/<project>/<handle>` under the engine home (`guestSessionDir(…, 'manager')`, apart from the Operator's
  `operator-guests`), and closes after the same idle time. The `with` conversation counts toward the PM's one shared
  general conversation capacity; the owners' conversation and the PM's operations are unchanged (a PM request opens only
  from the owner's own-login message). The Operator's capacity rule (`memberQueueStartLimits`) is unchanged.
  Such a conversation is seen by owners and admins only, like the Operator's sessions (`Sessions.isRestrictedSession`:
  REST detail, websocket events, terminal); the person's own view is the corner (`ProjectManagerCorner`, read only).
- **Owner requests** (migration 47, `OperatorRequests` in `services/operator/requests.ts`). A request opens when an
  owner's message, or the owner's answer to the Operator's question, is delivered into its session
  (`MessageService.markRecipientDelivered`); `quote` is the first 280 characters, line breaks as spaces. It closes on
  the session's `idle` or `ended` (the listener is registered before the delivery's own idle listener, so the next
  batch opens a new request), when a newer one opens, or after `OPERATOR_REQUEST_TTL_MS` (30 minutes, checked when it
  is looked up).
- **Write guard** (`ToolCaller.caller(ctx, tool)`, `mcp/caller.ts`). The Operator calls the reading tools (`OPERATOR_READ_TOOLS`)
  at any time; every other tool needs an open request (`operator_no_request` 403), and the decisions of other members
  and hand-overs, and `publish_task_branch` (publishing outside) (`OPERATOR_NEVER_TOOLS`) are never its
  (`operator_never` 403). The guard hands the request it found on to the step log, so a request expiring between the
  two cannot leave a write without its step. Its `ask_human` goes to the owners
  only. Rules live in the one place `caller`; a new tool must name itself there.
- **Step log** (`operator_steps`, `OperatorSteps.record`). One tool call is one step of the open request, done or
  refused (`update_task`: `task_move` > `task_labels` > `task_priority` > `task_update`; `create_task`: `task_create`;
  `send_message` to anyone but an owner: `message`; `attach_file`, `delete_attachment` and `link_pull_request` are
  `task_update`). A move that waits for a human's approval is `awaiting_approval`. A message sent during a request
  carries `TeamMessage.operatorRequest`. `GET /api/projects/:key/operator` returns `OperatorChannel` (the manager's
  channel plus the last 50 requests with their steps, the newest last) to a person's own login (the owners' requests
  to an owner, their own to anyone else; PM-475); no new WebSocket event.

- **Operations and approvals** (PM-464, `services/operator/actions.ts`). `operate` and `start_task` are Operator-only
  MCP tools and need an open owner request. Configuration previews reuse the member service's draft mutations;
  `operatorConfigVerdict` chooses immediate execution, an owner approval item, or refusal. Configuration commits
  recheck the verdict and the approved change rows under the project's configuration lock. Approval decisions
  run before inbox closure, require an owner's own login, and are serialized per inbox item. Independent edits
  preserve proposals; changed rows, ended or restarted sessions, and changed pause identities mark them stale
  (`operator_approval_stale` 409). Stale items remain open with only `dismiss`. Configuration commits, session
  ends and pause changes proactively recheck proposals through `BackgroundTasks`, without delaying subsequent
  event listeners; projects without pending proposals skip this work. Approved/rejected/stale results update the existing step
  and record a system message without waking the Operator. Configuration history reads `Projectman-Operator`,
  `Projectman-Request` and `Projectman-Approved-By` trailers, including reverts. Runtime operations reuse session
  stop and pause/resume; pause freshness is checked inside the existing admission lock.
  The Operator's Start follows the person's prerequisite override and AI label-setter path, while a fix-limit
  hold is always refused. When the configured temporary-worker policy permits a hire, Start hires as the system,
  sponsored by the requesting owner, and names the temporary member in its result and step. Permanent hires
  remain approval operations.

- **Targeted role configuration (PM-746).** `get_role_configuration` reads one built-in role in the Operator's
  owner general conversation without an open request. It returns the version, stored override (or `null`) and
  effective full bundle from one configuration load, without truncating instructions or writing a request or step.
  Operator `config_patch.roleOverrides` replaces only named roles; `null` resets one role and an empty map is a
  no-op. `prepareOperatorConfigPatch` in shared expands these edits against the current configuration/version
  for preview and execution; the ordinary REST PATCH and web settings still replace the full map. Stored
  operations, agreement recommendations and waiver attribution retain the original targeted patch. Replay
  preserves unrelated edits, compares the actual approval rows again under the configuration lock, and rejects
  a race with `config_conflict`. Legacy pending map-deletion previews whose rows differ become stale and allow
  dismissal only. No migration or machine-dependent operation is added: configuration and locks stay on the
  server; the existing team-tools relay carries the read and patch for remote engines.

- **Targeted label edit (PM-880).** Operator `config_patch.labels` is a map keyed by label id with `name`,
  `color` and `meaning` (`null` removes the color or meaning); no other label field is editable this way. A label
  without a definition is added (its name defaults to its id). `prepareOperatorConfigPatch` merges the entries into
  the current `pipeline.labels` (or the patch's own `pipeline`) before preview and execution, so stages, columns,
  gates and the other labels stay unchanged. The rows are the ordinary `label` rows at the `approval` level, with
  the old and new value. Same boundary as the role patch: configuration stays on the server, nothing
  machine-dependent is added.

- **System signals** (PM-476, migration 50, `services/operator/signals.ts`). Provider/engine outages,
  cards whose `TaskWaits` reason is `nobody`, input stalls and working sessions silent for 30 minutes
  create one signal per unresolved case. A 60-second sweep and domain events reconcile the sources.
  The sweep checks `WorkOutages.activeIds` only after its first evaluation (`null` means not yet observed),
  so startup card events cannot resolve an outage before provider checks finish. An acknowledged alert followed by a restart cannot
  leave a recovered outage signal unresolved and suppress the next episode of the same outage id.
  Admission persists refused `operator_signals` starts; notices enter the Operator's general conversation
  as projectman input, without a team message or an owner request. A persisted `delivered_at` keeps the
  15-minute project wake interval across restarts. Delivered signals become open when presented or when
  the turn ends; startup recovers delivered pending rows. Undelivered rows never appear in REST or WS.
  `send_message` may present a delivered signal to owners without a request; question screening and
  signal triage are standing duties, while other writes retain the request or signal-step guard.
  Owner acceptance records a visible message and the signal decision atomically,
  and its delivery opens the usual owner request. Owner dismissal suppresses repeats until resolution.
  Signal WS events reach owners only. This adds no machine-dependent part: observation, storage and
  admission stay on the server, and notice delivery uses the existing engine session boundary.
  Five board kinds (PM-547, migration 56) join the four, raised and closed by the same sweep from
  `OperatorSignals.boardCases` (`pending()` rechecks a signal against it before waking the Operator):
  `idle` (`idle:<task>:<stage>`; a work or step card whose `TaskWaits` reason is `assignee`, or `queued`
  with an AI step owner, held by an AI member who is not on leave, with no activity for
  `OPERATOR_IDLE_MINUTES` = 30 since the later of `wait.since` and the card's latest session activity),
  `merge_waiting` (`merge_waiting:<task>`; a `requested` merge an AI merger has not started for
  `OPERATOR_MERGE_WAIT_MINUTES` = 30), `merge_blocked` (`merge_blocked:<task>`; a `failed` or `blocked`
  merge with an AI merger, at once; a person as merger gets the inbox item instead), `unreleased`
  (`unreleased:<base>`; `ReleaseService.unreleased`, from the stored merges and the latest live release or
  the running commit, without git or an engine; work merged for `OPERATOR_UNRELEASED_HOURS` = 24 and no
  open release) and `ready_waiting` (`ready_waiting:<card keys>`; startable cards in later queue stages ready for a work stage
  whose AI owner is free, with the parallel AI limit not reached; "free" is admission's `freeDevelopers`
  (not on leave, not temporary, under its capacity, provider not on hold, no start waiting for them) and a
  connected engine; raised at once, delivered only after the stall (the first sweep that found a case, or the
  latest session start of those stages' AI owners on a card, whichever is later; memory only, so a restart
  starts it over) lasted `OPERATOR_READY_WAITING_MINUTES` = 10 without a break, so a further card that
  becomes startable does not restart it; silently closed if it ends before). After `OPERATOR_READY_STALL_OWNER_MINUTES` = 20
  more, the owners get one `work_stalled` inbox alert per stall (cards, free members, and the not-free AI
  owners with `leave`, `provider_hold`, `engine_offline` or `busy`), withdrawn when the stall ends. `idle`, `merge_waiting` and `ready_waiting` do not exist while AI is off or the
  team is paused. All data comes from the server's database and configuration: no machine-dependent part.
  `startableCards` shares the pull rules without the urgent or focus filter: no assignee, open prerequisite,
  holding label, refinement, open subtask or unmet gate. The subject lists all startable card keys in numeric
  order. The latest dismissed signal acknowledges its subject cards when their stage entry (or creation)
  is no later than its decision, even after resolution or capacity changes. No case exists when all are
  acknowledged; a new card or re-entry opens a case for the full set. The old `ready_waiting` case resolves
  on the first sweep. The Operator may use `dismiss_signal { signal_id, note }` without an owner request
  at every watch level, only for a delivered, unpresented, still valid ready_waiting signal and outside
  guest conversations. It stores the reason in `decision_note` (migration 59, outside the DTO) and publishes
  the decision to owners. Presented signals remain theirs to decide. Wake facts contain `cards`, `new_cards`
  (unacknowledged at wake time), and `last_dismissed` with the time, actor, note and cards.

  **Question screening (PM-556, PM-558).** An AI member's `ask_human` question (the project manager's too, not
  the Operator's own and not a human's) is created in the inbox state `screening` with
  `payload.screening.until` = now + `QUESTION_SCREENING_MINUTES` (10); no person sees it. `QuestionScreening`
  (`core/inbox`) synchronizes screened questions into the member queue and wakes its driver
  (PM-885). The runtime member queue driver delivers them through admission and `MessageDelivery`
  from `runtime/delivery`; `ScreeningEngineState` reports the member's engine availability.
  It wakes the Operator like `operator_signals`
  (deferred start kind `question_screening`, no capacity, the Operator's general conversation, one notice with a
  JSON line per question; `deliveredAt` is written after the first input). The Operator settles each question with
  `screen_question` (an Operator-only tool, not in guest conversations, no owner request, no `OPERATOR_NEVER_TOOLS`
  entry): `answered` and `forwarded` resolve the item (`operator_answered`, `operator_forwarded`) and carry the
  answer or the forward through `Messaging` (`answer` with an AI actor and the re-ask hint; `forwardQuestion`: an
  `action` message with origin `question_forward` to the recipient, which wakes it without a card role, and an
  `info` message to the asker); `moot` cancels it (`operator_moot`); `decision` and `todo` release it to the
  people (`InboxService.releaseScreened`; a todo's options become Done and Cannot do it, and Cannot do it needs
  a reason). Every outcome writes a `question_screened` timeline event. The fallback gives the question to the
  people: at once (`unavailable`: no Operator, AI off, the Operator on leave, the team paused, admission defers
  the start or it throws) or when `until` passes (`timeout`, `QuestionScreening.sweep`, a 30-second timer and a
  startup sweep); `screen_question` then answers `question_not_screening`, except `moot`. An asker may ask a
  settled question again with `ask_human` `reask_of` and `reask_reason`, once per question; the new question is
  `open` and carries `payload.unscreened`. `GET /api/projects/:key/inbox/screened?since=` (owner, admin) lists the
  latest 20 screened questions and the count of today's. Only database rows and the existing admission and
  messaging paths: no machine-dependent part.

**Remote engine:** no machine-dependent part: pure rules, a template, configuration and database rows (requests and
steps live on the server; the tool calls already cross the MCP boundary); the inventory below does not change.

## Pause and resume (PM-219, part of PM-198)

The team's work can be paused so that every session stops at a safe point and goes on from there (a quicker
deploy; decision 32). The runner's part is `SessionRunner.pause` / `forcePause` / `release` (PM-218,
[PROVIDERS.md](PROVIDERS.md)); `PauseService` (`runtime/sessions`) is the team's.

- **Scope and storage.** A pause covers the instance or one project, never one member (decision 32). It is a row of
  `pauses` (migration 31; at most one open per scope), and `session_pauses` holds one open row for every session
  it stops (point, tool, what it still waits for, `needs_restart`), so it survives a restart. `Session.pause`
  carries that row, `BoardView.pause` the open pauses of the project (`ProjectPauseView`; a client reads them like any member),
  `pause_changed` and `session_upserted` keep the app current. The rules are pure and in
  `packages/shared/src/domain/pause.ts` (`isWorkPaused`, `pauseStateOf`). The old `canManageInstancePause`
  rule is gone (PM-1068): `canManageProviderKeys` is the host owner's alone.
- **Pausing.** Under the admission lock only the rows and the timeline event (`team_paused`; project-level,
  internal) are written; then every running session gets `runner.pause(id, { forceAfterMs })`. The pause is
  `pausing` until every session has a point, then `paused`. `force` writes the deadline as now and cuts the
  rest with one Esc. A session that starts during a pause (a race) is stopped too.
- **What waits.** `assertNotPaused` in admission (right after `assertAiEnabled`) makes `team_paused` a deferrable
  refusal: hand-overs, work starts, refinement rounds, message wake-ups and the loop notice go to
  `deferred_starts` and are retried on resume. A person's Start, a write into a stopped session and the PM-170
  restart are refused with 409 (nothing is recorded). A message to a running paused session is stored and
  held in `MessageDelivery.pauseHeld` (in memory); the restart for new permissions, the PM-170 restart and the
  compaction do not stop a paused session. A fix limit's `reassign` decision is left until resume
  (`FixLimitWatch.afterResume`), a refinement turn that the pause cut is not "stalled", and a scheduled run
  is skipped with `team_paused` and made up once on resume (`ScheduleService.catchUp`, from the pause's own times).
- **Resuming.** Closing the row and the timeline event (`team_resumed`) are under the lock, the rest after it.
  A session goes on only when its project is no longer paused by anything (the instance's and the project's
  pauses are independent). A live session is released (`runner.release`), with a nudge when it was cut in the middle
  of a turn (`NUDGE_POINTS`: the tool ran, the call did not run, or the tool was interrupted; text from
  `ContextPackBuilder.pauseNudge`), then gets its held messages and its idle work back (`sessions.afterPause`). A
  session whose process is gone, stopped at a `RESTART_POINTS` point, is started again with `--resume`
  (`ensureSession` with `nudge`, which stands before the waiting messages); one that stopped idle is not, and
  the member is woken for a message that came meanwhile (`Messaging.wakeWaiting`). A row with no point (the
  process was cut before it answered) is started again like a mid-turn one, with the `interrupted` nudge. When
  the card holds the messages (the fix limit, a refinement turn) or the start fails, the nudge is stored as a
  `system` message instead (`Messaging.holdsMessagesOf`) and the usual path carries on. Last come `fixLimit.afterResume`, `schedules.catchUp` and `admission.retryDeferred`. A deliberate stop
  closes the session's row: it is not restarted.
- **Stopping the server.** Every stop pauses first (`ShutdownOptions.pause`, before `close`, because the hooks
  and the MCP reach the server over its HTTP and Fastify's `close` answers 503): `pauseForShutdown` opens an
  instance pause of kind `shutdown` (source `system`; it writes no timeline event) and waits for the sessions up
  to `PROJECTMAN_SHUTDOWN_PAUSE_MS` (default 60 s, 0 turns it off) plus 10 s, then the server closes as before.
  The runner cuts a session at the shutdown pause's own deadline; at the same time the sessions of a longer
  pause that was open before are cut with one Esc (`forcePause`), so the stop waits for none of them longer.
  After the start `resumeAfterStartup` (in the background, after `restoreDeferred`) ends the `shutdown`
  pauses, so the sessions start again with a nudge that says their process is new; a pause a person made stays.
  A crash and a second Ctrl-C after 3 s do not pause. The service manager must allow the shutdown
  pause to finish before terminating child sessions.
- **Access.** `GET` of a project's pause: an internal member; changing it: admin or owner. The instance's pause
  may be seen by anyone who is internal in some project (and by the host owner with no project of their own),
  with only the sessions of the viewer's projects, and changed by the host owner alone (`domain.instanceOwner`,
  PM-1058). The pause itself acts on the whole instance, projects of other owners included; an integrator key of
  the host owner is bound only in the projects its holder owns (`assertCredential`).
- **Control socket.** `PROJECTMAN_HOME/control.sock` (mode 0600; `apps/server/src/control`, not opened for a standby
  copy) takes one JSON line per request (`ControlRequest`: `pause`, `resume`, `force`, `status`) and answers one
  (`ControlResponse`); the requests are the instance's, source `control`, with no person behind them, and there is
  no login: whoever may open the file may pause the team, like whoever may stop the service. A file nobody
  answers on is replaced; one somebody answers on is left alone and logged. The members' sessions may not touch it
  (`sensitivePaths`). `npm run control -- pause --wait | resume | force | status`
  (`scripts/control`) is its client ([DEPLOY.md](DEPLOY.md)). Since PM-491 it also takes `release_next`,
  `release_claim` and `release_report`, the release watcher's operations (see "Release of the instance"), and
  since PM-749 `release_get` (one release in any state) and `engine_status` (the engine registry's id, online,
  version and last seen; `[]` in single mode). `sendControlRequest(socketPath, request, options)`
  (`control/client.ts`) is the shared one-request client (30 s, 64 KiB answers, never retried), and the packaged
  `control/cli.js` is the cloud container's relay of the admin channel. Since PM-752 it takes
  `release_deploy_get`, `release_deploy_begin` and `release_deploy_change` too (hybrid release, see below); a
  request or an answer stays within the relay's 16 KiB / 64 KiB limits. An ordinary `resume` (control socket or
  admin) refuses to end the pause a deployment owns (`release_pause_conflict`).

## Release of the instance (PM-491, part of PM-387)

The release flow of projectman's own instance, on the server; the watcher that deploys (PM-493) and the
screens (PM-492) come in their own cards.

- **Target.** `PROJECTMAN_RELEASE_TARGET=<project key>/<repository>` (read in `index.ts`, `parseReleaseTarget`;
  `DomainOptions.releaseTarget`) names the project and repository that are the instance itself. Without it
  every release operation is refused (`release_not_configured`). `appVersion` (`resolveAppVersion`) is the
  commit the server runs; the control socket tells it in every answer, so the watcher knows a restart happened.
- **Record.** `releases` (migration 51, `db/releases.ts`, contract `packages/shared/src/domain/release.ts`):
  `proposed` → `approved` → `deploying` → `live` → `published`, or `rejected` / `failed`. A partial unique
  index (`releases_open`) allows one release in `proposed`, `approved` or `deploying` for a project. A release has
  a theme card (kind `theme`); its timeline holds `release_changed` for every change, and `ReleaseService`
  (`services/releases/releases.ts`) is the only writer.
- **Contents.** Only a commit a recorded merge of a card left on the default branch can be released
  (`task_merges`, state `merged`; `release_commit_unknown` otherwise). The cards are those whose merge commit is
  an ancestor of the release commit and not of the base: the last release that went live, else the running
  version when that is a commit id. The ancestry questions go to the engine that holds the repository
  (`BranchMerger.isAncestor`, the head through `BranchMerger.prepare`).
- **Proposal.** `propose_release` (MCP) is for the holder of the `deployment` duty. It makes the theme card, the
  record and an inbox item of kind `release` for the holders of the `release_approval` duty (else the owners),
  and `preview: true` records nothing. The Devops session ends after the call.
- **Approval.** Only a person decides, in the Rád vár: AI members (`ai_approval_forbidden`) and integrator keys
  (`owner_approval_required`) cannot, and the owner bypass does not apply to a `release` item, so only its
  assignees can. A rejection ends the release card and may carry a reason (`note` of `release_changed`); a
  second decision is `inbox_item_closed`. The release card is a theme that the domain closes without a person
  (`TaskService.closeThemeBySystem`, architect's decision): on reject, on failure and on publishing alike it
  ends `cancelled`, because a theme is never `done` (reopening goes from `cancelled` only); the outcome is the
  release record and its `release_changed` events.
- **Watcher.** `release_next` returns the oldest release that is approved, deploying, or live without a tag.
  `release_claim` (approved → deploying) records `previousCommit`, where a rollback goes. `release_report` takes
  `live` (only while the server runs the release's commit), `failed` (cancels the card, alert `release_failed`
  to the approvers), `published` (tag and URL; the card is closed) or `publish_failed` (alert once). An
  operation out of order is `release_state_conflict`. The watcher's operations act on the target project only
  (PM-749: `release_get`, `release_claim` and `release_report` all check that the release's project and
  repository equal the target exactly, else `release_not_configured`; an unknown id is the usual not-found).
  `release_get` returns terminal states too, so a lost claim or report answer can be reconciled. On the cloud
  machine the target comes from the optional `releaseTarget` of the cloud configuration (`cloud.env`).
- **Hybrid release (PM-752, server side; the coordinator and the screens are PM-751).** A release goes to two
  targets: the cloud server and one remote engine. `PROJECTMAN_RELEASE_ENGINE_ID` (`eng_…`, never `local`) and
  `PROJECTMAN_RELEASE_TARGET_HASH` (SHA-256 of the credential-free target description, computed by the
  coordinator) are read together in `index.ts` (a lone value stops the start) and written into `cloud.env` by the
  optional `hybrid` of the cloud configuration (`scripts/cloud/machine.ts`, `withHybridTarget`). On such an
  instance the legacy single-target `release_claim` / `release_report` are refused
  (`release_protocol_unavailable`): a release is claimed by `release_deploy_begin` only.
  - **Attempt.** `release_deployments` (migration 75, `db/release-deployments.ts`, contract `HybridDeployment` in
    `packages/shared`) holds one document per release; its `phase`, `maintenance` and `revision` are repeated in
    their own columns, and a unique partial index keeps one active deployment on the instance. `begin` claims the
    approved release and stores the attempt with the previous image, the engine's version and the schema the
    server observed itself; every change is a compare-and-swap on `revision` and is deduplicated by its request
    id (`release_deployment_requests`: the same id with the same payload answers the stored view, another payload
    is `release_deployment_conflict`).
  - **Phases.** `preparing` → `prepared` (the artifact of the release commit is bound once;
    `release_artifact_changed`) → `quiescing` (an owned instance pause and the maintenance bit, saved with the
    pause row in one transaction) → `switching` (only when the drain check says ready, else `release_not_drained`)
    → `live` → `published`. A failure before the pause (`preparing`, `prepared`) ends the attempt as `failed`
    with no fence. From the pause on, a failure with a verified rollback is `failed` (the fence stays until the
    owned `resume`); one without it, and the coordinator's `recovery` change (from `quiescing`, `switching` or a
    still fenced `live`), is `recovery_required`: the fence stays, the release stays `deploying` (or `live`), the
    approvers get the `release_failed` alert once, and no `live`, `failed` or `resume` report of the coordinator
    moves it again (`release_recovery_required`). The release's own change and the deployment write commit in one
    transaction, and a new proposal is refused while a deployment holds the instance.
  - **Fence.** `ReleaseWorkGate` (`services/releases/work-gate.ts`) is the only admission: the merge queue, the
    document-write queue, the full-test queue and the screenshot runs ask it for a permit before they start a
    root piece of work, and are refused while the maintenance bit is set. The bit is read live from the
    database, so it holds from the first query after a restart; a continuation of work that began earlier (a
    child permit) is let through and counted. Sessions are held by the owned pause. The drain check counts the
    permits, the running rows without a permit (uncertain: an earlier process's run) and the unstopped sessions.
  - **Result gates.** `live`, a rollback (`failed` with `rolledBack`) and `resume` are accepted only when both
    recorded targets show the expected program: the cloud's `appVersion` and the engine registry's online state
    and version, plus the reported image (`release_target_mismatch`, `release_engine_mismatch`, `engine_offline`).
  - **Bootstrap.** The first hybrid release cannot be driven by a build that lacks this protocol.

Does this work on a remote engine? The records, the approval and the socket are the server's. Only
`BranchMerger.isAncestor` / `prepare` cross the server/engine boundary, as they do for the merge (PM-452); the
instance's repository is on the engine the project uses (`LOCAL_ENGINE_ID` for now). Deploying, restarting and
publishing are the watcher's (PM-493) and act on the machine the server runs on; the control socket stays local.
For the hybrid release (PM-752) the cloud server owns the attempt, the fence and the checks, and learns the
engine's program only from its registry (id, online, version), which is the engine's own report. Switching the
engine's program and moving the artifact are the coordinator's (PM-751) and cross the boundary through the
protected admin channel; nothing in the server's part assumes that the engine shares its host.

## The machine and the sessions (PM-320, part of PM-300)

The server shows how loaded the machine is, what each running session's process tree uses, and which
processes a finished session left behind (orphans), and the owner may stop those. Server side only here; the
display is PM-322.

- **Probe.** `MachineProbe` (`apps/server/src/contracts/machine.ts`) is the only thing that touches the
  operating system: `machine()` (processor counters, memory, swap, pressure), `processes()` (one `ps -axww -o
pid=,ppid=,pgid=,uid=,rss=,%cpu=,time=,lstart=,args=` line per process), `envValues(pids, names)` and
  `signal(pid, 'SIGTERM'|'SIGKILL')`. The real one (`apps/server/src/machine`) runs `vm_stat`, `sysctl`, `ps` with
  the shared exec helper (`apps/server/src/exec`), a 5 s limit (SIGTERM, then SIGKILL 5 s later) and `LC_ALL=C`
  on macOS, and reads `/proc` on Linux; elsewhere the process list is
  unavailable (`null`) and the page says so. A reading that fails is `null`, never an error. The probe
  never signals a pid below 2.
- **Identity.** A process is its pid together with its start time (`lstart`), because a pid is reused. Every
  signal is preceded by a check of both against a fresh process list.
- **Marks.** The runner puts `PROJECTMAN_SESSION_ID` and `PROJECTMAN_INSTANCE=<tag>` in the environment of
  every session; the tag is the first 16 hex digits of `sha256(realpath(PROJECTMAN_HOME))`, computed in
  `app.ts` and given to the runner and to the domain. A process of a session survives a detach (`setsid`,
  `nohup`) with its environment, so the marks follow it. (A session that is not started by this build has no
  tag: its leftovers are not recognised.)
- **Classification** (`runtime/watchers`, `MachineMonitor`). From one process list: the
  tree under each running session's CLI is that session's; the server's own tree is `projectman`; an orphan is a
  root that has **both** marks (this instance's tag and a `ses_` session id), belongs to the server's user, lies
  outside every live tree and the server's tree, is not an ancestor of the server, and whose parent is not a
  candidate itself. Its session must not run, or the root must have started **before** the session's current CLI
  (a root that started with or after the CLI is that live session's detached child). Everything else is
  `others`, grouped by short name, with a row only when it uses at least 5 % of a core or 500 MB (8 rows).
- **Rounds** are driven by demand, never by a permanent timer: while a request with `?panel=1` came within
  15 s, every 5 s; while any request came within 45 s, every 15 s; else none. One round at a time, shared by
  the requests that arrive during it; the first round reads the processor twice 500 ms apart; a request
  waits for a round at most 3 s. The load of a process is its CPU time between two rounds (not the decayed
  `%cpu` of `ps`, which only the first round uses). `closedSessions` is `countResumable()` cached for 30 s.
- **Stopping** (`MachineMonitor.stopOrphans`, one request at a time): each item is looked up in a fresh list
  with a fresh environment, so a stale panel can never stop an unrelated process. Outcomes: `stopped`, `gone`
  (no such process, or another one with the same pid), `refused` (not an orphan of this instance now),
  `failed`. SIGTERM goes to the root and its own descendants, then the list is polled every 250 ms for 3 s,
  SIGKILL goes to what lives, and 1 s later the root decides `stopped` or `failed`. A process that stopped
  leaves the last sample at once. The log line has the user, pid, short name, session and outcome, never the
  command line.
- **Access.** `GET /api/machine[?panel=1]` and `POST /api/machine/orphans/stop` are for the host owner
  alone (`domain.instanceOwner` = `AuthService.instanceOwner`: the first account, whatever its project
  memberships; the same person as `Me.hostOwner`, PM-1058); `Me.instanceOwner` tells the web.
  The command lines of the orphans (`OrphanProcessRow.command`, 160 characters at most) leave the server only
  here; a session's top processes carry the short name only.
- **Screenshots.** `PROJECTMAN_MACHINE_FIXTURE=<json>` (`npm run shots -- … --machine <file>`,
  [SCREENSHOTS.md](SCREENSHOTS.md)) swaps the probe for fixed data that never signals; the server warns at start.

## Card mover and hand-on requests (PM-439)

`team.cardMover` selects the worker (default), project manager, or a named human who moves
cards forward. `packages/shared/src/config/card-mover.ts` owns the decision: only AI and system
forward moves from work, step or release stages request a hand-on. Queue starts, backward moves,
refinement (`step` with the `task_breakdown` duty) and human moves retain their existing rules.
Unresolvable movers fall back to moving.
Human gate approvals take precedence and complete the move through the existing approval path.

`TaskMoves` records one request per card in `task_hand_ons` (migration 45); `TaskStore` exposes it
as `Task.handOn`. Repeated requests for the same source, target and mover do nothing. Replacement
cancels the old inbox item. A human mover gets a `hand_on` inbox item; a project manager gets a
stored system action message through the existing general conversation route. The internal
`task_hand_on_requested` timeline event records the requester and mover. Uncommitted work refuses
the request immediately; the review pin is created only by the actual move.

## Merger setting (PM-470, part of PM-448)

Who merges a card's approved work into the default branch is the project's setting, never the
code's (decisions 47 and 48). `team.merger` is `code_reviewer` (the owner of the code review stage
who reviewed the card), `developer` (the assignee) or `member` (a named member); absent, `defaultMerger`
picks the code reviewer when a code review stage comes before the merge target, else the developer.
`RepoConfig.requireMerge` says whether a repository's cards must be merged before they enter the merge
target; absent, `requiresMerge` decides (merge unless `fullTestAtMerge`, an outside integrator merging; the
owner switches the PM project over as PM-386 plans). The merge target is the first release stage, else the done stage. The pure rules
(`requiresMerge`, `mergeTargetOf`, `defaultMerger`, `mergerOf`, `mergeRepoOf`, `cardMerger`,
`mergeReadiness`, `moveMerge`, `unresolvedMerger`) live in `packages/shared/src/config/merger.ts`.
The order of a move (PM-484): the merge waits for the same approval the move waits for (`mergeReadiness`
needs the gate to hold), so the move's gates speak first. `moveMerge` says, for a move, `none` (no merge
due), `due` (the gates hold: `TaskMoves.prepareMove` runs `Merges.checkGate`, and `PreparedMove.mergeChecked`
records that it passed) or `after_gates` (an approval or condition is missing: `gate_blocked` or the
approval request comes first, carrying `GateRequestPayload.merge`, the merger and base the approval is
followed by). `move()` refuses a merge-requiring move that was not checked (`task_not_merged`), which
closes the race where the approval is put on between the preparation and the write; `decide` asks for the
merge instead of moving in that case. Every path (moves, hand-on, approval decision, `update`, board drop,
group drop, AutoAdvance through `moveToStage`) goes through `prepareMove`.
The invariant `merger_unresolved` is tolerated on load (`TOLERATED_ON_LOAD`) but a save cannot introduce it;
the config migration `addMerger` writes the default merger into a valid configuration that has none.
`PATCH /config` takes `merger` and `repoMerge` (`requireMerge: null` clears the explicit value; an
unknown repository is `unknown_repo`). No machine-dependent part is touched: this is configuration and
pure rules; the merge itself (PM-452) runs on the engine through `BranchMerger`.

Inbox resolution checks access and attempts the move as the resolving human before closing the
item. Refused moves leave it open. Actual movement clears the request and resolves the item if
it reaches the requested stage, otherwise cancels it; cancellation clears it too. Configuration
changes redirect outstanding requests while retaining the original requester. Selecting worker
retries the requested move as the system, rechecking gates and logging refusal.

No machine-dependent part is added: configuration, SQLite and domain state stay on the server;
remote engines receive the existing messages and context packs through the existing boundary.

## GitHub

Tasks live in our database (decision 9); GitHub is used for pull requests, reviews, checks
and merges. projectman reads from GitHub: it polls the PRs linked to tasks, keeps the
`pr-merged` label, clears `pr_updated` labels when new commits land, and attributes PR authors
to members (`githubLogin`). See [GITHUB.md](GITHUB.md).

GitHub Actions (PM-900, PM-907) is a second, narrower client next to the pull-request service:
`createGithubActionsClient` (`services/github/actions.ts`, contract `GithubActionsClient`) dispatches the
`merge-check.yml` workflow, finds and follows its run, lists its jobs, reads job logs and cancels a run, all
through `gh api` with the machine's own login. It is used only by the engine's merge-check executor
(`full-test/github-actions.ts`); a test passes its own client as `modules.githubActions`.
