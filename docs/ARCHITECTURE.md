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
  cancelled cards) are `themeCards` / `themeProgress` in `domain/theme.ts`.
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
- **Work item and session** — every AI member works in a **fresh session per work item**:
  member × task, member × meeting or member × general chat (decision 5). A task session lives
  through the whole pipeline; later messages about the task resume it. Persistent identity
  and durable memory carry over between sessions. A task session of a role that changes files
  runs in a git worktree of the task's repository and never in the workspace root; with several
  repositories and none chosen it does not start (`repo_required`). Roles that only read run in
  the workspace root. A conversation belongs to the directory it ran in: when the task's
  worktree is elsewhere (its repo changed since), the session starts a new conversation there.
  **Dependencies in a new worktree** (PM-332, `PROJECTMAN_CLONE_DEPENDENCIES`, on by default; macOS only):
  after `ensureForTask` made the worktree (or found one without `node_modules`) it clones `node_modules`, the
  root's and every workspace's, with `cp -c -R` (APFS `clonefile`: seconds, and the blocks are shared) from
  the first checkout of the repository (the repo path, then its other worktrees) whose `package-lock.json` is
  byte-identical and whose hidden `node_modules/.package-lock.json` is not older than it, i.e. installed after
  the lockfile's last change. Only on one APFS volume, only where git ignores `node_modules`; `.vite`,
  `.vite-temp` and `.cache` are left out of the copy. The server never runs `npm install`/`npm ci` outside the
  sandbox (install scripts). Whatever fails or does not apply (`worktree/dependencies.ts` names the reasons)
  is a log line, never a failed worktree: the member installs as before. Members' own workspaces and review
  copies are not cloned.
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
  the prefix always names the message's own card. While a card is being refined (`isRefining`), a
  message about it for an AI member that is not the `turnMember` is held at the card, whatever
  sessions the family has (PM-255): it is typed in or taken in the first input when that member's
  turn starts, and wakes its recipient as usual when the card leaves refinement; only the answer to
  the recipient's own `ask_human` question goes through at once.
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
  **The Senior card** (PM-348, decisions K2 and K3 of PM-338): the automatic developer choice is
  `pickDeveloper` in `packages/shared` (a Senior card to a free Senior; any other card to the least
  loaded free member, a Senior last; a Senior card never to a temp worker). While every Senior is busy
  or away, `startLocked` leaves the card in the work stage unassigned and the start waits as a
  `work_start` deferral (`startWaiting.reason` `senior_busy`, with `seniors`); a person's Start gets a
  normal response with that wait. `SeniorWaits` (`admission/senior-waits.ts`, table `senior_waits`, one
  open row per card) keeps when the wait began, the question and the answer over a restart. After
  `seniorWaitMinutes` (30) the 60 s sweep asks the owners once (an inbox decision, `wait_for_senior` or
  `any_developer`); "any" lets a free developer take it, never a temp worker. A freed Senior takes the
  card first (`retryDeferred` tries `senior_busy` deferrals first) and the question closes
  (`senior_took`); an assignment, move, closure, level change or the end of the team's Senior closes it
  (`senior_wait_ended`). A team without a Senior starts the card by the "any" rule (`no_senior` event).
  No machine-dependent part is affected.
