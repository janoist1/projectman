import type {
  MemberQueueCloseReason,
  MemberQueueItem,
  MemberQueueItemKind,
  MemberQueueSource,
  MemberQueueState,
  OperatorQueueOutcome,
  WorkItemRef,
} from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

interface ItemRow {
  id: string;
  project_key: string;
  member: string;
  kind: MemberQueueItemKind;
  source_type: MemberQueueSource['type'];
  source_id: string;
  place: string;
  task_key: string | null;
  wake: number;
  state: MemberQueueState;
  title: string;
  from_handle: string | null;
  queued_at: string;
  started_at: string | null;
  closed_at: string | null;
  close_reason: MemberQueueCloseReason | null;
  attempts: number;
  restarted_at: string | null;
  session_id: string | null;
  wait_code: string | null;
  wait_at: string | null;
  wait_details: string | null;
  outcome: string | null;
}

/** What a refusal said besides its code and time (`waitingOf`): the provider, the engine, a threshold, … */
export type MemberQueueWaitDetails = Record<string, unknown>;

/** A source as the table keeps it: its type and its id within the type (`memberQueueSourceId`). */
export interface MemberQueueSourceKey {
  type: MemberQueueSource['type'];
  id: string;
}

/** A row as stored: the source in its table form (the internal `payload` column is the lanes' own). */
export interface StoredMemberQueueItem extends Omit<MemberQueueItem, 'source'> {
  source: MemberQueueSourceKey;
  /** What the refusal behind `wait` said besides its code; never shown as such. */
  waitDetails: MemberQueueWaitDetails | null;
}

export interface NewMemberQueueItem {
  id: string;
  projectKey: string;
  member: string;
  kind: MemberQueueItemKind;
  source: MemberQueueSourceKey;
  place: WorkItemRef;
  taskKey: string | null;
  wake: boolean;
  title: string;
  from: string | null;
  queuedAt: string;
  payload?: unknown;
}

interface MemberQueueClose {
  state: Extract<MemberQueueState, 'done' | 'handed_off' | 'cancelled'>;
  reason: MemberQueueCloseReason;
  at: string;
  /** Close only this member's item of the source; default: every member's. */
  member?: string;
  outcome?: OperatorQueueOutcome | null;
}

/** The task a place needs the workspace of; a place without one (a conversation, the desk) has none. */
const placeTaskKey = (place: WorkItemRef): string | null => (place.type === 'task' ? place.taskKey : null);

const toItem = (row: ItemRow): StoredMemberQueueItem => ({
  id: row.id,
  projectKey: row.project_key,
  member: row.member,
  kind: row.kind,
  source: { type: row.source_type, id: row.source_id },
  place: parseJson<WorkItemRef>(row.place, { type: 'general' }),
  wake: row.wake === 1,
  state: row.state,
  title: row.title,
  from: row.from_handle,
  taskKey: row.task_key,
  queuedAt: row.queued_at,
  startedAt: row.started_at,
  closedAt: row.closed_at,
  closeReason: row.close_reason,
  attempts: row.attempts,
  restartedAt: row.restarted_at,
  sessionId: row.session_id,
  wait: row.wait_code && row.wait_at ? { code: row.wait_code, at: row.wait_at } : null,
  waitDetails: parseJson<MemberQueueWaitDetails | null>(row.wait_details, null),
  outcome: parseJson<OperatorQueueOutcome | null>(row.outcome, null),
});

/**
 * The member queue (PM-894): a row per source and member (unique), open (`queued`, `processing`) or closed.
 * Every method that writes is one statement or runs in the caller's transaction.
 */
