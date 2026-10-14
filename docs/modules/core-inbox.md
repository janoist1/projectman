# core/inbox

## Responsibility

Human questions, approvals, permission decisions, question screening/closing and the open-question label.

## Facade

`InboxService`, `ApprovalQuestions`, `CardQuestions`, `AgentQuestions`, `QuestionClosing`, `QuestionScreening` and `OpenQuestionLabel` currently live in `domain/`. The planned entry point is `core/inbox/index.ts`; this preparation changes no question or approval contract.

## Ports

`core/inbox/ports.ts` defines the consumer-owned interfaces (PM-635):

- `InboxPermissionPolicy` supplies `engineIdOf`, `readableRootsFor` and `commandVerdict`. Assembly injects the existing functions from the `runtime/sessions` facade once; engine defaults and command rules remain defined there.
- `ScreeningAttempt` is the narrow automatic start for question screening, with the unchanged persisted spec `{ kind: 'question_screening', projectKey }` and the existing validity, run, retry, waiting and logging callbacks.
- `ScreeningAdmission` admits that attempt and starts the Operator's general conversation. `EnsureSessionResult` comes from the contracts facade; all other data shapes come from shared.
- `ScreeningSessions` exposes only `findRunning` and `isPaused`. Delivery uses `Pick<MessageDeliveryPort, 'notice' | 'startAndDeliver'>` from the messaging facade.

Assembly passes the existing session orchestrator, admission and delivery instances without casts. The waking/again/firstDeliveries maps, admission lock boundary, first-input rejection handler and delivered-at transaction order are unchanged, as are the screening option and 30-second sweep.

The inbox also receives the domain context, projects, timeline, `EngineDirectory` and an optional attachment-directory callback. Existing `InboxDecider`, `QuestionAnswerer` and `AskerStarts` hooks connect decisions and answering work. The permission broker and engine contracts are unchanged. No runtime module is imported by this module; its two dependency exceptions are removed.

## Current and planned files

Current paths under `apps/server/src`: `core/inbox/ports.ts`, `domain/inbox.ts`, `domain/approval-questions.ts`, `domain/card-questions.ts`, `domain/agent-question.ts`, `domain/question-closing.ts`, `domain/question-screening.ts`, `domain/open-question-label.ts`.
The planned folder is `apps/server/src/core/inbox/`.
The authoritative descriptor is
[`core-inbox.ts`](../../apps/server/test/architecture/modules/core-inbox.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update their own descriptor and this document, remove their dependency exceptions from
the central map and update architecture port descriptions and inventory references.

## Remote engine

Questions, approval records and rules remain on the server. Permission requests retain the session engine's paths, and the existing broker/engine contracts carry decisions to that engine. `InboxService` still checks a tool's canonical working directory through that engine's `realpath` before consulting its injected policy. Server paths must not replace engine paths; PM-635 adds no boundary method or payload.

PM-631 prepares file ownership; PM-635 introduces these ports. Neither changes a
shared contract, database schema, configuration or timeline event.
