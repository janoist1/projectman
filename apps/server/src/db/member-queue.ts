import type {
  MemberQueueCloseReason,
  MemberQueueItem,
  MemberQueueItemKind,
  MemberQueueSource,
  MemberQueueState,
  MemberQueueSummary,
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
  outcome: string | null;
}

/** A source as the table keeps it: its type and its id within the type (`memberQueueSourceId`). */
export interface MemberQueueSourceKey {
  type: MemberQueueSource['type'];
  id: string;
}

/** A row as stored: the source in its table form (the internal `payload` column is the lanes' own). */
export interface StoredMemberQueueItem extends Omit<MemberQueueItem, 'source'> {
  source: MemberQueueSourceKey;
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

export interface MemberQueueClose {
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
    summaries: db.prepare(
      `SELECT member,
         SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN state = 'processing' THEN 1 ELSE 0 END) AS processing,
         SUM(CASE WHEN state = 'queued' AND wake = 1 THEN 1 ELSE 0 END) AS waking,
         MIN(CASE WHEN state = 'queued' THEN queued_at END) AS oldest
       FROM member_queue_items WHERE project_key = ? AND state IN ('queued','processing') GROUP BY member`,
    ),
    everQueued: db.prepare('SELECT 1 FROM member_queue_items WHERE project_key = ? AND member = ? LIMIT 1'),
    pendingWithoutItem: db.prepare(
      `SELECT p.project_key AS projectKey, p.message_id AS messageId, p.handle AS handle
       FROM team_message_pending AS p
       LEFT JOIN member_queue_items AS q ON q.project_key = p.project_key AND q.member = p.handle
         AND q.source_type = 'message' AND q.source_id = p.message_id
       WHERE q.id IS NULL ORDER BY p.seq`,
    ),
    openMessageNotPending: db.prepare(
      `SELECT q.* FROM member_queue_items AS q
       WHERE q.source_type = 'message' AND q.state IN ('queued','processing')
         AND NOT EXISTS (SELECT 1 FROM team_message_pending AS p WHERE p.message_id = q.source_id
           AND p.project_key = q.project_key AND p.handle = q.member)
       ORDER BY q.queued_at, q.rowid`,
    ),
    openOfType: db.prepare(
      `SELECT * FROM member_queue_items WHERE source_type = ? AND state IN ('queued','processing')
       ORDER BY queued_at, rowid`,
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
    /** The open counts per member that has any; a member with no open item is absent. */
    summaries(projectKey: string): MemberQueueSummary[] {
      return (
        statements.summaries.all(projectKey) as Array<{
          member: string;
          queued: number;
          processing: number;
          waking: number;
          oldest: string | null;
        }>
      ).map((row) => ({
        member: row.member,
        queued: row.queued,
        processing: row.processing,
        waking: row.waking,
        oldestQueuedAt: row.oldest,
      }));
    },
    everQueued(projectKey: string, member: string): boolean {
      return !!statements.everQueued.get(projectKey, member);
    },
    /** Pending message receipts (`team_message_pending`) that have no item yet, oldest first, for every project. */
    pendingMessagesWithoutItem(): Array<{ projectKey: string; messageId: string; handle: string }> {
      return statements.pendingWithoutItem.all() as Array<{
        projectKey: string;
        messageId: string;
        handle: string;
      }>;
    },
    /** Open message items whose receipt is no longer pending, for every project. */
    openMessageItemsNotPending(): StoredMemberQueueItem[] {
      return all(statements.openMessageNotPending.all());
    },
    /** The open items of one source type, for every project and member. */
    listOpenOfType(type: MemberQueueSource['type']): StoredMemberQueueItem[] {
      return all(statements.openOfType.all(type));
    },
  };
}
