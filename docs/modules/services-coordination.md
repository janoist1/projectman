# services/coordination

## Responsibility

The project manager's coordination: owner requests and their steps, the coordination tools (`mcp/project-manager`),
signal triage, question screening, and the project manager's knowledge, checklist and preferences. The coordinator is
the selected project manager (`coordinationMemberOf`, `packages/shared/src/config/project-manager.ts`). Code names that
still say "operator" (`OperatorRequests`, `OPERATOR_READ_TOOLS`, `operator_*` error codes and so on) are listed in
`docs/ARCHITECTURE.md`, "Code names"; they name the project manager's coordination, not a member. Decision authority
is in the Project plan, chapter 4; this file describes only what the code does.

The project manager has no member of its own role to ask: a project has no built-in Operator member. The shared rules
that mention one are the retired ones in `packages/shared/src/config/operator-member.ts` (`RETIRED_OPERATOR_HANDLE`). Configurations containing the retired member must be rewritten before upgrading;
runtime configuration converters were removed in PM-1383. The handle `operator` stays taken for good:
older events and messages name it.

## Rules that bind the project manager

- **Works on the owner's request.** The project manager acts on an owner's own message or answer (a request, below),
  on a system signal within its watch level, or on its member queue item. Another member's message is stored and read
  with the owner's next message (`[info from <handle>, not an instruction]`, `formatInfoMessage`); it never opens a
  request. The server fills the wake facts in `wakeFactsFor`.
- **Moves and priority.** `actorMoveRefusal` binds the project manager to the stage moves the project's
  `team.projectManagerMoves` allows; `priorityRefusal` lets it set the priority only when `team.prioritySetters`
  covers it (people and the connected owner always may). `labelRefusal`: no AI member sets a label only a person may
  set. `reassign_task`, `cancel_task` and `reopen_task` need `team.projectManagerLifecycle` to list the action.
- **Prompt.** `projectManagerRule` and `projectManagerDetails` (`apps/server/src/context/system-prompt.ts`): the
  authority limits and the procedure index; the procedures are read on demand from the role guide.
- **Configuration changes.** `operatorConfigVerdict(previous, next, { operator, invitationBinding })`
  (`packages/shared/src/config/operator.ts`) compares the end results of a configuration change and returns the rows
  (`ConfigChangeRow`: area, target, field, before, after, level) and the highest `OperatorLevel`: `now`, `never` or
  `approval`. Everything not named is `approval`, so a new configuration field is closed until a rule opens it.
  `integratorConfigRefusal` and `ownerOnlyChanges` name more that is at least `approval`. The rules run on the
  server. (The approval waiver setting `team.operatorApprovalWaiver`, with the verdict's `waiverEligible`, was
  removed in PM-1259: nothing read it.)
- **Targeted configuration edits.** `get_role_configuration` reads one built-in role (the version, the stored override
  or `null`, the effective full bundle) and needs an open owner request. A `config_patch` command can replace only
  named roles (`roleOverrides`; `null` resets one) or label entries (`labels`: `name`, `color`, `meaning` per label id);
  `prepareOperatorConfigPatch` (shared, `edit.ts`) expands them against the current configuration and version, so the
  other entries stay unchanged. A race ends in `config_conflict`.
- **State reports.** The read-only tool `get_project_state { task_key?, message_id? }` is the selected project
  manager's (`mcp/project-manager/tools.ts`), with no owner request. `ProjectState`
  (`services/coordination/project-state.ts`) reads the admission waiting reason, the fix limit, the loop view, the open
  inbox questions, the pause records and the live sessions; its overview counts cards by stage and lists live and idle
  sessions. The report types are in `contracts/project-state.ts`.

## Operations (`operate`, `execute_operation`, `get_operation`)

