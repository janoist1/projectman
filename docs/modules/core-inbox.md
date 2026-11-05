# core/inbox

## Responsibility

Human questions, approvals, permission inbox items, question screening/closing and the open-question label.

## Facade

`core/inbox/index.ts` is the sealed entry point. It exports `InboxService` with `createInboxService`, the `DECISION_OPTIONS` and `ANSWER_OPTION` constants, `sponsorOrOwners`, `answerText`, the `Resolver` and `InboxDecider` types, `ApprovalQuestions`, `HumanQuestions`, `CardQuestions` with `QUESTION_LIMIT`, `AgentQuestions` with `agentQuestionsOf`, `QuestionClosing`, `QuestionScreening`, `OpenQuestionLabel` and `IntegratorTodoAccess`.

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
The runtime broker receives `EngineDirectory` and the optional attachment-directory callback directly.
No runtime module is imported by this module.

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

## Todos for the connected Claude (recipient `integrator`)

Question addressing is durable payload data (`requestedRecipient`, `recipient`,
`integratorOpenedAt`, `integratorEscalatedAt`). Missing addressing means owner; there is no migration.
Decisions and unscreened reasks always remain owner work. A skipped screening (`timeout`, `unavailable`)
never opens a question for the owners unless it is an approval (PM-1249): any other waits for the project manager
(`wait_pm`, `payload.screening.waiting`). It keeps the integrator the asker named (PM-1243): `fallbackIntegratorTodo` (`packages/shared`) makes a todo of
a question with `requestedRecipient: integrator` that is not protected, grouped or under an owner topic, and
`releaseScreened` opens it through the todo path with the system as issuer (the asker asked the integrator
because it has no machine access itself) and records `question_screening_skipped`, not `question_screened`.
It opens in the integrator's queue also when no integrator is live. A todo's recipient is not chosen by
the asker or the screening member (PM-1243, PM-1246): `routeItem` (`packages/shared/src/domain/item-route.ts`) is the one
rule, and `InboxService.applyRoute` (`apply-route.ts`) executes it. A machine todo goes to the integrator's queue
whenever the question is not protected and the issuer has machine access, whether or not an integrator is connected;
an issuer without machine access sends it to the technical decider (PM-1139), and with none the request is refused
(`issuer_without_machine_access`). Nothing is ever opened for the owners as a fallback. The route is stored on the item
(`InboxItem.route`, column `route`) and written to the timeline as `item_routed`. `screen_question.todo.recipient` is
optional and does not decide; what only the owner may do is a `decision`, and the integrator passes a manual step the
owner alone can take on with `integrator_passed_on` (PM-714; `planIntegratorPassOn`). Shared rules protect approvals
even with malformed raw payload fields, restrict human visibility to owners and exclude the connected Claude's work
from human counts. Assignees remain real human handles.

Owner topics (PM-1190, PM-1243): `releaseScreened` checks, under the question lock after loading the
configuration, that a release by the project manager as `decision` names
one of the project's owner topics (`ownerTopicRefusal` in `packages/shared`); a protected question
records `approval` instead, and the system releases (fallback, the connected Claude's refusal) and every todo need none
(an `owner_topic` given with a todo is accepted and not recorded).
Signals (PM-1243): `ownerQuestionSignalRefusal` (`packages/shared`, `operator-watch.ts`) makes the MCP
`ask_human` refuse (`signal_not_for_owner`) a question tied by `signal_id` to an `unreleased`,
`structural_pattern` or `milestone_closed` signal; no inbox item is made.
`HumanQuestions.ask` applies the same rule to the coordinator's own question and to a re-ask,
except for information and approval questions, and refuses `ownerTopic` on any other member's
question (`owner_topic_not_allowed`). The topic lands in `payload.ownerTopic` and the
`question_asked`/`question_screened` events; older items and events without it keep rendering.

`IntegratorTodoAccess` is a boolean port, defaulting to unavailable. `app.ts` supplies the shared
`integratorSideAvailable(config, hasActiveSuperKey)` rule: some owner of the project has a live
super key (not revoked, not expired; `AuthService.hasActiveSuperKey`), whatever the project manager's leave or AI
switch; assembly passes it to inbox. Super credentials are checked when a client resolves the item.
`resolveIntegratorTodo` is reached through the super-only external MCP adapter (there is no REST route, PM-1030) in
`services/super-operator/todo.ts`. It uses the same question lock and transactional answer delivery
as owner resolution, rechecking authenticated execution before persistence. The result carries
`resolution.integratorTodo` and the full super actor, never `ownerAnswerRelayed` or a decision candidate.
The owner can still resolve with their own login through normal resolution.
The guarded automatic removal of the last question's `waiting-answer` label runs as system
cleanup outside the caller's execution scope; generic label edits keep all credential checks.

There is no sweep and no time limit (the `integrator-todos` maintenance job is gone, PM-1246): work waits in the
connected Claude's queue until it is resolved or the integrator passes it on. Handoff and resolution serialize on the
same lock; a resolution accepted under the lock finishes first. `escalateIntegratorItem` (`core/inbox/inbox.ts`)
hands an item to the owners under that lock only on the integrator's explicit pass-on, planned by
`planIntegratorPassOn`; it records the route (`integrator_pass_on`) and `item_routed`, sends no answer and does not
release the waiting label. Old `question_recipient_escalated` and `fix_limit_recipient_escalated` events keep
rendering. No server code writes `payload.operatorHandoff` any more (it is read only, so old items keep rendering; see
[services/super-operator](services-super-operator.md)). Closed items are refused with `inbox_item_closed`, other or
already handed-off items with `super_relay_refused`. No new machine operation or engine-boundary method is needed.

### Fix limit decisions (PM-801)

A fix-limit decision (`payload.fixLimit`, source `system`, only fix-limit options) can be addressed to the
connected Claude when the three extra rounds are used up, the lead passed it on, or no AI member can decide
(`isDelegableFixLimitDecision`); any other shape stays with the owners. `routeItem` kind `fix_limit` sends a delegable
decision to the integrator's queue while an integrator exists and otherwise opens it for the owners under the topic
`product_direction` (reason `no_integrator`); the route is on the item. `isIntegratorInboxItem` covers todos and these
decisions. The connected Claude resolves only through `resolveIntegratorFixLimit` (same question
lock, `integratorExecution()` and owner access checked again): `replan`, `reassign`, `another_round`, or passing
the same item to the owners with a reason. The text is built by `fix-limit-text.ts` in the project language.
Hub-side only; no engine-boundary method.

## Obligation todos (PM-806)

`ObligationsService` (`services/obligations`) hands a step whose responsible did not act to the
connected Claude through two inbox operations. `openIntegratorTodo` opens a question item that carries
`payload.obligation` (`kind`, `responsible`, `subject`) and the same `integratorOpenedAt` stamp as any
todo for the connected Claude, so the owner handoff applies to it too; with no connected Claude available the owners
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

Questions, approval records and rules remain on the server. Permission requests keep the session engine's paths, and the broker/engine contracts carry decisions to that engine. The runtime permission broker checks a tool's canonical working directory through that engine's `realpath` before consulting the command policy. Server paths must not replace engine paths. The machine-dependent inventory is [MACHINE-DEPENDENT.md](../MACHINE-DEPENDENT.md).
