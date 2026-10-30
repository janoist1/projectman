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
| [modules/](modules/)                                                       | one module's detailed behaviour (index under "Module documents")    |
| [MACHINE-DEPENDENT.md](MACHINE-DEPENDENT.md)                               | inventory of machine-dependent parts and the remote-engine answers  |
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
   `packages/templates/src/locales/hu.ts`, `deploy/mac/menubar/Resources/hu.lproj/Localizable.strings`). Data written by
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
  address is always `<handle>@<domain>` and follows the new handle (see "E-mail"). Humans have an **access level** (`owner`, `admin`, `developer`, `client`,
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
  access for any other card, or the selected PM when `team.projectManagerLifecycle` lists `reopen`;
  the PM's other lifecycle rights, reassigning and cancelling (also marking a started card as a duplicate),
  follow the same setting through `lifecycleAllowed`, PM-1040, PM-1098). It is in no stage (it carries the first stage's id because the field is
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
  only log and preserve the hook decision; the prompt tells the member to run `npm ci` in its
  worktree when node_modules is missing or older than the lockfile (a routine step, PM-1112).
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
  Tool definitions may declare an optional audience of roles (project manager,
  named merger) or duties (`mcp/kit.ts`, PM-973). `runtime/sessions` derives the member audience
  from the current project configuration for every stateless MCP request; registration keeps
  tools with no audience or any matching role/duty. Since decision 66 (PM-1076) there is no Operator
  audience that sees everything. This is list visibility only: handlers remain the permission authority. Tools whose access
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
  `work_start` spec): honored as `mayOverridePrerequisites` allows (PM-1099): a person, the
  coordinator acting on the owner's request, or the project manager acting directly when
  `team.prerequisiteOverride` is `people_and_project_manager` (default `people`); the project
  manager's work-entry gate (`assertProjectManagerWorkEntry`) still stops without the flag, and a
  card another AI member moves waits. Cards in a
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
  compared with each developer's `complexityLimit` (a temp worker's is the project's `team.limits.tempWorkers.maxPoints`, default 5, `tempMaxPointsOf`). Points are set by
  the project owners and by the holders of the duties in `team.complexitySetters` (PM-1097,
  `canSetComplexity`; default: requirements analysis and task breakdown). Among the free
  developers, optional `specialtyLabels` first restricts automatic assignment to cards carrying at
  least one matching label; explicit assignees remain unrestricted (PM-1038) unless the project sets
  `team.assigneeFit: automatic_and_ai` (PM-1136): then an AI actor's explicit assignee (`start_task`
  `assignee`, `reassign_task` and every update that changes the assignee, the coordinator's super actor
  included) must fit the card by the same predicate (`fitsCard`, via `assigneeFitRefusal` in `packages/shared`),
  or the call fails with `assignee_unfit` (`assertAssigneeFits`, `core/tasks/assignee-fit.ts`; details: member,
  reason, points, limit). It does not apply to people and their own Claude, to an unscored card, to a card the
  owners released to any developer, or when no developer of the work stage reaches the points. Among matching free
  developers whose limit reaches the points the one with the smallest limit wins (then the least
  loaded, then the team order), so a small card does not take the strongest developer; an unscored
  card goes the same way among all free developers. While every developer who reaches the points is
  busy or away, `startLocked` leaves the card in the work stage unassigned and the start waits as a
  `work_start` deferral (`startWaiting.reason` `senior_busy`, with `seniors`: the handles whose limit
  reaches the points); a person's Start gets a normal response with that wait. A card of up to the
  temp worker limit (`tempMaxPointsOf`, PM-1101) may go to a temp worker instead of waiting. The wait is the
  `senior_wait` kind of the obligation tracking (PM-1150, "Obligation tracking" below; the `senior_waits` table and
  its own sweep are gone): one row per card and wait, derived from the `senior_busy` deferral, subject
  `senior_busy@<since>`, nobody responsible, so the row keeps when the wait began, the question and (in the
  question's resolution) the answer over a restart. After `seniorWaitMinutes` (30) the 60 s obligation sweep asks
  the owners once (an inbox decision, `wait_for_senior` or `any_developer`); "any" lets the free non-temp
  developer with the largest limit take it. `SeniorDecisions` (`admission/senior-decisions.ts`) reads the answer
  for the start (`seniorWaitAnswerOf`), writes the `decided` event and retries the starts. A freed developer who
  reaches the points takes the card first (`retryDeferred` tries `senior_busy` deferrals first); when the card
  is assigned, moved, closed, its points change (`task_complexity_changed`) or the team's limits change, the
  next sweep ends the row and closes the question (`senior_took` when a developer who reaches the points took
  it, else `senior_wait_ended`; `seniorWaitEndReasonOf` in `packages/shared`). When no developer's limit
  reaches the points the card starts by the "any"
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
| [`core/tasks`](modules/core-tasks.md)             | Tasks, PR records, board state, involvement and card measures.              |
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
| `services/releases`                               | Release publication and the running version (PM-968, PM-969, PM-1113).      |
| `services/structure`                              | Repository structure descriptors, module sizes and card file placement.     |
| `services/github`                                 | GitHub synchronization, pull requests and publishing.                       |
| `services/obligations`                            | Open-step deadlines, one reminder and one integrator todo (PM-806).         |
| `services/feedback`                               | Feedback marks, screenshots and widget sessions.                            |
| `services/project-docs`                           | Operator document writes and decision candidates.                           |
| `services/schedules`                              | Scheduled member work.                                                      |
| `services/coordination`                           | Operator actions, signals, requests and project management.                 |
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

### Module documents

A module's detailed behaviour lives in its own file under [modules/](modules/), named after its id
(`core/member-queue` → `modules/core-member-queue.md`); this file keeps the overview.

- [`core/base`](modules/core-base.md) — domain context, events, the project change journal (PM-761)
- [`core/projects`](modules/core-projects.md), [`core/tasks`](modules/core-tasks.md),
  [`core/members`](modules/core-members.md), [`core/timeline`](modules/core-timeline.md),
  [`core/messages`](modules/core-messages.md), [`core/inbox`](modules/core-inbox.md),
  [`core/attachments`](modules/core-attachments.md)
- [`core/member-queue`](modules/core-member-queue.md) — the member queue (PM-894)
- [`runtime/sessions`](modules/runtime-sessions.md) — pause and resume, the control socket
- [`services/merges`](modules/services-merges.md) — merge, merge trains and the merge check (PM-452)
- [`services/coordination`](modules/services-coordination.md) — the Operator and the project manager's coordination tools
- [`services/super-operator`](modules/services-super-operator.md) — super mode: owner-bound operations, the
  external MCP endpoint, diagnostics
- [`services/releases`](modules/services-releases.md) — release publication and the running version
- [`scripts`](modules/scripts.md) — the heavy-run queue (PM-332)

Machine-dependent parts (local paths, processes, sockets, accounts, OS features) are inventoried in
[MACHINE-DEPENDENT.md](MACHINE-DEPENDENT.md).

The source of truth for file → module assignments is
[projectman.structure.yaml](../projectman.structure.yaml). Layers, targets and passes live in
[module-map.ts](../apps/server/test/architecture/module-map.ts), which reads server paths
from the YAML at load time.
The longest matching path wins; each declared path must exist and appear only once.
[dependencies.test.ts](../apps/server/test/architecture/dependencies.test.ts)
enforces the layer rules against all production TypeScript source files.
There are no dependency exceptions; new ones must not be added. Every module below
the assembly layer is sealed: cross-module imports use its target `index.ts` or an entry the
module map declares (`kernel/pure.ts`, PM-1130).
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

The inbox's `registerDecider(key, decide)` supplies merge, hand-on and Operator
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

The Operator slice (PM-605) lives in `services/coordination/`, with one entry point and
structural ports for sessions, admission, delivery, pauses and releases. Its six tools
(`get_project_state`, `operate`, `screen_question`, `dismiss_signal`, `start_task`, `start_member`) live in
`mcp/project-manager/`; signal decisions and manager/Operator channels register in `api/operator.ts`.
This module needs no Effect program: retries belong to admission, reply relay uses
`background.run`, and the 60-second signal sweep runs in `kernel/sweeps.ts`; assembly
(`assembly.ts`) declares the sweep list.

The top right corner (PM-1042, decision 65) belongs to the project manager. `GET routes.projectManager`
returns a `ProjectManagerCorner`: the manager's channel plus, for the viewer, the requests and steps, the
signals and the manager's queue; a person who is not an owner gets `readOnly` and no signals or queue. The web
queue view reads `routes.memberQueue` for the manager. The retired supervisor's grant is removed (PM-1113); Settings → Integrator manages only the
connected client's credentials. The Operator's own channel route is gone (PM-1045): the app has no Operator.

**No Operator member (decision 66, PM-1076).** A project has no `ai_operator` role and no member that holds it, and
a new project (template, `POST /projects`) gets none. The configuration migration `removeOperator`
(`config/migrations.ts`) removes the stored Operator member with its contacts, stage owners, role override and
temp-worker role (the temp role becomes `developer`), logs a warning and is idempotent; the old `addOperator` and
`fixOperator` migrations are gone, so nothing puts it back. The handle `operator` stays taken
(`RETIRED_OPERATOR_HANDLE`, `members.takenHandles`), because old events, messages and `operator_requests` /
`operator_steps` rows still name it; the web shows such a name as the raw handle. A connected Claude acts as its
key holder or as the issuer of an integrator queue item (PM-1074), and the project manager acts as the selected
coordinator (`coordinatorSuperActorOf`, `isCoordinatorSuperActor` in `config/operator-member.ts`). The Operator
tool surface (`operate`, knowledge, preferences, diagnostics) is the selected project manager's. The external MCP
tool names (`super_operate`, ...), `integrator_keys` and the old rows are unchanged.

Personal conversational style (PM-688) lives in `services/coordination/preferences.ts`.
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

Shared approved agreement and principles (PM-689) live in `services/coordination/knowledge.ts`.
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

The Operator's fixed approver (PM-691, 403 `operator_fixed`, `sessionApproverChangeRefusal`) is gone with the
Operator member (decision 66, PM-1076): every AI member keeps its session settings. Mixed mode/approver
patches are atomic. Starts, resumes, permission routing and the session header use the same effective rule.

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
pinned. The hand-over read is strict (PM-1110): a card whose source the hub knows but whose engine is not
connected is refused with `engine_offline` instead of being handed over with no pin, and the head read carries the
stage and assignee the card had; `move` refuses (`board_stale`) a card that changed since. A message's version takes
its commit from the recorded pin, and reads the branch only for a card with none. A move completed by a human approval (`decide`) is handed over the same way: uncommitted work leaves the
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
  so it is skipped when `PROJECTMAN_FULL_TEST_SANDBOX=1`; it requires a separate host run.
  The retired release watcher no longer provides an automatic deployment-time run (PM-1113).

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
`serverFullTest`. The merge step (`Merges`, [services/merges](modules/services-merges.md)) runs the command once on the merge result
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

## Housekeeping: worktrees of closed cards and free disk space (PM-243)

`WorktreeSweep` (at start and every 6 h, `DomainOptions.worktreeSweepMs`) goes over the done and cancelled cards
that have been closed for 3 days (`CLOSED_WORKTREE_KEEP_MS`) and have no running session, and removes the worktree
of each that is clean (`WorktreeManager.remove`, which keeps the branch; `ensureForTask` makes the worktree again if
the card restarts). A worktree with uncommitted changes is never removed: the owners get one `worktree_kept` alert
per closing of the card. What was removed and about how much space it freed goes to the server log only.
Since PM-1115 the sweep lists existing task worktrees and snapshot task keys by engine and repository,
skipping engines that do not hold the project. It reads only those cards, and checks the card and live sessions
again after status, immediately before worktree removal. Snapshot and leftover incoming refs use the same
three-day retention, skip active merges and are removed in batches of at most 100 task keys. No whole closed-card
history is scanned, and task branches in durable member clones remain available after snapshot cleanup.

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
`TeamLimits.obligationMinutes` minutes (5–1440, default 20, in `WAIVER_LIMITS`). Kinds in this card:
`merge`, `work`, `review_step` and `refinement_turn` (`fix_limit`, `start` and `senior_wait` follow in other cards).
Each kind has a source (`sources.ts`) that derives, from the task waits, the merge requests and the
refinement turn, which steps are open now; the sweep writes one row of `obligations` (migration 88, not
journaled) per card, kind, responsible and subject, and closes a row whose step ended.

**`senior_wait` (PM-1150).** The wait of a scored card for a developer whose limit reaches its points (see "The
complexity limit"). Its source (`senior-wait.ts`) is the first with no responsible (`responsible` is NULL in the
row and in `Obligation`/`ObligationRef`; the unique index reads it as ''): nobody holds the step, so there is no
reminder to send and no activity to wait for. A source may set its own `rungs` (here only `hand_over`, so the
clock goes from the deadline straight to the hand-over), `minutesOf` (`seniorWaitMinutes`, not
`obligationMinutes`), `pausable: false` (the pauses of the sweep do not apply) and `onClosed` (closes the question
and writes `senior_took` / `no_senior`). Its `handOver` may return `'settled'`: the source has done everything
itself (the owners' decision item and the `asked` event, or only a log line when the team has no owner), and the
generic code writes no `obligation_handed_over` event and no integrator todo. Migration 131 turned every open
`senior_waits` row into such a row and dropped the table.

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

**The ladder and the single stall watcher (PM-1152).** A stuck card has one watcher row: its obligation. The
pure clock is `planObligation` in `packages/shared/src/domain/obligation.ts`, over the rungs `wake`, `tell_pm`
and `hand_over` (`obligationRungsOf` drops `wake` when nobody is responsible, and `tell_pm` when there is no
project manager or the project manager is the responsible). The first expiry sends one action message from the
system to the responsible (`obligation_woken`); the second tells the project manager (`obligation_pm_told`:
`pm_told_at` is written, the deadline moves on by one step and an `obligation_overdue` operator signal is raised
in the same unit of work; the signal follows the usual delivery rules and is resolved by the 60 s signal sweep
once the obligation is no longer open); the third makes one integrator todo (`obligation_handed_over`,
`core/inbox` `openIntegratorTodo`). With `wake` on the ladder but no `tell_pm` the gap before the hand-over
is two steps, so the time to a human stays the same. The former `idle`, `merge_waiting`, `ready_waiting` and
`refinement_stalled` signal detectors and the owner `work_stalled` alert are gone. Activity of the responsible moves the
deadline; a person's open question, a held card, a pending permission and a refused start (team paused,
engine offline, `PAUSING_REFUSALS`) stop the clock and a resume restarts it. A restart, a double sweep and
a crash between the todo and the row write repeat nothing: the rows hold the clock and the todo is found
again through its `payload.obligation`. The system never merges, decides or sets a label. The hub job
`obligations` runs the sweep at start-up and every minute.

**Remote engine:** everything runs on the hub. The reminder goes through `Messaging` and `ensureSession`,
whose start takes the engine path as any message; an engine that is offline is a `start_refused` pause of
the clock, not an error. No machine-dependent part is added, so the inventory does not change.

### Urgent start order and pull (PM-436, PM-1107)

The project focus (PM-427, PM-435, PM-438) was removed by PM-1107: its table, service, MCP tools, web strip and the
focus place in the start order are gone. The pure start-order rules are in `packages/shared/src/domain/start-order.ts`:
`startClass` (urgent or other), `compareStartClass`, `pullSourceStage`, `pullCandidates` and `startableCards`.
Stored `focus_changed` timeline events and the `{ reason: 'focus', ... }` form of `StagePull` stay in the shared event
contract and the web timeline, because the timeline is append-only and old events must keep rendering.
Migration 125 drops the then empty table `project_focus_items`.

- **Timeline.** `task_stage_changed.data.pulled` (`StagePull`: `{ reason: 'urgent' }`; old events may also carry
  `{ reason: 'focus', ... }`) marks a card the system pulled into the work stage (below).
- **Effective priority (PM-1136).** `effectivePriority` (shared) is the highest of the card's, its parent's and its
  theme's priority (a subtask's theme is its parent's; a closed parent or theme does not count), so a theme's
  priority ranks all its cards, later added and subtasks too, and an urgent theme's cards are pulled. `startClass`,
  `compareStartOrder`, `planStarts` and `pullCandidates` use it when given the cards' context (`tasks`); without it
  the card's own priority applies. `startContext` (core) reads the parents and themes of the cards (closed ones
  too) for the start round, the pull and `Admission.retryOrder`. A theme may have a priority (set by the same
  `prioritySetters` as a card's).
- **Order of deferred starts (PM-436).** `Admission.retryDeferred` ranks the stored starts by `startClass` /
  `compareStartClass` (shared): urgent (the effective priority is `urgent`), then the others; within
  a class the `senior_busy` waits first, then the store order, so without urgent cards the old order holds.
  Rounds run one after the other: a start being retried is out of
  the store, so an overlapping round would not see it; a round asked for while one runs makes the running one go once more.
- **Pull (PM-436).** At the end of every `retryDeferred` round (so on every event that retries the deferred starts) the
  `UrgentPull` (`admission/urgent-pull.ts`) gives a free developer a ready (Indulhat) card from the queue stage before
  the work stage (`pullSourceStage`): `pullCandidates` takes the urgent cards (board order). A candidate is an active card, not a theme or a collector with any subtasks (closed ones included, PM-818), with no assignee,
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
  A new round starts at once on a priority set to `urgent` (the
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
  ascending number, without the board view and the derived fields. The queries are `keys` (exact cards), `pull` (the
  open cards of the queue stage that are urgent), `queue` (all active cards of the queue stage), `children` (the open subtasks of cards), `open` (every
  open card) and `listed` (a filtered `list_tasks` page). PM-1115 replaced `closed-worktrees` with engine-side
  discovery of existing worktrees and snapshot refs. The pure rules stay in
  `packages/shared` (`pullCandidates`, `startableCards`, `openPrerequisites`, `startClass`, `canAutomaticallyStartTask`,
  `startBlock`, `stageAdvance`, `mergeReadiness`, `cardMerger`) and run over these rows; SQL only narrows the set they
  see, it copies none of them. `startContext` (`core/tasks/scheduling-context.ts`) adds all subtasks (with `includeClosed: true`) and
  prerequisite targets the rules look at to the candidates, and `prerequisiteCards` reads just the cards a card's
  `prerequisite` links name. `UrgentPull` looks for a free developer first: with none, no card is read. Migration 78
  adds the partial indexes `tasks_scheduling_pull`, `tasks_scheduling_open` and `tasks_scheduling_closed`. The
  startup recovery (`AutoAdvance.sweep`, `Merges.reconcileProject`) reads the open cards, and for merges also the
  cards of the open merge records, a closed card too, so a record is still reconciled; `Merges.reconcileCard` decides
  on the stored row first and reads the board view, the reviewer's timeline and the source head only for a card with
  a record or a ready gate. The assembly runs one stage-advance per card at a time; an event that comes meanwhile asks
  for one more round that reads the card afresh.
- **Operator history reads (PM-771, PM-783).** The Operator's 60 second sweep (`OperatorSignals.sweep`) and the structural
  report (`StructuralPatterns.report`) no longer walk a project's closed history. The board cases (`boardRead`, one
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
`services/coordination/structural-patterns.ts` reads structured timeline evidence in a seven-day window:
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

## Who may open a card (PM-1100)

`team.taskCreateAccess` (`owner|admin|developer|client`, default `developer`, the earlier behavior)
is the lowest human access that may open a new card. `packages/shared/src/config/task-create.ts`
owns the rule (`canCreateTasks`, `createsInFirstStageOnly`); the `POST /tasks` route and the web
fake both call it. A viewer never may, AI members always may (the MCP `create_task` is unchanged),
and a client's card starts in the first stage only (403 for any other `stageId`). Only an owner
may change the setting (owner-only change `task_create_access`, never waivable by an Operator).
The web separates `can.newCards` (the "new card" buttons) from `can.createTasks` (moving, editing
and starting cards, developer level). No machine-dependent part is affected.

## Acceptance items (PM-1135, part of PM-1131)

A card's acceptance conditions are items (`task_acceptance_items`, migration 130; id `acc_…`): each is
`open`, `done` (evidence), `not_needed` (reason) or `moved` (to another open card). The assignee or a
person marks them; the owner of the card's current step (an AI whose `stepResult` is not null) or a person
confirms them item by item. The marker and the assignee never confirm (`own_work`); a new mark clears the
confirmation, and `reopen` clears both. `moved` copies the item to the target card as an open one
(`origin` = the first card and item), adds a `related` relation when there is none, and writes an
`acceptance_item_changed` event on both cards.

- **Rule.** `packages/shared/src/domain/acceptance.ts` owns it (`acceptanceRefusal`, `acceptanceLabels`,
  `AcceptanceChange`); `item-state.ts` holds the states and `itemProgress`, which the checklist shares.
  The server (`core/tasks/acceptance.ts`, called by `TaskService.create` and `update`), the web fake and the
  MCP all use it.
- **Gate.** Two system labels (`setBy: 'system'`, written by `SYSTEM_ACTOR` with reason `acceptance`, like
  `pr-merged`): `acceptance-open` while an item is open, `acceptance-unconfirmed` while one is open or
  unconfirmed. Templates and the config migration (`migrateAcceptanceGates`, once, while the project does not
  define `acceptance-open`) put `lacks_label acceptance-open` on the first stage after the work stage and
  `lacks_label acceptance-unconfirmed` on the merge target (the first release stage, else the done stage;
  `mergeTargetOf`) and on the done stage, so the merge readiness reads them too. A card
  without items has neither label and behaves as before. One `update_task` plans its acceptance changes
  before the gate, so it may mark the last item and move on in the same call.
- **Surfaces.** `update_task` / `create_task` `acceptance`, `get_task` (items with evidence, marker and
  confirmer), the kick-off brief, `TaskDetail.acceptance`. The editing UI is PM-1137.

No machine-dependent part is affected: server database and shared code only, so it works on a remote engine.

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