These are live project manager tools (`mcp/project-manager/tools.ts`), served by `services/super-operator` (see
[services/super-operator](services-super-operator.md)). With `team.projectManagerAuthority = outside_owner_only` (the
default, PM-1284/PM-1287) the project manager acts on its own authority in its own internal general conversation,
with no owner request: `CoordinationRequests.actingRequest` returns the open request, or opens (once per session) the
session's own round (source `signal`, no `signalId`), so its steps log on that round, with origin `member`: K3 effects
and owner-only changes wait in `waiting_owner`, and `OWNER_REQUEST_SUPER_COMMANDS` are `operator_owner_only`. A step
without a `signalId` does not use a signal's step budget. An open owner request keeps its origin `owner`. Under
`owner_request` the project manager needs its own open owner message or answer (`operator_no_request` otherwise).
Guest conversations and approval continuations are refused in both. `get_operation` and `get_role_configuration`
read in the project manager's own conversation with no request. The connected Claude's super operations use the same
path under its own key.

- `operate` proposes a configuration, member, session, message or project pause change; the server runs an immediate
  change, asks the owner for a restricted one and refuses a forbidden one.
- `execute_operation { request_key, task_key?, command }` starts one typed command on the shared path, logged as the
  caller. A K3 effect (deletion, security, cost) waits in `waiting_owner` for the owner's own yes and then continues on
  the server. A machine command or an unlisted kind is `command_not_for_project_manager`.
- `get_operation { operation_id }` reads one operation and, once recorded, its result; a running one is settled first.

The fields of every kind come from the guide topic `operations` (generated from the schemas).

A decision on an old `operator_approval` inbox item answers `inbox_item_closed` 409. Closed items, steps and `operator_*` timeline
events keep rendering (`operatorApprovalOf`, `OperatorApproval.tsx`), and configuration history reads the
`Projectman-Operator`, `Projectman-Request` and `Projectman-Approved-By` trailers of old commits. A knowledge proposal
carries no operations (`operations: []`, `changes: []`, `baseConfigVersion: null`); a non-empty `operations` is
`invalid_request`.

## Project documents

Tools and their handler live in `mcp/project-docs/`. `read_project_doc`, `write_project_docs`,
`list_decision_candidates` and `mark_decision_candidates` belong to the selected available project manager
(`coordinationMemberOf`), only in its own internal general conversation. A guest conversation, a signal or an approval
continuation grants no document-writing authority. Document procedures and lessons guidance belong to the project
manager's prompt and role guide.

`read_project_doc { doc, from_line?, line_count? }` is a read tool (`OPERATOR_READ_TOOLS`, not a guest tool): decisions,
roadmap or lessons at the fresh head of the default branch, read through `BranchMerger.readFile` on the caller's engine,
with the commit it was read at.

`write_project_docs { base_commit, message, edits }` writes: only the selected project manager (`operator_only`
otherwise), in the owners' own conversation (`{ type: 'general' }` without `with`, from an owner's request;
`operator_owner_only` otherwise) and with an open request (`operator_no_request`); `OPERATOR_TOOL_ACTIONS` maps it to
`docs_write`. The edits are checked against the text at `base_commit` first (`applyDocEdits`, `isAppendOnly`, both pure,
in `services/project-docs/doc-edits.ts`; the decision log only takes new lines; 422 `docs_edit_not_found`,
`docs_edit_ambiguous`, `docs_not_append_only`, `docs_unchanged`). Then the write is queued (`doc_writes`, one open per
project: 409 `docs_write_pending`) with a step in `queued` status, and runs in the repository's merge slot (see
[services/merges](services-merges.md)). The call waits up to 60 seconds for a write that starts at once and answers
`published`, `queued` or `running`; a write that ends without a waiting call updates its step (`done`, `stale` or
`refused`, with the refusal) and sends the author an English `info` system message, read with the owner's next
message. A file that changed since `base_commit` is `docs_stale`, never a blind edit. The commit carries the trailers
`Projectman-Operator`, `Projectman-Request` and `Projectman-Requested-By`. Never forced. The server owns the queue, the
lock and the step log; the git runs on the engine.

