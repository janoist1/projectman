# core/inbox

## Responsibility

Human questions, approvals, permission decisions, question screening/closing and the open-question label.

## Facade

`core/inbox/index.ts` is the sealed entry point. It exports `InboxService` with `createInboxService`, the `PERMISSION_OPTIONS`, `DECISION_OPTIONS` and `ANSWER_OPTION` constants, `sponsorOrOwners`, `delegatedPermissionPrompt`, `answerText`, the `Resolver` and `InboxDecider` types, `ApprovalQuestions`, `CardQuestions` with `QUESTION_LIMIT`, `AgentQuestions` with `agentQuestionsOf`, `QuestionClosing`, `QuestionScreening`, `OpenQuestionLabel` and the port types below. The implementation moved here unchanged (PM-643); no question or approval contract changed.

## Ports

`core/inbox/ports.ts` defines the consumer-owned interfaces (PM-635):

- `InboxPermissionPolicy` supplies `engineIdOf`, `readableRootsFor` and `commandVerdict`. Assembly injects the existing functions from the `runtime/sessions` facade once; engine defaults and command rules remain defined there.
- `ScreeningAttempt` is the narrow automatic start for question screening, with the unchanged persisted spec `{ kind: 'question_screening', projectKey }` and the existing validity, run, retry, waiting and logging callbacks.
- `ScreeningAdmission` admits that attempt and starts the Operator's general conversation. `EnsureSessionResult` comes from the contracts facade; all other data shapes come from shared.
- `ScreeningSessions` exposes only `findRunning` and `isPaused`. Delivery uses `Pick<MessageDeliveryPort, 'notice' | 'startAndDeliver'>` from the messaging facade.

Assembly passes the existing session orchestrator, admission and delivery instances without casts. The waking/again/firstDeliveries maps, admission lock boundary, first-input rejection handler and delivered-at transaction order are unchanged, as are the screening option and 30-second sweep.

The inbox also receives the domain context, projects, timeline, `EngineDirectory` and an optional attachment-directory callback. Existing `InboxDecider`, `QuestionAnswerer` and `AskerStarts` hooks connect decisions and answering work. The permission broker and engine contracts are unchanged. No runtime module is imported by this module; its two dependency exceptions are removed.

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
Resolved primary projections include `answeredCount`, the number of distinct original questions
with durable human answer messages. Source-card deletion and delivery receipts never change it.

This is server-side state and uses the existing message and attachment transfer paths. No
machine-dependent part or new engine-boundary method is added.

## Remote engine (existing permission requests)

Questions, approval records and rules remain on the server. Permission requests retain the session engine's paths, and the existing broker/engine contracts carry decisions to that engine. `InboxService` still checks a tool's canonical working directory through that engine's `realpath` before consulting its injected policy. Server paths must not replace engine paths; PM-635 adds no boundary method or payload.

PM-631 prepares file ownership; PM-635 introduces these ports. Neither changes a
shared contract, database schema, configuration or timeline event.
