# core/messages

## Responsibility

Stored team messages, sending and recipient/card-role rules, stale-message checks and relation notices.
Runtime placement, holds, delivery and wake-up decisions live in `runtime/delivery/MessageRouter`
and are accessed through the consumer-owned `MessageRouting` port (PM-961).
Direct session chat and the description/joined/answered/closed notices live in
`runtime/delivery/SessionMessages` (PM-962). `Messaging.prepareSessionChat` keeps the checks
and injected-message framing; `recordSessionChat` records the undelivered message after the
runtime has ensured the session. Mentions and relation notices still use the core send path.
Shared notice text lives in `agent-text/message-notices.ts`.

`SendOptions.workerCheck` is an opt-in of `sendReporting`. Before review-round requests,
repinning, events or message records, `cardBusyOf` predicts recipients joining an open non-theme
card using `holdOf`, `place` and the shared wake rule. Existing card workers and project managers
never count as joining. The sender and the outgoing handoff member do not count as
other workers. Shared `cardBusyGroups` groups the remaining workers and joining recipients by
AI role, returning 409 `card_busy` with `CardBusyDetails` for collisions, including two new
recipients of the same role in one send.

Only REST team-message sends, MCP `send_message` and the project manager's `start_member` opt in; callers can
confirm parallel work with `despiteWorkers: true` (`despite_workers` in MCP). The web asks first (the card-busy
dialog, `useCardBusySend`) and then repeats the send with `despiteWorkers: true`. Info messages and
other internal sends skip the check. The actual post-review-round placement stays in
its original position, so a newly queued full test still holds delivery.

## Facade

`core/messages/index.ts` is the only entry point. It exports `MessageService`, `Messaging` with its factory `createMessaging`, `RelationNotices`, the staleness helpers (`wakesFor`, `wakeFactsFor`, `recipientHasCardRole`, `staleReasonFor`, `senderResultLabelFor`), `MessageRefinement` and the routing port types below. `MessageDelivery`, `MessageRouter` and `SessionMessages` are exported by `runtime/delivery`, which assembly and runtime callers import through its facade.

## Ports

`core/messages/ports.ts` defines the consumer-owned interfaces:

- `MessageRouting` decides `place` and `holdOf` before recording, then `deliver` types in, holds or wakes each placed AI recipient. `MessageHoldName`, `MessagePlace`, `MessagePlacement` and `RecipientDelivery` describe its inputs and results. `Messaging` builds the send report from the result; ordinary delivery stays synchronous, while `awaitWake` waits for the wake-up results with the existing timeout.
- `MessageSessions` reads the sessions needed by the core: `find`, `isRunning`, `requestReviewRound`, `sourceHead` and `cardWorkers`, plus `list` for `RelationNotices` (which needs only `list` and `isRunning`).
- `MessageRefinement.turnMember` names the member whose refinement turn it is.
- `MessageRequests.open` opens the project manager's request (`OperatorRequests`) that an owner's message or answer causes; `MessageRequestInput` is its input.

`SourceHead` lives in `contracts/context.ts`; `SessionStartCause` comes from `@projectman/shared`.

Assembly passes the existing session orchestrator plus `MessageRouter` as
`routing`. `Messaging` also receives the domain context, core services and message attachment
validation/binding; refinement and engine availability are dependencies of the router. The router
owns waker and card-hold registration and release; signal registration stays in `Messaging`.
Placement and holds precede the message transaction, and delivery follows it. Hold order remains
engine, project manager exemption (a project manager is held only for its engine), handoff, refinement turn, fix limit, full test. No runtime or
service module is imported by this module.

## Files

All files live under `apps/server/src/core/messages/`: `index.ts`, `ports.ts`, `messages.ts`
(stored messages), `messaging.ts` (sending, recording and notices), `relation-notices.ts`, `staleness.ts`
(wake and stale rules) and `answer-evidence.ts`. The wake-up result test lives beside the runtime
router in `runtime/delivery/message-start-result.test.ts`.
The authoritative descriptor is
[`core-messages.ts`](../../apps/server/test/architecture/modules/core-messages.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its only path is `core/messages/`, with `sealed: true`.

## Remote engine

Message records and the runtime router stay on the server. Runtime delivery and engine availability use the existing
transport to the recipient's engine; CLI input goes through the engine host and engine link. The machine-dependent
parts (session-folder message files, the 4 MiB frame limit) are in [MACHINE-DEPENDENT.md](../MACHINE-DEPENDENT.md).