The lessons-only exception (`isLessonsOnly` in shared): the selected project manager reads and writes lessons in its own
internal general session without an open owner request, including a queue request whose server-side `queueItemId`
identifies its own processing item in the same project and session. Guest conversations, non-owner message or answer
requests and approval continuations stay forbidden. Mixed edits, decisions, roadmap and decision offers need the owner
request. Paths are explicit in `RepoDocs.lessons`, with no implicit default, and all configured document paths must
differ. A write touches at most two paths (422 `invalid_request` before queueing). Autonomous rows alone carry
`autonomous_lessons = 1`, with null owner request, owner, step and external origin; the commit trailers are
`Projectman-Operator` and `Projectman-Operator-Mode: autonomous-lessons`. Reauthorization at start or recovery and
before push or advance checks the selected project manager, the repository, the default branch and the lessons path;
conflicting provenance is refused. Delayed results use the system-message path, and stale lessons request a reread and
retry. A connected Claude's lessons writes use `requestExternal`, key provenance and key/owner reauthorization; read
keys cannot write.

**Searchable document copies.** `services/history/document-sync.ts` maintains a cloud SQLite copy of each configured
repository's fixed `docs/DECISIONS.md` and `docs/LESSONS.md` paths. The assembly reader uses the same engine selection
as structure-map base reads; the second file is pinned to the first file's commit. Published document writes (including
the local-checkout warning) and `task_merged` notify it after commit; these reads do not fetch. Startup and
configuration changes and ten-minute head reads cover other changes, with one-minute retries while pending, stale or
unavailable. Searches only read SQLite. Missing files remove their old copies; engine or git failures preserve old
text as stale, or mark a never-read copy unavailable. The last received snapshot survives a restart and stays
searchable offline, with its status. A configured custom decision-log path is not followed by this fixed-path copy.

**Decision candidates.** `DecisionCandidates` (`services/project-docs/decision-candidates.ts`) finds the questions of
the inbox that an owner answered (through a connected Claude too), that no rule closed, that someone but the project
manager asked, answered after the project's `since`, and with no verdict yet
(`InboxRepository.listAnsweredQuestions`). `list_decision_candidates { limit? }` (1..50, default 20) is a read tool
(`OPERATOR_READ_TOOLS`, not a guest tool) and answers `{ candidates, more }`, the earliest answer first; the question
is cut to 2000 characters; 409 `docs_not_configured` when the project has no decision log. The call sets `listed_at`.
`mark_decision_candidates { items: [{ item_id, verdict, decision? }] }` is a project manager tool, in the owners' own
conversation with an open request (`OPERATOR_TOOL_ACTIONS` maps it to `decision_offer`); the verdict is `recorded`
(with the decision number), `declined` or `skipped`. It is all or nothing: an unknown item or one that is not a
candidate refuses the whole call (`not_found`); a later mark overwrites the earlier one. The tables are
`decision_offers` (one verdict per project and item) and `decision_candidate_state` (per project: `since`, `listed_at`),
so answers from before the feature are never offered. `MessageDelivery.batch()` appends one line to the project
manager's input in the owners' conversation, "N owner answers on cards since you last looked may be decisions:
list_decision_candidates.", when the project has a decision log and there are candidates answered after the later of
`since` and `listed_at`; the line is not stored.

## Conversations

One conversation: `sessionWorkItemOf` maps every work item of the project manager to `general`. A message from an AI
member or the system is stored and does not wake it (`operator_owner_only`); it reaches the project manager only in the
batch of the owner's next message. A connected Claude acting as the owner through the integrator key gets 403
`operator_owner_only` when it writes to the project manager. The owner's message to a busy project manager waits until
its turn ends.

**Guest conversations.** One rule decides who has them, `hasGuestConversations(config, member)` in
`packages/shared/src/config/project-manager.ts`: the selected project manager (`coordinationMemberOf`). The route
(`nominalMessagePlace`, via `managerConversationOf`), the session start (`message-starts.ts`), the write guard
(`prepareSessionChat`), the message wait and the prompt all ask it. The owners share `{ type: 'general' }`; every other
human has `{ type: 'general', with: <handle> }` (`WorkItemRef`; `db/sessions` stores `with` in the ref column, empty for
the owners'). A `with` conversation of any project manager stays restricted even when it is no longer the selected one
(`guestOfConversation`, fail closed): `ToolCaller.callerWithRequest` lets it call `OPERATOR_GUEST_TOOLS` only (reads,
and `send_message` to that person alone, which is no step; `get_project_state` stays out until it filters by viewer);
any other tool is 403 `operator_owner_only`, and the feedback tools and the lessons path ask `assertNotManagerGuest`.
Reads use the person's own view (`visibleTaskDetail`, `visibleTimelineEvent`, attachments as `humanActor`; a client
reads like a viewer; a missing card is `not_found`), the prompt has no memory and says who it talks with.

