# core/member-queue

## Responsibility

Every AI member's durable queue of waiting work: storage and enqueue in `core/member-queue`, the driver that wakes
members from it in `runtime/member-queue`.

## Member queue (PM-894)

Every AI member has one durable queue of what is waiting for them: a message, an Operator todo, a fix limit decision
(later slices add permission requests, signals, obligations and starts). Slice A (PM-894) stores and shows; slice B
(PM-925) adds the driver that wakes members from the queue (see "Driver" below).

- **Storage**: `member_queue_items` (`apps/server/src/db/member-queue.ts`). One row per (project, member, source type,
  source id), unique, so enqueueing twice is a no-op. Columns: `kind` (`message`, `todo`, `fix_limit`, ...), the `place`
  the member works it in (a card, or `general` = the member's desk with no workspace), `wake`, `state`
  (`queued`, `processing`, `done`, `cancelled`), the close reason, `attempts`, a wait code and the Operator's outcome.
  The contract is `packages/shared/src/domain/member-queue.ts` (`MemberQueueItem`, `MemberQueueView`,
  `nominalMessagePlace`, `memberQueueSourceId`).
- **Enqueue**: `core/member-queue` (`MemberQueue`). The two source repositories run listeners inside the transaction of
  every write (`messages.onPendingChange`, `inbox.onChange`), so a row commits with its source and no call site has to
  remember it. A message gets an item for each AI recipient it is pending for (a receipt without `deliveredAt`; the
  `team_message_pending` table is gone since migration 99); the item closes
  `done`/`delivered` on delivery and `cancelled`/`source_closed` when the receipt is settled any other way. Since
  PM-1045 the Operator gets no item at all, and since PM-1076 (decision 66) it is no member: a message to the
  handle `operator` finds no member, and an integrator todo or narrow fix limit decision stays an open inbox item,
  which the connected client reads through the super-mode tools (`open_integrator_todo`,
  `resolveIntegratorTodo`). Migration 121 cancelled the Operator rows that were open (the inbox items stayed).
  Both reconcilers are idempotent and a failure is logged and never changes what the
  source write does.
- **Invariant**: the open message items are exactly the messages pending for an AI recipient. `recover()` runs at
  startup (after `messageAttachments.recover()`) and fills in what is missing or closes what is stale; running it again
  changes nothing. The pending counts, `get_project_state` and the diagnostics read the queue.
- **Driver** (PM-925, `apps/server/src/runtime/member-queue/`): `MemberQueueDriver` exposes `ensure(projectKey, member)`,
  `sweep()` and `register(lane)`. Everything that could give a member work (an item queued, a turn over, a hold lifted, a limit gone)
  calls `ensure`, which works the member's queue by level under a keyed mutex (idempotent, one run at a time): items
  whose source no longer owes them are cancelled, items on a closed card go to the desk or end (`place_closed`), a hold
  puts its code on the item, a live session gets its items at the turn boundary, and the first waking item without a
  session starts one through `admission.start`. A refused start leaves the items queued with `wait` (code plus
  `wait_details`); there is no deferred-start row for it. The sweep (`DomainOptions.memberQueueSweepMs`, default 30 s,
  in the kernel's sweep list) calls `ensure` for every member with an open item, so a lost wake or a limit that lifted
  without an event is found at the next sweep. A lane (`MemberQueueLane`) says what its items are; the message lane
  delivers as before (receipt and item close together). Items a session works (`processing`) return to the queue
  when the session is gone, after `MEMBER_QUEUE_MAX_ATTEMPTS` they are handed off, and after 45 minutes the session is
  stopped. An old `message_wake` deferred-start row is read once (`ensure`) and deleted.
- **API** (`apps/server/src/api/member-queue.ts`): `GET /api/projects/:key/operator/queue` only (PM-1030 deleted the
  per-member and all-members routes; nothing called them). Access: a person's own login (developer or more) or
  an integrator read or super key. Legacy keys fail authentication with 401 (PM-1037). The route stays for the old Operator rows and is empty for a project after migration 121.
- **WebSocket**: `member_queue_changed {projectKey, member}`, once per member per unit of work. Clients do not see it.
- **Remote engine**: no machine-dependent part is added. The queue, the driver and the sweep live on the hub with the
  database; only the session start crosses to an engine, as before. A member whose engine is offline waits with
  `engine_offline` as the item's wait, and the sweep starts it when the engine is back.
