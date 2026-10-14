# core/inbox

## Responsibility

Human questions, approvals, permission decisions, question screening/closing and the open-question label.

## Facade

`InboxService`, `ApprovalQuestions`, `CardQuestions`, `AgentQuestions`, `QuestionClosing`, `QuestionScreening` and `OpenQuestionLabel` currently live in `domain/`. The planned entry point is `core/inbox/index.ts`; this preparation changes no question or approval contract.

## Ports

The inbox receives the domain context, projects, timeline, `EngineDirectory` and an optional attachment-directory callback. Existing `InboxDecider`, `QuestionAnswerer` and `AskerStarts` hooks connect decisions and answering work. The permission broker and remaining runtime dependencies stay as implemented until the inbox slice.

## Current and planned files

Current paths under `apps/server/src`: `domain/inbox.ts`, `domain/approval-questions.ts`, `domain/card-questions.ts`, `domain/agent-question.ts`, `domain/question-closing.ts`, `domain/question-screening.ts`, `domain/open-question-label.ts`.
The planned folder is `apps/server/src/core/inbox/`.
The authoritative descriptor is
[`core-inbox.ts`](../../apps/server/test/architecture/modules/core-inbox.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its paths, pass, layer and sealed state are preserved by PM-631; later module slices
update only their own descriptor and this document. They do not edit the central map,
architecture table or other modules' importers.

## Remote engine

Questions, approval records and rules remain on the server. Permission requests retain the session engine's paths, and the existing broker/engine contracts carry decisions to that engine. Server paths must not replace engine paths; this card adds no boundary method or payload.

PM-631 only prepares file ownership for parallel refactor slices. It changes no
shared contract, database schema, configuration or timeline event.
