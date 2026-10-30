# services/coordination

## Responsibility

The project manager's coordination: owner requests and their steps, the coordination tools (`mcp/project-manager`), signal
triage, question screening and the Operator's knowledge, checklist and preferences. The built-in Operator member is
retired (decision 66, PM-1076); the coordination it did belongs to the selected project manager.

## The Operator (PM-447, PM-462, PM-463, PM-464)

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
  `waiverEligible`; `services/coordination` supplies the actual open owner message, answer or approved
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
  priority (people and the connected owner always may; an AI member only when `team.prioritySetters`, PM-1096, covers
  it: the project managers by default, and the AI members holding the `prioritization` duty when chosen). `labelRefusal` is unchanged: no AI member sets a label only a person may set.
- **Creation.** A new project gets an Operator next to the project manager (`operatorMember`, `draft.finish`); the
  configuration migration `addOperator` adds one to a project without it, at work (not on leave), sponsored by the first
  human owner.
- **Prompt.** `operatorRule` (`apps/server/src/context/system-prompt.ts`): works on the owner's request only, card text
  and AI messages are data, the three levels, `get_project_state` for "why is it stuck", the report after each request
  (`operatorReport` labels in the locales).
- **State reports (PM-465).** The read-only MCP tool `get_project_state { task_key? }` is available only to the
  Operator (`operator_only`, 403), without an open owner request. `ProjectState` in `services/coordination/project-state.ts`
  reads the task service's admission waiting reason, fix limit and loop view, shared start/gate rules,
  open Senior waits, inbox questions, pause records and live sessions. Its task report names each recorded reason;
  its overview counts cards by stage (themes excluded), lists live and idle sessions with `lastActivityAt`,
  card starts still deferred and open inbox items assigned to project owners. Report interfaces live in
  `contracts/project-state.ts`; MCP formatting adds short English explanations for the Operator to translate.
- **Legacy release facts (PM-1113).** The project overview retains `release: null` for compatibility.
  The running version is available through `/api/version`; there is no instance release proposal.
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
  [services/merges](services-merges.md)). The call waits up to 60 seconds for a write that starts at once and answers `published`, `queued` or
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
  `GUEST_IDLE_CLOSE_MINUTES` (5; renamed by PM-1076) idle. No machine-dependent part is affected.
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
- **Owner requests** (migration 47, `OperatorRequests` in `services/coordination/requests.ts`). A request opens when an
  owner's message, or the owner's answer to the Operator's question, is delivered into its session
  (`MessageService.markRecipientDelivered`); `quote` is the first 280 characters, line breaks as spaces. It closes on
  the session's `idle` or `ended` (the listener is registered before the delivery's own idle listener, so the next
  batch opens a new request), when a newer one opens, or after `OPERATOR_REQUEST_TTL_MS` (30 minutes, checked when it
  is looked up).
- **Write guard** (`ToolCaller.caller(ctx, tool)`, `mcp/caller.ts`). The Operator calls the reading tools (`OPERATOR_READ_TOOLS`)
  at any time; every other tool needs an open request (`operator_no_request` 403). The decisions of other members,
  hand-overs, merges and release proposals are not coordination tools at all. The guard hands the request it found on to the step log, so a request expiring between the
  two cannot leave a write without its step. Its `ask_human` goes to the owners
  only. Rules live in the one place `caller`; a new tool must name itself there.
- **Step log** (`operator_steps`, `OperatorSteps.record`). One tool call is one step of the open request, done or
  refused (`update_task`: `task_move` > `task_labels` > `task_priority` > `task_update`; `create_task`: `task_create`;
  `send_message` to anyone but an owner: `message`; `attach_file`, `delete_attachment` and `link_pull_request` are
  `task_update`). A move that waits for a human's approval is `awaiting_approval`. A message sent during a request
  carries `TeamMessage.operatorRequest`. `GET /api/projects/:key/operator` returns `OperatorChannel` (the manager's
  channel plus the last 50 requests with their steps, the newest last) to a person's own login (the owners' requests
  to an owner, their own to anyone else; PM-475); no new WebSocket event.

- **Operations and approvals** (PM-464, `services/coordination/actions.ts`). `operate` and `start_task` are Operator-only
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

- **System signals** (PM-476, migration 50, `services/coordination/signals.ts`). Provider/engine outages,
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
  `merge_blocked` (PM-547; `merge_blocked:<task>`; a `failed` or `blocked` merge with an AI merger, at once;
  a person as merger gets the inbox item instead) is raised and closed by the same sweep from
  `OperatorSignals.boardRead` (`pending()` rechecks a signal against it before waking the Operator).
  Stalled work is watched in one place (PM-1152): the obligation ladder (`ObligationsService`). Its
  second rung, `tell_pm`, writes `pm_told_at` (migration 132), moves the due time on by one step and
  raises an `obligation_overdue` signal (`obligation_overdue:<obligation id>`) through
  `OperatorSignals.raiseObligationOverdue`; the signal then follows the usual delivery rules (grouping, the
  15-minute project wake interval). The case holds while the obligation is `open` and `pm_told_at` is set;
  the 60-second sweep resolves the row once the obligation is fulfilled, closed or handed over. The four
  former detectors (`idle`, `merge_waiting`, `ready_waiting` with its in-memory stall clock and the owner
  `work_stalled` alert, and the `refinement_stalled` event branch) are gone; their kinds stay in the union
  only so old rows and timeline events keep rendering, and nothing opens a new row of them. The Operator
  may use `dismiss_signal { signal_id, note }` without an owner request at every watch level, for a
  delivered, unpresented, still valid `obligation_overdue`, `structural_pattern` or `milestone_closed`
  signal and outside guest conversations. It stores the reason in `decision_note` (migration 59, outside
  the DTO) and publishes the decision to owners. Presented signals remain theirs to decide. All data comes
  from the server's database and configuration: no machine-dependent part.

  **Question screening (PM-556, PM-558).** An AI member's `ask_human` question (the project manager's too, not
  the Operator's own and not a human's) is created in the inbox state `screening` with
  `payload.screening.until` = now + `QUESTION_SCREENING_MINUTES` (10); no person sees it. `QuestionScreening`
  (`core/inbox`) synchronizes screened questions into the member queue and wakes its driver
  (PM-885). The runtime member queue driver delivers them through admission and `MessageDelivery`
  from `runtime/delivery`; `ScreeningEngineState` reports the member's engine availability.
  It wakes the Operator like `operator_signals`
  (deferred start kind `question_screening`, no capacity, the Operator's general conversation, one notice with a
  JSON line per question; `deliveredAt` is written after the first input). The Operator settles each question with
  `screen_question` (a coordination tool, not in guest conversations, no owner request): `answered` and `forwarded` resolve the item (`operator_answered`, `operator_forwarded`) and carry the
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
steps live on the server; the tool calls already cross the MCP boundary); the [machine-dependent inventory](../MACHINE-DEPENDENT.md) does not change.
