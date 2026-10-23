# core/inbox

## Responsibility

Human questions, approvals, permission inbox items, question screening/closing and the open-question label.

## Facade

`core/inbox/index.ts` is the sealed entry point. It exports `InboxService` with `createInboxService`, the `DECISION_OPTIONS` and `ANSWER_OPTION` constants, `sponsorOrOwners`, `answerText`, the `Resolver` and `InboxDecider` types, `ApprovalQuestions`, `HumanQuestions`, `CardQuestions` with `QUESTION_LIMIT`, `AgentQuestions` with `agentQuestionsOf`, `QuestionClosing`, `QuestionScreening`, `OpenQuestionLabel` and `IntegratorTodoAccess`. The implementation moved here unchanged (PM-643); no question or approval contract changed.

`InboxService.waitForClose(id, signal)` registers the waiter synchronously and resolves with the closed
item. An abort drops the waiter, expires the item and resolves null. CLI permission decisions live in
`runtime/sessions/permission-broker.ts` (PM-960): the broker creates an inbox item, resolves command-rule
verdicts through `resolveByRule` and waits through `waitForClose`. Inbox creation, closure, publication,
waiters and permission delegation (including `delegatedPermissionPrompt`) remain here.

## Ports

`core/inbox/ports.ts` defines the consumer-owned interfaces (PM-635):

- `ScreeningEngineState` reports whether the screening member's engine is online and when it was last confirmed online.

Question screening synchronizes questions through `MemberQueue.syncInbox` and wakes the member queue's driver (PM-885). The runtime driver handles admission and delivery through `MessageDelivery` from `runtime/delivery`, using the screening lane to render questions and record delivery receipts.

The inbox receives the domain context, projects, timeline and optional `IntegratorTodoAccess`.
Existing `InboxDecider`, `QuestionAnswerer` and `AskerStarts` hooks connect decisions and answering work.
The runtime broker receives `EngineDirectory` and the optional attachment-directory callback directly;
the former `InboxPermissionPolicy` port is removed (PM-960). The permission broker and engine contracts
are unchanged. No runtime module is imported by this module; its two dependency exceptions are removed.

## Files

All files live in `apps/server/src/core/inbox/`: `index.ts`, `ports.ts`, `inbox.ts`, `approval-questions.ts`, `card-questions.ts`, `agent-question.ts`, `question-closing.ts`, `question-screening.ts` and `open-question-label.ts`.
The authoritative descriptor is
[`core-inbox.ts`](../../apps/server/test/architecture/modules/core-inbox.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts);
its only path is `core/inbox/` and the module is sealed.

## Shared owner questions (PM-695)

The selected PM's internal general session can combine two to ten equivalent screened owner
questions through `combine_questions`, without an owner request. Compatibility is a shared pure
rule; the PM establishes semantic equivalence and records its reason. Migration 70 retains the
original inbox rows and records the group in `question_groups` and `question_group_items`.
The oldest `(createdAt, id)` is the representative. Only that row falls back or appears as an
answerable owner item; linked rows remain pending on their own cards. Combining preserves the
earliest running deadline or smallest frozen budget, including before the delivery receipt.

Resolve, close, screening and fallback serialize through the primary resolution lock. A withdrawal
closes only the original membership. A withdrawn primary keeps representing the others, with a
server-only `groupWithdrawn` payload flag; the public projection exposes its source as withdrawn.
The last membership cancels the group. Waiting labels count live original questions on each card.
`QuestionGroupAnswerer` is the inbox-owned port: all live rows, human provenance, timeline events
and individually routed, idempotent messages commit together, before delivery starts.

The attachment service binds a human answer's files to its first actual recipient message, then
validates the remaining references through `shareForQuestionGroupAnswer`. The shared file is
readable only through a visible carrier message. `listByAttachment` enumerates every durable
carrier for reading and deletion; no recent-message limit hides a reference from recovery.
REST, websocket delivery and the web fake use the same shared group redaction rule. Linked
items carry only a pointer; full sources are projected on the primary at read time.
An original without a task key is a general source, with a null task key/title and its original
question text. It remains live until withdrawn and receives the answer on its general/session route.
Only an original with a task key whose card disappeared is deleted; its question is null, as is a
hidden card's question. The UI distinguishes general sources by null task key and non-null question.
Resolved primary projections include `answeredCount`, the number of distinct original questions
with durable human answer messages. Source-card deletion and delivery receipts never change it.