- **Stage hand-over** — when a task enters a later stage owned by AI members, by anyone's
  move, the least loaded free owner (never the task's assignee) gets a session for the task.
  An owner that already has a session for the task gets a notice instead.
- **Refinement line** (decision 31, `RefinementSteps`) — a card carrying `refine` (or standing in a
  `task_breakdown` step stage) is worked out one step at a time, before development. The steps are
  the labels the gates up to the work stage lack, in gate order (`refinementTurn` in
  `packages/shared`, the same set `evaluateStart` refuses a Start for). Each step has one member:
  an AI setter (already working on the card, else not on leave, else least loaded) is started
  (a running session only gets a notice), a person gets a `manual_step` alert. Nothing is done
  while a session is mid-turn on the card; a step is not handed out twice (its member's turn
  ending without the label raises one `stalled` alert). When every label is on, the system takes
  `refine` off, moves the card to the stage before development and tells who prioritises (`done`).
  Every change of turn is a `refinement_turn` timeline event (`turnMember` reads the latest). A
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
  Remote access goes through `tailscale serve` ([SECURITY.md](SECURITY.md)); the owner's live
  instance is also public at chopper.istvan.io through a Cloudflare Tunnel behind Cloudflare
  Access ([DEPLOY.md](DEPLOY.md), PM-200), which still ends at this one loopback port.
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
  a compaction (`sessions.compact_pending`): `SessionOrchestrator.roundEnded` marks every session of
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
secrets/nanogpt.json       installation NanoGPT key (0700 directory, 0600 file; PM-328)
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
                          an agent asked for also has <id>.<ext> (a hard link);
                          an image's thumbnail is <id>.thumb (<id>.thumb.part while written)
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

## Full test before review (PM-217)

The developer's sandbox cannot open a pseudo-terminal, so the server's PTY tests (`*.integration.test.ts`,
`golden-path-*`) never run before a review. A repository that sets `reviewTest` (`{command, maxWorkers = 2,
timeoutMinutes = 15}` in the project's configuration; absent: nothing below happens) gets a **full test** of the
commit pinned at the hand-over, run by the server.

- **Queue.** `FullTestRuns` (`domain/full-tests.ts`) queues a run (`full_test_runs`, migration 32) when the
  review pin is saved (the stage change) or a new round re-pins (`repinReview`, on the developer's message to a
  reviewer), and drops the queued or running run of an older pin or of a stage the card left (`cancelled`:
  `repinned`, `stage_left`; `branch_moved`, `interrupted` at a restart, `shutdown` at a stop). One run runs at a
  time in the whole installation, first in first out, under `nice -n 10` (set on the process that starts
  srt, outside the sandbox: Seatbelt refuses `setpriority` inside it; the sandbox and the command inherit it).
- **Executor.** `src/full-test` (`FullTestExecutor` in `contracts/full-test.ts`) writes the srt settings
  (`fullTestSandbox`: reads the checkout and the configured repository's git directory only, writes its run
  directory `<tmp>/pmft-<end of the run id>/` only: srt's own default temporary directory, `/tmp/claude`, which it
  opens on its own and the members' sandboxes share, is in `denyWrite`; no network except listening on local ports, `allowPty`; the
  directory is short, and under `/private/tmp` when `<tmp>` is too deep, because srt's socket in the
  sandbox's TMPDIR must stay below macOS's 104-byte socket path limit), runs `<command>` there (srt's `-c`, with
  its standard input closed by `exec </dev/null;`, because srt hands the command its input through a socket,
  and `script`, so a PTY, fails on a socket; srt also sets the command's `TMPDIR` from `CLAUDE_CODE_TMPDIR`,
  or a `/tmp/claude` that does not exist, so `fullTestEnv` sets it to the run's tmp) with
  `VITEST_MAX_FORKS` and `VITEST_MAX_THREADS` set to `maxWorkers`, kills the process group at the time limit
  and reads vitest's failed files and "Failed Tests" section from the output. Without macOS or `srt` the
  executor is not available and the feature is off. The managed VM profile leaves it out.
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
  only in `test/full-test-sandbox.integration.test.ts` (macOS), which the integrating session runs.

When the executor is available and the task's repository sets `reviewTest`, `FullTestRuns.runsFor`
sets `ContextPackInput.serverFullTest` in the session brief. Implementation and maintenance steps
then ask only for targeted tests and the type check of touched parts while working: the server runs
the configured full command on the handed-over commit, PTY tests included. Otherwise the steps ask
for targeted tests while working and one full test and type check on the handed-over commit.
Dependencies are installed only when missing from the working directory.

## Heavy-run queue (PM-332)

Three full test suites at once (2026-10-04) took the load to 81–89 and the swap to 6 GB: every member's vitest
starts a worker per core, about 150 MB each. So **one heavy run goes at a time on the machine**, and a run's
workers follow the machine's size.

- **The lock** (`apps/server/src/full-test/heavy-lock.ts`, node built-ins only, because the CLI imports it
  directly and `full-test/index.ts` loads the sandbox runtime). macOS has no `flock` or `lockf`, so it is a
  directory in `/tmp/projectman-<uid>/heavy` (`defaultHeavyLockDir()`, `PROJECTMAN_HEAVY_LOCK_DIR`): its parent
  must be 0700 and ours, or the queue is `heavy_lock_unavailable`. `holder/` is the lock itself (`mkdir` is
  atomic; `owner.json` inside names the process, its label, checkout and session); `queue/<ticket>.json` is one
  file per waiter, the ticket sorting by queue time. A waiter and the holder write a heartbeat (`utimes`, every
  5 s) on their file. The head of the queue removes the tickets and the holder that are stale (heartbeat older
  than 30 s, or the pid gone) and takes the lock; breaking a holder is a `rename` away, atomic, so one waiter
  wins. A live holder is never broken, however long it runs. After a sleep a live lock can be broken for a
  moment (two runs overlap); the holder notices at its next heartbeat and logs it once. `readHeavyQueue` shows
  who holds it and who waits, for the PM-300 display.
- **Who queues.** The CLI `npm run heavy -- [--label <text>] [--max-wait <s>] <command>`
  (`scripts/heavy/cli.ts`) runs the command at its turn; the root `npm test`, `npm run typecheck` and
  `npm run shots` go through it. It says on stderr who it waits for; `--max-wait` ends with exit status 75; a
  signal is passed on to the command. An unusable queue folder (`heavy_lock_unavailable`) stops the
  command with exit status 78 and a four-line message; it does not run without the queue (decision 33,
  PM-346). `PROJECTMAN_HEAVY_LOCK_HELD=1` (set for everything the CLI runs) makes a nested call run
  without queueing. Runs inside one workspace (`npm test -w …`, `npx vitest related …`) do not queue.
- **The server's full test** (`createFullTestExecutor({ heavyLockDir })`) takes the lock before it prepares the
  run directory; the wait is not part of `durationMs` and `timeoutMs`, and an abort while waiting ends as
  `killed`. `fullTestEnv` sets `PROJECTMAN_HEAVY_LOCK_HELD=1`, so the scripts inside do not queue again. With an
  unusable folder it runs without the queue and logs a warning: the review must not stall on it.
- **The members' sandboxes** (`SandboxPaths.heavyLockDir`): `projectman-<uid>` is writable and
  `PROJECTMAN_HEAVY_LOCK_DIR` is set, together with `npm_config_prefer_offline` (install from the member's own
  npm cache when there is no clone). The same folder and variables go to a Codex member as
  `AgentSandbox.portable` (PM-346): `buildCodexArgs` adds the parent to `sandbox_workspace_write.writable_roots`
  (only in `workspace-write`; none in the managed VM) and sets each variable with
  `shell_environment_policy.set.<NAME>`, so every command sees them, also one run outside the sandbox after a
  question. The server makes the missing parent (0700) before the process starts.
- **Workers.** `defaultTestWorkers` (`packages/shared/src/config/test-workers.ts`): half the cores, at most 4,
  one per 4 GiB of memory, at least 1. Every `vitest.config.ts` sets `maxWorkers` to it and `minWorkers` to 1.
  `VITEST_MAX_FORKS` and `VITEST_MAX_THREADS` (the server's full test sets them from `reviewTest.maxWorkers`)
  still win: vitest takes `poolOptions.*.max*` before `maxWorkers`.
- **The integrating session** calls the same CLI from `~/projectman-integrator/merge-test.sh`; it adjusts the
  script itself.

## Machine-dependent parts (PM-341)

- **NanoGPT secret store** — `domain/provider-keys.ts`, `domain/nanogpt-key-check.ts` (PM-328).
  The server stores the installation key under `PROJECTMAN_HOME/secrets/nanogpt.json`,
  with POSIX directory/file modes 0700/0600 and an atomic same-directory rename. Only an
  owner of every project may change it. Save-time checking needs outbound HTTPS to NanoGPT.
  **Remote engine:** storage and validation remain on the server; this card does not send
  the key to an engine. PM-329 must deliver it only to NanoGPT sessions over the authenticated
  server/engine boundary, without configuration, database or logging persistence on either side.

This is a living inventory of assumptions that tie execution to a machine, account or OS.
The current local mode usually places the server and agent CLIs on the same host; the managed
VM boundary separates accounts on one host, not server and engine across hosts. The remote
actions below are requirements for planning, not implemented remote support or new contracts.
Keep entries current under the rule in `CLAUDE.md`.

Unless stated otherwise, server paths below are relative to `apps/server/src/`.

- **Fake CLI pause test gates** — `runner/runner.integration.test.ts` and
  `apps/server/test/fixtures/fake-claude.mjs` (PM-344). Tests hold the fake's work/tool
  phase until a release file exists in the disposable session workspace; PTY readiness
  markers confirm the phase before a pause is requested. The test and fake must share
  that temporary filesystem. Interrupting a turn abandons its gate without a release.
  **Remote engine:** run this integration harness and its fake together on the engine;
  these test-only paths never cross the production server/engine boundary.
- **Dependency clones** — `worktree/dependencies.ts`, `cloneDependencies` (PM-334).
  Copies installed `node_modules` from another checkout with the same lockfile using
  `cp -c -R`; only Darwin and checkouts on the same APFS volume pass the probe.
  **Remote engine:** find reference checkouts and probe the filesystem on the engine;
  retain the existing skip/install fallback on other platforms. The server's installation
  cannot be cloned across machines, and native dependencies must match the engine.
- **Heavy-run queue and worker limits** — `full-test/heavy-lock.ts`,
  `scripts/heavy/{cli,run}.ts`, `packages/shared/src/config/test-workers.ts` and the workspace
  `vitest.config.ts` files (PM-332, PM-336). A per-user lock directory under
  `/tmp/projectman-<uid>/heavy` uses local atomic directory operations, PID liveness and
  heartbeats; worker limits use the executing host's CPU and memory. Same-host runs must
  use the same lock directory; different users are not automatically one queue. An unusable
  folder stops a member's heavy command (exit 78); the server's full test runs without the queue
  and warns (PM-346).
  **Remote engine:** queue competing runs on each execution host and size workers there;
  do not use the server's PID namespace, lock or hardware measurements for another engine. The
  engine supplies `SandboxPaths.heavyLockDir` from its own `defaultHeavyLockDir()` or setting,
  and with it the `StartSessionSpec.sandbox.portable` paths; its runner renders the Codex
  arguments and makes the folder (PM-311, PM-312).
- **Session output folders** — `index.ts`, `domain/session-folders.ts` (`SessionFolders`),
  `domain/sessions.ts` and `domain/session-policy.ts` (PM-268, PM-333, PM-339). Legacy Claude
  sessions, and Codex sessions whose sandbox writes (`workspace-write`), receive a per-process
  writable folder below the server's real `tmpdir`; the server makes, sweeps and removes it. These
  folders are not supplied to read-only Codex or managed VM sessions. A Codex session also gets its
  own short temporary directory, `<realpath('/tmp')>/projectman-<uid>-tmp/<home hash>/<session id>.<6 random hex>`
  (`defaultSessionTmpRoot`, `SessionFolders.allocateTmp`/`make`), its `TMPDIR` and a writable root,
  removed and swept with the folder; without a safe tmp root Codex gets no folder. The root is 0700
  and a sibling of the heavy-run queue's parent `projectman-<uid>`, never below or above it (that
  parent is writable for every member's commands, so a path there could be pre-empted or read by a
  member; an overlap, compared as written and by canonical path through links, leaves Codex without a folder); a directory is new at every start and made
  without `recursive`, so a link put there beforehand stops the start. The path is short because a Unix
  socket's is limited to 104 bytes. The Codex adapter then closes the shared `/tmp` and the CLI's
  `$TMPDIR` for its commands.
  The tmp root is another machine-dependent assumption: a shared host-local `/tmp`.
  Every Claude session reads all the folders below the instance's root
  (`realpath(tmpdir)/projectman-sessions/<home hash>`), through the file-tool rules the policy
  renders (`filesystem.sessionFolder`, `sessionFoldersRoot`; `claudeToolRules`) and a developer's
  sandbox `allowRead`; it writes only its own folder. A resumed session gets a new folder, and its
  system prompt says that the old paths are gone and the card's attachments stay. Another
  instance's root (another home hash) gets no rule.
  **Remote engine:** allocate and clean up on the executing host, generate its sandbox paths
  there, and transfer output through an authenticated attachment path rather than reading a
  remote absolute path on the server. The root is a property of the engine (the PM-312 host's
  file system), not of the server; the policy carries the two paths to the host that runs the
  CLI. A member reads only the folders of sessions on its own engine; images move between
  machines through `attach_file` → `read_attachment`.
- **Browser installation and screenshots** — `index.ts`, `domain/session-policy.ts`,
  `scripts/{browsers,shots}.mjs`, `scripts/lib/browser.mjs` (PM-268, PM-270).
  Playwright loads local Chromium binaries from the configured browser directory (default
  `<PROJECTMAN_HOME>/browsers` in the server; the scripts also accept
  `PLAYWRIGHT_BROWSERS_PATH`). `shots` launches a disposable local instance and browser,
  and writes images to local output storage. For a Codex member, whose sandbox cannot start
  Chromium, the server runs `npm run shots` itself (`take_screenshots`, `get_screenshot_run`,
  PM-351): `domain/screenshot-runs.ts`, `full-test/{screenshots,run-sandboxed}.ts` start it in the
  member's worktree inside the macOS `srt` sandbox, with the session's own read/write limits and
  the session folder as the output; it queues in the machine's heavy-run queue and is off in the
  managed VM profile and off macOS.
  **Remote engine:** provision a compatible browser on the engine, preserve the disposable
  instance's network fence and read-only browser access, and return images as artifacts. The
  screenshot run belongs on the engine that owns the member's worktree and session folder (the
  server cannot run it against a remote path); the server keeps only the tool and the run record.
- **Machine display and orphan processes** — `machine/{probe,parse}.ts`,
  `domain/machine.ts` (`MachineMonitor.stopOrphans`), `api/machine.ts` (PM-320, PM-300).
  OS probes (`ps`, macOS `vm_stat`/`sysctl`, Linux `/proc`) measure the local host; trees,
  ownership checks and signals use its UID and PID namespace, with process start times
  checked against PID reuse. **Remote engine:** measure and stop on the owning engine,
  identify the engine with every process identity, and preserve fresh ownership/orphan
  checks and owner access. A remote PID must never be signalled on the server.
- **Instance identity for process attribution** — `app.ts` derives the first 16 hex characters of
  `sha256(realpath(home))`; `runner/env.ts` supplies `PROJECTMAN_INSTANCE` alongside
  `PROJECTMAN_SESSION_ID` (PM-320). This identifies a local installation by its home path,
  not a host-independent engine identity. **Remote engine:** plan instance/engine attribution
  explicitly, including reconnects and moves; equal paths on different hosts must not imply
  equal ownership.
- **Session process termination** — `runner/session.ts` (`stop`, `kill`),
  `runner/runner.ts` (PM-341; PM-320). The runner owns a local process handle and sends
  SIGTERM, then SIGKILL after a timeout (or SIGKILL immediately for a forced stop).
  In local mode stopping the CLI does not itself prove that detached children are gone.
  **Remote engine:** execute stop/kill on the engine owning that process, return its exit
  acknowledgement, and plan descendant cleanup there; a server-side PID or closed transport
  is not evidence that a remote session has stopped.
- **Conversation transcripts and resume** — `runner/transcript/{reader,tailer,confined}.ts`,
  `runner/session.ts`, `domain/sessions.ts`, `runner/providers/{claude,codex}/transcript.ts`
  (PM-340). Claude conversations live under `~/.claude/projects`; Codex rollouts under
  `CODEX_HOME/sessions`. The server reads and tails hook-reported files, and resume eligibility
  checks transcript content; managed worker reads are confined to the worker home.
  **Remote engine:** keep CLI conversation state and resume checks on its engine/account,
  stream conversation events to the server, and preserve confinement. A conversation ID
  without its engine's saved state is insufficient for resume.
- **Hooks and team MCP over loopback** — `index.ts` (`loopbackBaseUrl`),
  `domain/sessions.ts`, `runner/runner.ts`, `runner/hook-forwarder.ts`,
  `http/local-guard.ts`, `runner/providers/{claude,codex}/args.ts` (PM-341; PM-286, PM-310,
  PM-311). CLI hooks and MCP target the server's loopback URL (`127.0.0.1:4800` for the live
  instance; the port is configurable). The internal guard also checks the peer, Host and
  forwarding/origin headers; merely changing the URL to a public server cannot work.
  **Remote engine:** plan an authenticated engine transport/local relay for hooks, decisions
  and MCP while preserving token isolation and the internal endpoint guard.
- **Task worktrees and shared git storage** — `worktree/worktree-manager.ts`,
  `worktree/member-workspace-manager.ts`, `worktree/paths.ts`, `domain/worktree-sweep.ts`,
  `index.ts` (PM-243; PM-311, PM-312). Task worktrees default to
  `~/.projectman/worktrees/<project>/<task>-<repo>`; git links them to the main repository's
  common git directory. Canonical paths, branch ownership and cleanup are local filesystem
  operations. **Remote engine:** maintain repositories/worktrees and git metadata there;
  plan branch/commit transfer and remote status/cleanup rather than treating server paths
  as shared storage. The managed VM's bundle hand-over is a separate existing mechanism.
- **Free-disk admission guard** — `domain/disk-guard.ts` (`freeDiskBytes`),
  `domain/admission/` (PM-243). `statfs(PROJECTMAN_HOME)` supplies the local free-space
  value for `minFreeDiskGb`; a low value defers new sessions. It does not measure other
  hosts or even every local worktree volume. **Remote engine:** report capacity for the
  engine's execution/storage volumes and plan admission against those as well as server
  storage; keep unavailable measurements distinct from low capacity.
- **Control socket, pause and deployment** — `control/socket.ts`, `domain/pause.ts`,
  `scripts/control/{client,cli}.ts`, `scripts/migrate/instance.ts` (PM-219, PM-143).
  `PROJECTMAN_HOME/control.sock` is a local Unix socket (0600), authorised by filesystem
  access. Pause and shutdown act through the local runner; activation checks local instance
  markers and database use. Deployment scripts using the control client need access to that
  host's socket (see [DEPLOY.md](DEPLOY.md)); the client is not a remote engine API.
  **Remote engine:** keep the administrative socket local, propagate pause/stop to engines
  with acknowledgements and reconnect handling, and require the existing human deployment
  decision before activation; local process exit is not proof that remote work stopped.
- **Native sandbox and canonical paths** — `domain/session-policy.ts`,
  `runner/providers/claude/args.ts`, `worktree/paths.ts`, `index.ts` (PM-87, PM-333).
  Legacy Claude execution uses the CLI's native sandbox (macOS Seatbelt); allow/deny paths
  are local and canonicalised, including `/var` → `/private/var` and real temporary paths.
  Codex has its own permission mapping in `runner/providers/codex/args.ts`; its `workspace-write`
  sandbox writes the roots of `AgentSandbox.portable` (the queue's parent, the session folder and
  the own tmp, PM-339) and no longer the shared `/tmp` or the CLI's `$TMPDIR`
  (`exclude_slash_tmp`, `exclude_tmpdir_env_var`; the queue's parent, a sibling of the tmp root, stays writable).
  **Remote engine:** build the policy from its filesystem and supported OS/provider
  enforcement, preserve protected paths and fail closed where required; do not copy Mac
  path grants or infer Codex permissions from Claude syntax.
- **CLI token and plan usage** — `runner/providers/claude/{usage,plan-usage}.ts`,
  `runner/providers/codex/{transcript,plan-usage}.ts` (`CodexTranscriptParser`),
  `runner/session.ts`, `domain/plan-usage.ts` (PM-341; PM-286, PM-310).
  Token counts come from the running CLI's transcript/hook data. Claude plan usage probes
  the locally logged-in CLI without a conversation; Codex reads local rollout rate-limit
  events. These observe the local account, not an arbitrary remote sponsor.
  **Remote engine:** obtain usage where that sponsor's CLI is logged in and send attributed,
  timestamped measurements; leave credentials there and retain subscription-only execution.
- **Claude workspace trust** — `runner/providers/claude/trust.ts`,
  `runtime-boundary/claude-trust.ts` (PM-341; PM-140). The runner updates workspace trust
  in `~/.claude.json` (or the configured Claude config directory); the managed launcher
  helper does so as the worker, for that worker's home and local repository path.
  **Remote engine:** prepare trust on the engine as the executing account, for the actual
  canonical checkout path; changing the server account's trust cannot unblock a remote CLI.
- **Server full test before review** — `domain/full-tests.ts`,
  `full-test/{index,sandbox,run-sandboxed}.ts` (PM-217, PM-336; PM-351 shares the spawn with the
  screenshot runs). The executor runs the pinned checkout on the server host, using local
  git metadata, a short temporary run directory, process-group signals and macOS `srt`;
  it is unavailable without macOS/`srt` and is off in the managed VM profile.
  **Remote engine:** plan where the pinned commit and dependencies are tested, equivalent
  isolation and resource queuing there, and transport of the attributed verdict/cancellation.
  An unavailable executor must not become a passing verdict.
- **Managed VM runtime boundary** — `runtime-boundary/config.ts`,
  `runtime-boundary/launcher/{client,daemon}.ts`, `runtime-boundary/egress/peer.ts`,
  `runtime-boundary/bridge/`, `runtime-boundary/worker-workspaces.ts` (PM-140, PM-141,
  PM-138; PM-331). The privileged launcher uses a local Unix socket and worker accounts;
  egress peer identity comes from Linux's local `/proc/net/tcp*` socket UID tables.
  Worker workspace hand-over uses local owner-checked spool files and git bundles.
  **Remote engine:** retain the launcher, account isolation, peer checks and spools inside
  the execution host; plan authenticated server/engine requests and artifact transfer instead
  of forwarding Unix paths, UIDs or TCP peer lookup across machines.
- **Disposable instances and migration tools** — `scripts/lib/{instance,ports,processes}.mjs`,
  `scripts/migrate/{inventory,paths,database,git,apply,instance}.ts` (PM-270, PM-143).
  Disposable instances reserve loopback ports, spawn local server/web process groups and
  use local temp homes; migration inventories local repositories, paths and database use,
  packages data and remaps paths. Cross-machine activation already requires a person's
  confirmation that the source is retired. **Remote engine:** execute local probes and
  process management on the target host, inventory engine state separately, and preserve
  explicit source retirement and rollback checks rather than inferring remote liveness.

After this inventory reaches `main`, the architect must compare the PM-286 hybrid plan and
its breakdown with it before PM-311 starts, including the related remote-work directions
PM-310 and PM-331. PM-341 is PM-311's prerequisite; that planning review is separate from
this documentation change.

## Housekeeping: worktrees of closed cards and free disk space (PM-243)

`WorktreeSweep` (at start and every 6 h, `DomainOptions.worktreeSweepMs`) goes over the done and cancelled cards
that have been closed for 3 days (`CLOSED_WORKTREE_KEEP_MS`) and have no running session, and removes the worktree
of each that is clean (`WorktreeManager.remove`, which keeps the branch; `ensureForTask` makes the worktree again if
the card restarts). A worktree with uncommitted changes is never removed: the owners get one `worktree_kept` alert
per closing of the card. What was removed and about how much space it freed goes to the server log only.

`DiskGuard` (every minute, `DomainOptions.diskCheckMs`) measures the free space of `PROJECTMAN_HOME` with `statfs`.
Below `team.limits.minFreeDiskGb` (default 10, 0 turns it off) the owners get one `disk_low` alert, withdrawn when
there is room again, and `Admission.check` refuses a new AI session with `disk_low` (deferrable: the start waits).
Running sessions finish their step. A measurement that fails never blocks anything.

### Loop watch

`LoopWatch` (`apps/server/src/domain/loop-watch.ts`, PM-261; it replaced the message storm alert of PM-186 and
its `team.limits.messageBurst`, dropped from old configurations by the `dropMessageBurst` migration) catches AI
members writing to each other on a card without progress. The rules are pure and live in
`packages/shared/src/domain/loop-watch.ts` (`countsForLoop`, `findLoop`, `loopWatchers`, `loopDeciders`), also
used by the web's fake backend. Only team messages between AI members count; people's messages do not. Progress
is a stage change, a label change, or a new commit on the card's branch (`SourceHead.committedAt`); the window
and the count are `team.limits.loopWatch` (`enabled`, `count` 3..50, `minutes` 5..240; default on, 6 in 30).
A loop is a row of `task_loops` (migration 29) with the phase `notified` → `owner` → `let_run`, and the card
carries it as `Task.loop` (a "Körbe fut" mark; clients do not see it). The first notice is a system message to the
AI holder of the `scheduling` duty (not stored as a team message). People get an inbox decision (`stop_work` or
`let_run`) only when nobody holds the duty, admission refuses the holder for good, or the loop went on after the
notice. A refusal that can clear (the AI limit, the holder's capacity, paused plan usage, low disk space) only makes
the notice wait: it is an automatic start (`StartSpec` kind `loop_notice`) kept and retried like the others, the loop
stays `notified` with `notified_count` 0, and the "went on" count starts from the delivery. A loop closes itself when the card moves on, its labels change, a commit lands, nobody wrote for a whole window,
or the watch is switched off; its decision then closes with the `loop_ended` rule. The timeline event is
`task_loop` (`raised`, `escalated`, `let_run`, `ended`).

### Fix round limit

`FixLimitWatch` (`apps/server/src/domain/fix-limit.ts`, PM-262) puts an upper limit on a card's fix rounds. The
rules are pure and live in `packages/shared/src/domain/fix-limit.ts` (`countFixRounds`, `fixLimitReached`,
`fixLimitLead`, `fixLimitPlanner`, `fixLimitDeciders`), also used by the web's fake backend. A round is a
`code-review-changes` label put on the card, a `design-review-changes` label (the project's label list gets it
when the owner adds it; the designer's review step names it only when it exists and the member may set it), or a
send-back into a work stage (the counter of PM-222, `countCardRounds`), counted from the card's `counted_from`.
The limit is `team.limits.maxFixRounds` (1..10, default 3) plus the rounds people let the card have
(`extra_rounds`); a card is held when `rounds >= limit` and its assignee is an AI member.

While a card is held, what AI members and the system (the review watch's send-back) write to its assignee is
stored as waiting and does not wake it (`Messaging.send` with `held`), and the hand-over into the work stage
does not tell it; only people's messages pass, and a person's Start is "one more round". When the card goes to
another implementer (`reassign`) the waiting messages stay with the first one and do not wake it. Who decides: the lead developer first (an AI member who holds
`technical_direction` and `code_review`, is not on leave and is not the assignee) with the MCP tool
`decide_fix_limit` (`continue`, `replan` to another `technical_direction` holder, or `to_owner` with a reason);
the planner then lets it start with a fresh count (`fixLimitPlannerForOwner`: when a person asks for the plan,
the planner is not the lead who passed the card on either; if none is left by then, it is one more round). The
people decide (an inbox decision with `replan`, `reassign`
and `another_round`, only the options that can be carried out) when no AI member can, when the lead passed it
on (`passed_on`), or when the card reaches the limit again after one more round (`again`). The state is a row of
`task_fix_limits` (migration 30); the card carries it as `Task.fixLimit` (clients do not see it) and
`TaskDetail.fixRounds`. The hold ends with a decision, a change of the assignee (the count then starts anew) or
the card's closing; its inbox decision closes itself with the `fix_limit_ended` rule. The timeline event is
`task_fix_limit` (`reached`, `passed_on`, `decided`, `ended`). The notices to the lead, the planner and a
running assignee are not stored team messages (the timeline would show their English text): a `delivery.notice`
into the member's running session of the card, or the first input of a new one, like the loop watch's; only
when admission cannot start the session now is the notice stored as a message from `system`.

## Pause and resume (PM-219, part of PM-198)

The team's work can be paused so that every session stops at a safe point and goes on from there (a quicker
deploy; decision 32). The runner's part is `SessionRunner.pause` / `forcePause` / `release` (PM-218,
[PROVIDERS.md](PROVIDERS.md)); `PauseService` (`apps/server/src/domain/pause.ts`) is the team's.

- **Scope and storage.** A pause covers the instance or one project, never one member (decision 32). It is a row of
  `pauses` (migration 31; at most one open per scope), and `session_pauses` holds one open row for every session
  it stops (point, tool, what it still waits for, `needs_restart`), so it survives a restart. `Session.pause`
  carries that row, `BoardView.pause` the open pauses of the project (`ProjectPauseView`; clients see neither),
  `pause_changed` and `session_upserted` keep the app current. The rules are pure and in
  `packages/shared/src/domain/pause.ts` (`isWorkPaused`, `canManageInstancePause`, `pauseStateOf`).
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
  A crash and a second Ctrl-C after 3 s do not pause. Under systemd this needs `KillMode=mixed` and
  `TimeoutStopSec=90` ([DEPLOY.md](DEPLOY.md)).
- **Access.** `GET` of a project's pause: an internal member; changing it: admin or owner. The instance's pause
  may be seen by anyone who is internal in some project, with only the sessions of the viewer's projects, and
  changed by an owner of every project (`canManageInstancePause`).
- **Control socket.** `PROJECTMAN_HOME/control.sock` (mode 0600; `apps/server/src/control`, not opened for a standby
  copy) takes one JSON line per request (`ControlRequest`: `pause`, `resume`, `force`, `status`) and answers one
  (`ControlResponse`); the requests are the instance's, source `control`, with no person behind them, and there is
  no login: whoever may open the file may pause the team, like whoever may stop the service. A file nobody
  answers on is replaced; one somebody answers on is left alone and logged. The members' sessions may not touch it
  (`sensitivePaths`). `npm run control -- pause --wait | resume | force | status`
  (`scripts/control`) is its client ([DEPLOY.md](DEPLOY.md)).

## The machine and the sessions (PM-320, part of PM-300)

The server shows how loaded the machine is, what each running session's process tree uses, and which
processes a finished session left behind (orphans), and the owner may stop those. Server side only here; the
display is PM-322.

- **Probe.** `MachineProbe` (`apps/server/src/contracts/machine.ts`) is the only thing that touches the
  operating system: `machine()` (processor counters, memory, swap, pressure), `processes()` (one `ps -axww -o
pid=,ppid=,uid=,rss=,%cpu=,time=,lstart=,args=` line per process), `envValues(pids, names)` and
  `signal(pid, 'SIGTERM'|'SIGKILL')`. The real one (`apps/server/src/machine`) runs `vm_stat`, `sysctl`, `ps` with
  `execFile`, a 5 s limit and `LC_ALL=C` on macOS, and reads `/proc` on Linux; elsewhere the process list is
  unavailable (`null`) and the page says so. A reading that fails is `null`, never an error. The probe
  never signals a pid below 2.
- **Identity.** A process is its pid together with its start time (`lstart`), because a pid is reused. Every
  signal is preceded by a check of both against a fresh process list.
- **Marks.** The runner puts `PROJECTMAN_SESSION_ID` and `PROJECTMAN_INSTANCE=<tag>` in the environment of
  every session; the tag is the first 16 hex digits of `sha256(realpath(PROJECTMAN_HOME))`, computed in
  `app.ts` and given to the runner and to the domain. A process of a session survives a detach (`setsid`,
  `nohup`) with its environment, so the marks follow it. (A session that is not started by this build has no
  tag: its leftovers are not recognised.)
- **Classification** (`MachineMonitor`, `apps/server/src/domain/machine.ts`). From one process list: the
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
- **Access.** `GET /api/machine[?panel=1]` and `POST /api/machine/orphans/stop` are for an owner of every
  project (`domain.instanceOwner`, the rule of the instance's pause); `Me.instanceOwner` tells the web.
  The command lines of the orphans (`OrphanProcessRow.command`, 160 characters at most) leave the server only
  here; a session's top processes carry the short name only.
- **Screenshots.** `PROJECTMAN_MACHINE_FIXTURE=<json>` (`npm run shots -- … --machine <file>`,
  [SCREENSHOTS.md](SCREENSHOTS.md)) swaps the probe for fixed data that never signals; the server warns at start.

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