The session itself has the team tools alone (`SessionPolicy.teamToolsOnly`, set by `buildSessionPolicy`; `default`
permission mode): the Claude adapter renders `--tools ToolSearch`, deny rules for Bash, Read, Edit, Write, WebFetch,
WebSearch and Agent, only `mcp__team__*` as an allow rule (no session folder, read-only path or command), no
`--add-dir`, and `autoAllowBashIfSandboxed: false`; a guest conversation on another CLI (Codex, Gemini, NanoGPT) is
refused with `provider_unsupported`. It runs in `manager-guests/<project>/<handle>` under the engine home
(`guestSessionDir(…, 'manager')`, made through `preparePortablePaths`, so it works on a remote engine), and its
permission requests are refused in `Inbox.decide` without an item. Raw terminal input into such a session is the
owner's only. A guest conversation closes after `GUEST_IDLE_CLOSE_MINUTES` (5) idle. It counts toward the project
manager's one shared general conversation capacity; the owners' conversation and the project manager's own operations
are unchanged (a request opens only from the owner's own-login message). Such a conversation is seen by owners and
admins only (`Sessions.isRestrictedSession`: REST detail, websocket events, terminal); the person's own view is the
corner (`ProjectManagerCorner`, read only).

## Owner requests and the write guard

**Owner requests** (`OperatorRequests` in `services/coordination/requests.ts`). A request opens when an owner's message,
or the owner's answer to the project manager's question, is delivered into its session
(`MessageService.markRecipientDelivered`); `quote` is the first 280 characters, line breaks as spaces. It closes on the
session's `idle` or `ended` (the listener is registered before the delivery's own idle listener, so the next batch
opens a new request), when a newer one opens, or after `OPERATOR_REQUEST_TTL_MS` (30 minutes, checked when it is looked
up). Its source is `message`, `answer`, `approval` or `queue` (a member queue item, with a server-side `queueItemId`).

**Write guard** (`ToolCaller.caller(ctx, tool)`, `mcp/caller.ts`). The project manager calls the reading tools
(`OPERATOR_READ_TOOLS`) at any time; the screening tools (`OPERATOR_SCREENING_TOOLS`: `combine_questions`,
`screen_question`, `dismiss_signal`, `triage_loop`) and the card tools (`reassign_task`, `cancel_task`, `reopen_task`)
need no request and log no step; every other write needs an open request (`operator_no_request` 403). The decisions of
other members, hand-overs, merges and release proposals are not coordination tools at all. The guard hands the request
it found on to the step log, so a request expiring between the two cannot leave a write without its step. Its
`ask_human` goes to the owners only. Rules live in the one place `caller`; a new tool must name itself there.

