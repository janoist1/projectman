# core/messages

## Responsibility

Stored team messages, routing, recipient/card-role rules, stale-message checks and relation notices.

## Facade

`core/messages/index.ts` is the only entry point. It exports `MessageService`, `Messaging` with its factory `createMessaging`, `RelationNotices`, the staleness helpers (`wakesFor`, `wakeFactsFor`, `recipientHasCardRole`, `staleReasonFor`, `senderResultLabelFor`) and the port types below. It does not export `MessageDelivery`: the real delivery is `runtime/delivery`, which `domain/index.ts` re-exports and runtime callers import directly.

## Ports

`core/messages/ports.ts` defines the consumer-owned interfaces (PM-634):

- `MessageSessions` reads and starts the sessions a message goes to: `get`, `find`, `list`, `isRunning`, `findRunning`, `isPaused`, `ensureSession`, `restartWithMessages`, `requestReviewRound`, `sourceHead`, `cardWorkers`, `waitingPermissionFor`, `reviewRoundDue`, `permissionRestartDue` and `assertProviderCooldown`. `RelationNotices` needs only `list` and `isRunning`.
- `MessageDeliveryPort` types or holds a message: `deliver`, `deliverWithFirstInput`, `startAndDeliver`, `holdAsWritten`, `holdForPause`, `deliverWaiting`, `notice`, `noticeOrHold` and `holdUntilInput`. Question screening uses only `notice` and `startAndDeliver`.
- `MessageRefinement.turnMember` names the member whose refinement turn it is.
- `MessageRequests.open` opens the Operator request an owner's message or answer causes (PM-463); `MessageRequestInput` is its input.

`EnsureSessionOptions` and `EnsureSessionResult` live in `contracts/sessions.ts`; `SourceHead` and `CardWorker` in `contracts/context.ts`. `SessionStartCause` comes from `@projectman/shared`.

Assembly passes the existing session orchestrator, delivery, refinement steps and Operator requests instances; the registered waker, signals and card holds and their order are unchanged. `Messaging` also receives the domain context, core services, message attachment validation/binding and optional engine availability. No runtime or service module is imported by this module; its four dependency exceptions are removed.

## Files

All files live under `apps/server/src/core/messages/` (PM-642): `index.ts`, `ports.ts`, `messages.ts`
(stored messages), `messaging.ts` (routing, holds, notices), `relation-notices.ts`, `staleness.ts`
(wake and stale rules) and `tests/`. The old `domain/messaging/` folder and its re-exporting index are gone.
The authoritative descriptor is
[`core-messages.ts`](../../apps/server/test/architecture/modules/core-messages.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
Its only path is `core/messages/`, with `sealed: true`; id, layer, target and pass
remain unchanged. The central architecture was finalized in PM-645.

## Remote engine

Message records and routing rules stay on the server. Runtime delivery and engine availability use the existing transport to the recipient's engine. Session-folder message files remain covered by the machine-dependent inventory; no new delivery payload is introduced.

The ports are server-side interfaces over the existing instances and add no machine-dependent operation. CLI input still goes through the existing engine host and engine link; the 4 MiB frame limit, path handling and MCP replies are unchanged (PM-634).