This is server-side state and uses the existing message and attachment transfer paths. No
machine-dependent part or new engine-boundary method is added.

## Integrator todos (PM-782)

Question addressing is durable payload data (`requestedRecipient`, `recipient`,
`integratorOpenedAt`, `integratorEscalatedAt`). Missing addressing means owner; there is no migration.
New `screen_question.todo` input requires a recipient; decisions, fallback and unscreened reasks
always remain owner work. Shared rules select the recipient, protect approvals even with malformed
raw payload fields, restrict human visibility to owners, exclude integrator work from human counts
and plan the handoff to the owners (no clock: on a pass-on or an unavailable Operator). Assignees remain real human handles.

`IntegratorTodoAccess` is a boolean port, defaulting to unavailable. `app.ts` checks current owners,
users, active explicit super credentials and `superAccessVerdict`; assembly passes it to inbox.
`resolveIntegratorTodo` is reached through the super-only REST/MCP adapter in
`services/super-operator/todo.ts`. It uses the same question lock and transactional answer delivery
as owner resolution, rechecking authenticated execution before persistence. The result carries
`resolution.integratorTodo` and the full super actor, never `ownerAnswerRelayed` or a decision candidate.
The owner can still resolve with their own login through normal resolution.
The guarded automatic removal of the last question's `waiting-answer` label runs as system
cleanup outside the caller's execution scope; generic label edits keep all credential checks.

The hub's `integrator-todos` maintenance job sweeps at startup and every 30 seconds, independently
of AI availability or engine connectivity. Handoff and resolution serialize on the same lock.
The sweep hands an item over only when the Operator does not work its queue (`integrator_unavailable`);
there is no 24-hour clock. A resolution accepted under the lock finishes first. Handoff records
`question_recipient_escalated` atomically with owner addressing and current owner assignees;
it sends no answer and does not release the waiting label. Existing inbox change triggers journal
opening, handoff and closure. No new machine operation or engine-boundary method is needed.

### Fix limit decisions (PM-801)

A fix-limit decision (`payload.fixLimit`, source `system`, only fix-limit options) can be addressed to the
integrator by `selectFixLimitRecipient` when the three extra rounds are used up, the lead passed it on, or no AI
member can decide; any other shape stays with the owners. `isIntegratorInboxItem` covers todos and these
decisions, so the sweep escalates both when the Operator is unavailable (`planIntegratorInboxEscalation`, event
`fix_limit_recipient_escalated`). The integrator resolves only through `resolveIntegratorFixLimit` (same question
lock, `integratorExecution()` and owner access checked again): `replan`, `reassign`, `another_round`, or passing
the same item to the owners with a reason. The text is built by `fix-limit-text.ts` in the project language.
Hub-side only; no engine-boundary method.

## Obligation todos (PM-806)

`ObligationsService` (`services/obligations`) hands a step whose responsible did not act to the
integrator through two inbox operations. `openIntegratorTodo` opens a question item that carries
`payload.obligation` (`kind`, `responsible`, `subject`) and the same `integratorOpenedAt` clock as any
integrator todo, so the owner handoff applies to it too; with no integrator available the owners
get it directly, which the `IntegratorTodoAccess` port decides. The item has no asker to answer: the
system is its source, so `resolveIntegratorTodo` and `resolve` record the result and send no message
(`answeredNotice` skips obligation todos).

`closeObligationTodo` cancels an open obligation todo when its step is fulfilled, cancelled or moved on.
The resolution rule is `obligation_closed` (`QuestionCloseRule`), recorded as the closing rule on the
item. The todo is found again by `ofInboxItem` / `inboxItemId` of the obligation row, so a crash between
creating the todo and writing the row does not open a second one. Obligation todos do not count as an
open person's question when the sweep decides whether the card is paused. No machine operation or
engine-boundary method is added.

## Remote engine (existing permission requests)

Questions, approval records and rules remain on the server. Permission requests retain the session engine's paths, and the existing broker/engine contracts carry decisions to that engine. The runtime permission broker checks a tool's canonical working directory through that engine's `realpath` before consulting the command policy. Server paths must not replace engine paths; PM-960 changes no boundary method or payload.

PM-631 prepares file ownership; PM-635 introduces these ports. Neither changes a
shared contract, database schema, configuration or timeline event.