export function createMemberQueueRepository(db: Db) {
  const statements = {
    insert: db.prepare(
      `INSERT OR IGNORE INTO member_queue_items (id, project_key, member, kind, source_type, source_id, place,
         task_key, place_task_key, wake, state, title, from_handle, queued_at, payload)
       VALUES (@id, @projectKey, @member, @kind, @sourceType, @sourceId, @place, @taskKey, @placeTaskKey, @wake,
         'queued', @title, @from, @queuedAt, @payload)`,
    ),
    get: db.prepare('SELECT * FROM member_queue_items WHERE id = ?'),
    bySource: db.prepare(
      `SELECT * FROM member_queue_items
       WHERE project_key = ? AND member = ? AND source_type = ? AND source_id = ?`,
    ),
    openOfSource: db.prepare(
      `SELECT * FROM member_queue_items
       WHERE project_key = ? AND source_type = ? AND source_id = ? AND state IN ('queued','processing')
       ORDER BY queued_at, rowid`,
    ),
    open: db.prepare(
      `SELECT * FROM member_queue_items
       WHERE project_key = ? AND member = ? AND state IN ('queued','processing') ORDER BY queued_at, rowid`,
    ),
    closed: db.prepare(
      `SELECT * FROM member_queue_items
       WHERE project_key = ? AND member = ? AND state IN ('done','handed_off','cancelled') AND closed_at >= ?
       ORDER BY closed_at DESC, rowid DESC LIMIT ?`,
    ),
    close: db.prepare(
      `UPDATE member_queue_items SET state = @state, close_reason = @reason, closed_at = @at, outcome = @outcome
       WHERE id = @id AND state IN ('queued','processing')`,
    ),
    everQueued: db.prepare('SELECT 1 FROM member_queue_items WHERE project_key = ? AND member = ? LIMIT 1'),
    openOfType: db.prepare(
      `SELECT * FROM member_queue_items WHERE source_type = ? AND state IN ('queued','processing')
       ORDER BY queued_at, rowid`,
    ),
    // The urgency order is `memberQueueUrgency`; the CASE keeps SQL and the rule in step (test/member-queue.test.ts checks them).
    openByUrgency: db.prepare(
      `SELECT * FROM member_queue_items
       WHERE project_key = ? AND member = ? AND state IN ('queued','processing')
       ORDER BY CASE kind WHEN 'permission' THEN 0 WHEN 'fix_limit' THEN 1
         WHEN 'screening' THEN 1 WHEN 'todo' THEN 2 WHEN 'start' THEN 3 WHEN 'checklist' THEN 3 ELSE 4 END, queued_at, rowid`,
    ),
    openMembers: db.prepare(
      `SELECT DISTINCT project_key AS projectKey, member FROM member_queue_items
       WHERE state IN ('queued','processing') ORDER BY project_key, member`,
    ),
    claim: db.prepare(
      `UPDATE member_queue_items SET state = 'processing', session_id = @sessionId, started_at = @at,
         wait_code = NULL, wait_at = NULL, wait_details = NULL
       WHERE id = @id AND state = 'queued'`,
    ),
    requeue: db.prepare(
      `UPDATE member_queue_items SET state = 'queued', attempts = attempts + 1, restarted_at = @at,
         session_id = NULL, started_at = NULL
       WHERE id = @id AND state = 'processing'`,
    ),
    // A message item closed as delivered whose receipt says it was not: the victims of PM-1108.
    untypedMessages: db.prepare(
      `SELECT id FROM member_queue_items
       WHERE source_type = 'message' AND state = 'done' AND close_reason = 'delivered'
         AND EXISTS (
           SELECT 1 FROM team_messages AS m,
             json_each(CASE WHEN json_valid(m.receipts) THEN m.receipts ELSE '[]' END) AS r
           WHERE m.id = member_queue_items.source_id
             AND json_extract(r.value, '$.handle') = member_queue_items.member
             AND json_extract(r.value, '$.kind') = 'ai'
             AND json_extract(r.value, '$.deliveredAt') IS NULL)`,
    ),
    untypedRepairMark: db.prepare("SELECT 1 FROM instance_meta WHERE key = 'untyped_message_repair'"),
    untypedRepairSet: db.prepare(
      "INSERT OR REPLACE INTO instance_meta (key, value) VALUES ('untyped_message_repair', @at)",
    ),
    reopen: db.prepare(
      `UPDATE member_queue_items SET state = 'queued', close_reason = NULL, closed_at = NULL,
         session_id = NULL, started_at = NULL
       WHERE id = @id AND state = 'done' AND close_reason = 'delivered'`,
    ),
    release: db.prepare(
      `UPDATE member_queue_items SET state = 'queued', session_id = NULL, started_at = NULL
       WHERE id = @id AND state = 'processing'`,
    ),
    setWait: db.prepare(
      `UPDATE member_queue_items SET wait_code = @code, wait_at = @at, wait_details = @details
       WHERE id = @id AND state = 'queued'`,
    ),
    clearWait: db.prepare(
      `UPDATE member_queue_items SET wait_code = NULL, wait_at = NULL, wait_details = NULL
       WHERE id = @id AND wait_code IS NOT NULL`,
    ),
    move: db.prepare(
      `UPDATE member_queue_items SET place = @place, place_task_key = @placeTaskKey
       WHERE id = @id AND state IN ('queued','processing')`,
    ),
    wake: db.prepare(`UPDATE member_queue_items SET wake = @wake WHERE id = @id AND wake <> @wake`),
    payload: db.prepare('SELECT payload FROM member_queue_items WHERE id = ?'),
    setPayload: db.prepare('UPDATE member_queue_items SET payload = @payload WHERE id = @id'),
    openMessagesOfTask: db.prepare(
      `SELECT * FROM member_queue_items
       WHERE project_key = ? AND source_type = 'message' AND state IN ('queued','processing')
         AND (place_task_key = ? OR task_key = ?) ORDER BY queued_at, rowid`,
    ),
    openMessages: db.prepare(
      `SELECT * FROM member_queue_items
       WHERE source_type = 'message' AND state IN ('queued','processing') ORDER BY queued_at, rowid`,
    ),
    waitingOfTask: db.prepare(
      `SELECT * FROM member_queue_items
       WHERE project_key = ? AND state = 'queued' AND wake = 1 AND wait_code IS NOT NULL
         AND (place_task_key = ? OR task_key = ?) ORDER BY wait_at, rowid`,
    ),
    waiting: db.prepare(
      `SELECT * FROM member_queue_items
       WHERE state = 'queued' AND wake = 1 AND wait_code IS NOT NULL ORDER BY wait_at, rowid`,
    ),
  };
  const all = (rows: unknown): StoredMemberQueueItem[] => (rows as ItemRow[]).map(toItem);
  const listOpenOfSource = (projectKey: string, source: MemberQueueSourceKey): StoredMemberQueueItem[] =>
    all(statements.openOfSource.all(projectKey, source.type, source.id));

  return {
    /** Inserts a queued row; false when the source has an item for this member already (open or closed). */
    insert(item: NewMemberQueueItem): boolean {
      return (
        statements.insert.run({
          id: item.id,
          projectKey: item.projectKey,
          member: item.member,
          kind: item.kind,
          sourceType: item.source.type,
          sourceId: item.source.id,
          place: toJson(item.place),
          taskKey: item.taskKey,
          placeTaskKey: placeTaskKey(item.place),
          wake: item.wake ? 1 : 0,
          title: item.title,
          from: item.from,
          queuedAt: item.queuedAt,
          payload: item.payload === undefined ? null : toJson(item.payload),
        }).changes > 0
      );
    },
    get(id: string): StoredMemberQueueItem | null {
      const row = statements.get.get(id) as ItemRow | undefined;
      return row ? toItem(row) : null;
    },
    /** Internal lane data (written on insert, changed by `setPayload`), deliberately absent from the queue view; null: nothing. */
    payload<T = unknown>(id: string): T | null {
      const row = statements.payload.get(id) as { payload: string | null } | undefined;
      return row?.payload ? parseJson<T | null>(row.payload, null) : null;
    },
    setPayload(id: string, payload: unknown): boolean {
      return statements.setPayload.run({ id, payload: toJson(payload) }).changes > 0;
    },
    /** The member's item of this source, open or closed. */
    findBySource(
      projectKey: string,
      member: string,
      source: MemberQueueSourceKey,
    ): StoredMemberQueueItem | null {
      const row = statements.bySource.get(projectKey, member, source.type, source.id) as ItemRow | undefined;
      return row ? toItem(row) : null;
    },
    /** The open items of one source, for every member. */
    listOpenOfSource,
    /** The member's open items, the oldest first. */
    listOpen(projectKey: string, member: string): StoredMemberQueueItem[] {
      return all(statements.open.all(projectKey, member));
    },
    /** The member's items closed at or after `since`, the newest first. */
    listClosed(projectKey: string, member: string, since: string, limit: number): StoredMemberQueueItem[] {
      return all(statements.closed.all(projectKey, member, since, limit));
    },
    /** Closes the open items of a source (one member's, or every member's) and returns them as they were closed. */
    closeBySource(
      projectKey: string,
      source: MemberQueueSourceKey,
      close: MemberQueueClose,
    ): StoredMemberQueueItem[] {
      return db.transaction(() => {
        const closed: StoredMemberQueueItem[] = [];
        for (const item of listOpenOfSource(projectKey, source)) {
          if (close.member !== undefined && item.member !== close.member) continue;
          statements.close.run({
            id: item.id,
            state: close.state,
            reason: close.reason,
            at: close.at,
            outcome: close.outcome ? toJson(close.outcome) : null,
          });
          closed.push({
            ...item,
            state: close.state,
            closeReason: close.reason,
            closedAt: close.at,
            outcome: close.outcome ?? null,
          });
        }
        return closed;
      })();
    },
    everQueued(projectKey: string, member: string): boolean {
      return !!statements.everQueued.get(projectKey, member);
    },
    /** The open items of one source type, for every project and member. */
    listOpenOfType(type: MemberQueueSource['type']): StoredMemberQueueItem[] {
      return all(statements.openOfType.all(type));
    },
    /** The member's open items, most urgent first, then the oldest (`memberQueueUrgency`). */
    listOpenByUrgency(projectKey: string, member: string): StoredMemberQueueItem[] {
      return all(statements.openByUrgency.all(projectKey, member));
    },
    /** Every member that has an open item, in every project. */
    listOpenMembers(): Array<{ projectKey: string; member: string }> {
      return statements.openMembers.all() as Array<{ projectKey: string; member: string }>;
    },
    /** The open message items of one card, for every member (the card's place, or its message's card). */
    listOpenMessagesOfTask(projectKey: string, taskKey: string): StoredMemberQueueItem[] {
      return all(statements.openMessagesOfTask.all(projectKey, taskKey, taskKey));
    },
    /** Every open message item, for every project and member. */
    listOpenMessages(): StoredMemberQueueItem[] {
      return all(statements.openMessages.all());
    },
    /** The queued items of a card (its place, or the card they are about) that wake a session and wait for a code. */
    listWaitingOfTask(projectKey: string, taskKey: string): StoredMemberQueueItem[] {
      return all(statements.waitingOfTask.all(projectKey, taskKey, taskKey));
    },
    /** Every queued item that wakes a session and waits for a code, for every project and member. */
    listWaiting(): StoredMemberQueueItem[] {
      return all(statements.waiting.all());
    },
    /**
     * Takes a queued item for a session (compare and set): true for the one caller that got it; a second
     * claimer, or an item that is no longer queued, gets false.
     */
    claim(id: string, sessionId: string, at: string): boolean {
      return statements.claim.run({ id, sessionId, at }).changes > 0;
    },
    /** A processing item goes back to the queue, one attempt more (its session ended or got stuck). */
    requeue(id: string, at: string): boolean {
      return statements.requeue.run({ id, at }).changes > 0;
    },
    /** The ids of the message items that were closed as delivered while the receipt is still pending (read-only). */
    listUntypedMessages(): string[] {
      return (statements.untypedMessages.all() as Array<{ id: string }>).map((row) => row.id);
    },
    /** True once the one-time repair of the untyped messages (PM-1108) has run on this database. */
    untypedRepairDone(): boolean {
      return statements.untypedRepairMark.get() !== undefined;
    },
    markUntypedRepairDone(at: string): void {
      statements.untypedRepairSet.run({ at });
    },
    /** Opens a closed item again (a message item that was closed as delivered without being typed). */
    reopen(id: string): boolean {
      return statements.reopen.run({ id }).changes > 0;
    },
    /** A processing item goes back to the queue without a try counted (it was claimed but never reached the session). */
    release(id: string): boolean {
      return statements.release.run({ id }).changes > 0;
    },
    /** Notes why the queued item has not been started, and since when it was last seen so. */
    setWait(id: string, code: string, at: string, details?: MemberQueueWaitDetails): boolean {
      return statements.setWait.run({ id, code, at, details: details ? toJson(details) : null }).changes > 0;
    },
    clearWait(id: string): boolean {
      return statements.clearWait.run({ id }).changes > 0;
    },
    /** Moves an open item to another place (a closed card's message goes to the member's desk). */
    move(id: string, place: WorkItemRef): boolean {
      return statements.move.run({ id, place: toJson(place), placeTaskKey: placeTaskKey(place) }).changes > 0;
    },
    setWake(id: string, wake: boolean): boolean {
      return statements.wake.run({ id, wake: wake ? 1 : 0 }).changes > 0;
    },
  };
}