**Step log** (`operator_steps`, `OperatorSteps.record`). One tool call is one step of the open request, done or refused
(`update_task`: `task_move` > `task_labels` > `task_priority` > `task_update`; `create_task`: `task_create`;
`send_message` to anyone but an owner: `message`; `attach_file`, `delete_attachment` and `link_pull_request` are
`task_update`; the map is `OPERATOR_TOOL_ACTIONS`). A move that waits for a human's approval is `awaiting_approval`. A
message sent during a request carries `TeamMessage.operatorRequest`. `GET /api/projects/:key/project-manager` returns
the channel (the manager's channel plus the last 50 requests with their steps, the newest last) to a person's own login
(the owners' requests to an owner, their own to anyone else); no WebSocket event.

## System signals

`services/coordination/signals.ts`. Provider and engine outages, input stalls and working sessions silent for 30
minutes create one signal per unresolved case. A 60-second sweep and domain events reconcile the sources. The sweep
checks `WorkOutages.activeIds` only after its first evaluation (`null` means not yet observed), so startup card events
cannot resolve an outage before provider checks finish. An acknowledged alert followed by a restart cannot leave a
recovered outage signal unresolved and suppress the next episode of the same outage id. Admission persists refused
`operator_signals` starts; notices enter the project manager's general conversation as projectman input, without a team
message or an owner request. A persisted `delivered_at` keeps the 15-minute project wake interval across restarts.
Delivered signals become open when presented or when the turn ends; startup recovers delivered pending rows.
Undelivered rows never appear in REST or WS. `send_message` may present a delivered signal to owners without a request
(only the selected project manager; `invalid_request` otherwise); question screening and signal triage are standing
duties, while other writes keep the request or signal-step guard. Owner acceptance records a visible message and the
signal decision atomically, and its delivery opens the usual owner request. Owner dismissal suppresses repeats until
resolution. Signal WS events reach owners only.

`merge_blocked` (`merge_blocked:<task>`; a `failed` or `blocked` merge with an AI merger, at once; a person as merger
gets the inbox item instead) is raised and closed by the same sweep from `OperatorSignals.boardRead` (`pending()`
rechecks a signal against it before waking the project manager).

Stalled work is watched in one place: the obligation ladder (`ObligationsService`). Its second rung, `tell_pm`, writes
`pm_told_at`, moves the due time on by one step and raises an `obligation_overdue` signal
(`obligation_overdue:<obligation id>`) through `OperatorSignals.raiseObligationOverdue`; the signal then follows the
usual delivery rules (grouping, the 15-minute project wake interval). The case holds while the obligation is `open` and
`pm_told_at` is set; the 60-second sweep resolves the row once the obligation is fulfilled, closed or handed over. The
`next_step` obligation kind follows every open card by the rule `cardDuty`, and the project manager gets a card nobody
can take (class `unowned`) as the `wake` and `tell_pm` rungs of that ladder, not as a second signal.
`ARCHITECTURE.md`, "Obligation tracking", holds the principle (an event only speeds things up, the once-a-minute sweep
over the board is what is relied on). Older signal kinds (`idle`, `merge_waiting`, `ready_waiting`, `work_stalled`,
`refinement_stalled`, `nobody`) stay in the union and in `RETIRED_KINDS` only so old rows and timeline events keep
rendering; the sweep resolves an open row of such a kind.

**`senior_wait` (PM-1251).** The `senior_wait` obligation's hand-over raises it (`senior_wait:<obligation id>`,
`OperatorSignals.raiseSeniorWait`) when a card waits past `seniorWaitMinutes` for a developer whose limit reaches its
points; its facts name the card, the Seniors, since when and the points. The case holds while the obligation is
`handed_over` and has no `decision`; the pm's `decide_senior_wait` (coordinator only, `SeniorDecisions.decide`) sets it,
so the next sweep resolves the signal. A project without a pm gets the old owner question instead.

The project manager may use `dismiss_signal { signal_id, note }` without an owner request at every watch level
(`team.operatorWatch`), for a delivered, unpresented, still valid `obligation_overdue`, `structural_pattern` or
`milestone_closed` signal and outside guest conversations. It stores the reason in `decision_note` (outside the DTO)
and publishes the decision to owners. Presented signals remain the owners' to decide.

**Unreleased merges (PM-1333).** Merges waiting for a release no longer make a signal and start nobody: `releaseDue`
in `signals.ts` (run by the sweep) opens one `release_due` integrator todo per repository and base from
`unreleased(projectKey)` once its oldest merge is 24 hours old (`inbox.raiseAlert` with `onceSince`, so a todo closed
by hand does not reopen within 24 hours) and settles it with `settleAlert(..., { keep })` when the base moved. The
`unreleased` kind is in `RETIRED_KINDS`, so the sweep resolves old open rows; the project manager has no unreleased
step and its prompt names none.

**Owner-silent signals (PM-1243).** The owners get no question about an `unreleased`, `structural_pattern` or
`milestone_closed` signal (`OWNER_SILENT_SIGNAL_KINDS`, `ownerQuestionSignalRefusal` in
`packages/shared/src/config/operator-watch.ts`): the MCP `ask_human` with its `signal_id` answers
`signal_not_for_owner` and makes no inbox item. `unreleased` stays in the list for old rows only; a signal meant for
the coordinator alone is closed with `dismiss_signal`.

## Question screening

An AI member's `ask_human` question (the project manager's too, not a human's) is created in the inbox state
`screening` with `payload.screening.until` = now + `QUESTION_SCREENING_MINUTES` (10); no person sees it.
`QuestionScreening` (`core/inbox`) synchronizes screened questions into the member queue and wakes its driver. The
runtime member queue driver delivers them through admission and `MessageDelivery` from `runtime/delivery`;
`ScreeningEngineState` reports the member's engine availability. It wakes the project manager like
`operator_signals` (deferred start kind `question_screening`, no capacity, the general conversation, one notice with a
JSON line per question; `deliveredAt` is written after the first input).

The project manager settles each question with `screen_question` (a coordination tool, not in guest conversations, no
owner request): `answered` and `forwarded` resolve the item (`operator_answered`, `operator_forwarded`) and carry the
answer or the forward through `Messaging` (`answer` with an AI actor and the re-ask hint; `forwardQuestion`: an `action`
message with origin `question_forward` to the recipient, which wakes it without a card role, and an `info` message to
the asker); `moot` cancels it (`operator_moot`); `decision` and `todo` release it to the people
(`InboxService.releaseScreened`; a todo's options become Done and Cannot do it, and Cannot do it needs a reason). A
`decision` and a todo for the owner need `owner_topic`, one of the project's owner topics (`team.ownerDecisionTopics`,
owner-only, default the five built-in topics of `packages/shared` `owner-topics.ts`); the refusal
(`owner_topic_required`, `owner_topic_unknown`) lists the valid topics and leaves the question in screening. An
approval question records `approval` without one; the fallback and an integrator todo need none. The project manager's
own `ask_human` question (it is not screened: `coordinator_question`) and a re-ask need one too, unless they are
information or an approval. So does a question nobody screens (`unscreened_question`: the project has no project
manager, or the screening is off; a project manager on leave still counts, its questions wait): any AI member names the topic itself, or asks `recipient: integrator` and gets an
integrator todo with the system as issuer, or is refused with `owner_topic_required` and the guidance. The topic is
recorded in `payload.ownerTopic` and in `question_asked` and `question_screened`.

Every outcome writes a `question_screened` timeline event. A skipped screening (`screening_fallback`, PM-1249) no
longer gives a question to the owners, except an approval. A question that asked for the integrator becomes its todo
(`requested_integrator`); anything else is `wait_pm`: it stays in `screening` with `payload.screening.waiting`
(`since`, `reason`, `overdue?`) and the asker is told once, by an `info` message, that it waits for the project
manager. It waits at once when the project manager cannot take it (no project manager, AI off, on leave, the team
paused) and when admission defers or refuses the start, for every code (the item stays queued and the queue retries);
the project manager takes it when it is back. When `until` passes (`timeout`, `QuestionScreening.sweep`, a 30-second
timer and a startup sweep) the question is given to the project manager once more and marked `overdue`; it is never
released by time. `screen_question` answers `question_not_screening` only for a question that left screening, except `moot`. An asker may ask a settled question again with
`ask_human` `reask_of` and `reask_reason`, once per question; the new question is `open` and carries
`payload.unscreened`. `GET /api/projects/:key/inbox/screened?since=` (owner, admin) lists the latest 20 screened
questions and the count of today's. The owner's `GET /api/projects/:key/inbox?state=active` also returns `waiting`
(`waitingForOthers`, `packages/shared`): how many questions wait for the screening and how many integrator todos are
open, with the oldest time of each; it is a summary, never an item, and it is counted nowhere. `POST
/api/projects/:key/inbox/:itemId/pull` (owner's own login only) takes a question that waits for the project manager
(`payload.screening.waiting`) over: it opens to the owner by the `owner_pulled` route and leaves an `item_routed`
trace; a question that no longer waits answers `question_not_screening` (409).

Machine-dependent parts (the engine-side git of a document write, `merge.read_file`, `merge.commit_files`): see the
[machine-dependent inventory](../MACHINE-DEPENDENT.md).
