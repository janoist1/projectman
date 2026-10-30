# core/base

## Responsibility

Domain context, synchronous units of work, domain events and the websocket event bus.

## Facade

The entry point is `apps/server/src/core/base/index.ts`. It exports `createDomainContext`,
`DomainContext`, `isoNow`, `defaultTemplateRegistry`, `createTemplateRegistry`,
`TemplateRegistry`, `createDomainEvents`, `DomainEventMap`, `DomainEvents`,
`AddedRelation` and `createEventBus`. Other modules consume this facade; implementations
import their own siblings directly.

## Ports

`Repositories` (the `db` facade), `EventBus` (the `contracts` facade), a logger and
a clock are injected into the context. There is no separate `ports.ts`. Domain event
listeners connect modules without adding service-to-service dependencies. Units of
work publish buffered server events only after the database transaction commits.

The `SessionStartCause` event payload type comes directly from `@projectman/shared`,
without a runtime dependency on the sessions module (PM-632). `ConfigChange` and
`StageChange` are type-only imports from the `core/projects` and `core/tasks` facades.

## Files and ownership

Implementation paths under `apps/server/src`: `core/base/context.ts`,
`core/base/events.ts` and `core/base/event-bus.ts`, behind `core/base/index.ts`.
The authoritative descriptor is
[`core-base.ts`](../../apps/server/test/architecture/modules/core-base.ts),
imported by the single [module map](../../apps/server/test/architecture/module-map.ts).
The module is sealed and owns only `core/base/`; its id, layer, target and pass
remain unchanged. The existing tests remain in `apps/server/test/domain-events.test.ts`,
`apps/server/test/unit-of-work.test.ts` and `apps/server/test/ws.test.ts`, using the facade.

## Remote engine

The database, units of work and event bus remain on the server. No filesystem or process operation is introduced; engines receive the existing messages and RPC payloads.

PM-637 moves the implementations to their final module folder. It changes no
shared contract, database schema, configuration, timeline event or runtime behavior.

## Project change journal (PM-761, part of the super mode PM-757)

A durable, cursor-read record of what changed in a project, for the integrator's readers (and the
members' tools) to continue after an interruption or a restart of the hub. It says **that** something
changed and **which entity**; the content is read from the normal APIs. Nothing raw is stored: no terminal
text, chat text or secret, only ids.

- **Table.** `project_change_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, project_key, kind, entity_id,
at)`, index `(project_key, seq)` (migration 81). `seq` never goes back, also not after a delete of the
  newest row. Kinds: `task`, `timeline`, `message`, `inbox`, `configuration`, `pause`, `engine`,
  `handoff`, `operation`. No row is deleted automatically (a journal that forgets cannot tell a reader
  that it missed something).
- **Atomic with the change.** SQLite triggers on the state tables (`apps/server/src/db/change-triggers.ts`,
  the list in `CHANGE_TRIGGER_TABLES`) write the row in the transaction of the very statement. Many
  facades publish to the websocket after their write and outside a unit of work, so a row written from
  the bus would not be atomic; a trigger covers every write path (a facade, a sweep, the recovery of an
  interrupted configuration commit, which ends in the `projects` record update). A rollback, also of a
  nested unit of work, takes the row with it. A trigger writes only the metadata (project, kind, entity id,
  time), never a rule and never content.
- **Coverage matrix.** `CHANGE_TRIGGER_TABLES` lists the tables the card's read model is made of, with the
  statements that announce, the project and the entity: the card and its side tables (links, attachments,
  covers, fix limits, hand-ons and hand-overs, review pins, loops, waits, deferred starts, full-test runs)
  name the card key in kind `task` (a link names the card's project through the card, a
  card removed by a cascade is announced by its own row); `timeline_events`, `team_messages`,
  `message_attachments`, the inbox and its question groups, `task_handoffs`, the operator requests and
  their steps (the step names its request and the request's project), the super-operation audit,
  merges, merge trains, releases and doc writes have their own kinds; a pause of the whole
  instance is written for every project. `UNJOURNALED_TABLES` names every other table with the reason
  (credentials, login, usage, machine-local bookkeeping, Operator bookkeeping, the journal itself).
  `test/project-change-journal.test.ts` fails when a table is in neither list, in both, or a name is
  stale, so a new table makes someone decide. A migration that rebuilds a covered table drops its
  triggers and must create them again (the same test); a new state table needs a migration that calls
  `changeTriggerSql`.
- **Configuration.** The configuration is git's; the `projects` record carries its version
  (`config_version`). The `configuration` entry (entity `null`) is written when a project is created and
  when the record gets a **new** version, whichever path writes it (a commit, a revert, the sync from the
  store, the recovery of an interrupted operator execution or audit). A path that finds the record already
  at the version, or changes only its name or time, writes nothing, so a recovery that runs again does not
  repeat the signal. A git commit followed by a crash before the record update is finished by the existing
  reconciliation (`syncFromStore`, `settleSuperAudit`), which writes the entry
  in the transaction of the record.
- **Engines.** `engine` entries name the engine registry's changes (`EngineRegistry`,
  `runtime/sessions/engine-registry.ts`): the registry's write (create, revoke, set the default, the first
  sight of an engine and a changed hello) and the entries of the projects it concerns are one
  `repos.transaction`. An engine concerns the projects with a session stored on it and, while it is the
  default (before or after the write), every project, because new sessions go to the default. The online
  flag is memory and a heartbeat of the last-seen time is not a change; neither is journaled (the journal
  is never trimmed, so a heartbeat every minute would grow it for ever). The registry wakes the readers
  after the commit (`useJournalWake`).
- **The wake only notifies.** `ChangeJournal` (`core/base/change-journal.ts`): waiting readers are woken by
  the domain event bus (any event with a `projectKey` but the noisy ones: member state, plan usage,
  chat), by `record` and `notify`, and by a one second safety read of the database while a wait is open; a
  reader always reads the database. A reader reads, subscribes, and reads again, so a commit in between is
  not missed. `record(projectKey, kind, entityId | null)` is for a change no trigger covers; a path a
  trigger covers does not log a second time.
- **Reading.** `GET /api/projects/:key/events?after=<cursor>&limit=100&waitMs=25000` answers
  `{events, nextCursor}`; `limit` 1..500, `waitMs` 0..25000, no `after`: from the start of the journal. The
  cursor is base64url JSON `{version:1, generation, projectKey, seq}` with `seq` as a decimal **string**
  (no number precision loss); a malformed cursor or one of another project is `400 invalid_event_cursor`,
  one of another generation (or past the end of this journal) is `409 event_cursor_expired`. The same cursor
  works after a restart: the generation is a UUID stored in `instance_meta` under
  `project_change_generation`, made once with the database (migration 81) and never changed by a restart.
- **Access during the wait.** Every member (PM-79: a client reads like a viewer). The credential and the
  membership are checked again on every wake and before the answer: a key revoked or expired during the
  wait gets `401 integrator_key_invalid` at once (revocation wakes the waiter, expiry has a timer), a
  member who lost access gets the refusal instead of entries. A stopping server ends the waits with
  `server_stopping`.
- **Restoring a snapshot.** A database restored from an older copy must get a new generation
  (the `UPDATE instance_meta … WHERE key = 'project_change_generation'` in `docs/AWS.md` and
  `docs/HYBRID.md`; replacing it is mandatory); the restore steps there say so. Without it a cursor from the lost journal could
  continue into a different history (a cursor past the end of the restored journal is refused anyway).
