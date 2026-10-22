import type { SystemFeedbackForwardingMode, SystemFeedbackState } from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

/** Where an item went on: a card of this installation, or an issue of the public repository. */
export interface SystemFeedbackForwardedRecord {
  kind: 'card' | 'issue';
  projectKey: string | null;
  taskKey: string | null;
  url: string | null;
  /** The user (`users.id`) who sent it on; null: the server did, in card mode. */
  by: string | null;
  at: string;
}

export interface SystemFeedbackItemRecord {
  id: string;
  projectKey: string;
  title: string;
  what: string;
  workaround: string;
  fix: string;
  state: SystemFeedbackState;
  createdAt: string;
  lastSeenAt: string;
  version: string;
  sessionId: string | null;
  forwarded: SystemFeedbackForwardedRecord | null;
  dismissed: { reason: string; by: string; at: string } | null;
  cardError: { code: string; message: string; at: string } | null;
}

interface SystemFeedbackOccurrenceRecord {
  at: string;
  version: string;
  sessionId: string | null;
}

interface SystemFeedbackForwardingRecord {
  id: string;
  mode: SystemFeedbackForwardingMode;
  projectKey: string | null;
  changedBy: string;
  changedAt: string;
}

interface ItemRow {
  id: string;
  project_key: string;
  title: string;
  what: string;
  workaround: string;
  fix: string;
  state: string;
  created_at: string;
  last_seen_at: string;
  version: string;
  session_id: string | null;
  forwarded_kind: string | null;
  forwarded_project: string | null;
  forwarded_task: string | null;
  forwarded_url: string | null;
  forwarded_by: string | null;
  forwarded_at: string | null;
  dismissed_reason: string | null;
  dismissed_by: string | null;
  dismissed_at: string | null;
  card_error: string | null;
}

interface ForwardingRow {
  id: string;
  mode: string;
  project_key: string | null;
  changed_by: string;
  changed_at: string;
}

const toItem = (r: ItemRow): SystemFeedbackItemRecord => ({
  id: r.id,
  projectKey: r.project_key,
  title: r.title,
  what: r.what,
  workaround: r.workaround,
  fix: r.fix,
  state: r.state as SystemFeedbackState,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  version: r.version,
  sessionId: r.session_id,
  forwarded:
    r.forwarded_kind && r.forwarded_at
      ? {
          kind: r.forwarded_kind as 'card' | 'issue',
          projectKey: r.forwarded_project,
          taskKey: r.forwarded_task,
          url: r.forwarded_url,
          by: r.forwarded_by,
          at: r.forwarded_at,
        }
      : null,
  dismissed:
    r.dismissed_reason !== null && r.dismissed_by && r.dismissed_at
      ? { reason: r.dismissed_reason, by: r.dismissed_by, at: r.dismissed_at }
      : null,
  cardError: r.card_error
    ? parseJson<{ code: string; message: string; at: string } | null>(r.card_error, null)
    : null,
});

const toForwarding = (r: ForwardingRow): SystemFeedbackForwardingRecord => ({
  id: r.id,
  mode: r.mode as SystemFeedbackForwardingMode,
  projectKey: r.project_key,
  changedBy: r.changed_by,
  changedAt: r.changed_at,
});

/**
 * The system feedback of the installation (PM-472): items with their occurrences, and the append-only
 * forwarding setting. A state change is a conditional UPDATE that says whether it applied, so two requests
 * racing for the same item cannot both win.
 */
export function createSystemFeedbackRepository(db: Db) {
  const statements = {
    insertItem: db.prepare(`INSERT INTO system_feedback_items
      (id, project_key, title, what, workaround, fix, state, created_at, last_seen_at, version, session_id)
      VALUES (@id, @projectKey, @title, @what, @workaround, @fix, 'new', @createdAt, @createdAt, @version, @sessionId)`),
    insertOccurrence: db.prepare(
      'INSERT INTO system_feedback_occurrences (item_id, at, version, session_id) VALUES (?, ?, ?, ?)',
    ),
    get: db.prepare('SELECT * FROM system_feedback_items WHERE id = ?'),
    touch: db.prepare('UPDATE system_feedback_items SET last_seen_at = ? WHERE id = ?'),
    occurrences: db.prepare(
      'SELECT at, version, session_id FROM system_feedback_occurrences WHERE item_id = ? ORDER BY at, rowid',
    ),
    occurrenceCount: db.prepare('SELECT COUNT(*) AS n FROM system_feedback_occurrences WHERE item_id = ?'),
    createdSince: db.prepare(
      'SELECT COUNT(*) AS n FROM system_feedback_items WHERE project_key = ? AND created_at >= ?',
    ),
    forward: db.prepare(`UPDATE system_feedback_items SET state = 'forwarded', card_error = NULL,
      forwarded_kind = @kind, forwarded_project = @projectKey, forwarded_task = @taskKey, forwarded_url = @url,
      forwarded_by = @by, forwarded_at = @at WHERE id = @id AND state = 'new'`),
    dismiss: db.prepare(`UPDATE system_feedback_items SET state = 'dismissed', dismissed_reason = ?,
      dismissed_by = ?, dismissed_at = ? WHERE id = ? AND state = 'new'`),
    restore: db.prepare(`UPDATE system_feedback_items SET state = 'new', dismissed_reason = NULL,
      dismissed_by = NULL, dismissed_at = NULL WHERE id = ? AND state = 'dismissed'`),
    cardError: db.prepare("UPDATE system_feedback_items SET card_error = ? WHERE id = ? AND state = 'new'"),
    newCount: db.prepare("SELECT COUNT(*) AS n FROM system_feedback_items WHERE state = 'new'"),
    newCountOf: db.prepare(
      "SELECT COUNT(*) AS n FROM system_feedback_items WHERE state = 'new' AND project_key = ?",
    ),
    insertForwarding: db.prepare(`INSERT INTO system_feedback_forwarding
      (id, mode, project_key, changed_by, changed_at) VALUES (@id, @mode, @projectKey, @changedBy, @changedAt)`),
    forwardingHistory: db.prepare(
      'SELECT * FROM system_feedback_forwarding ORDER BY changed_at DESC, rowid DESC LIMIT ?',
    ),
  };
  return {
    /** Inserts a new item and its first occurrence. */
    insert(item: {
      id: string;
      projectKey: string;
      title: string;
      what: string;
      workaround: string;
      fix: string;
      createdAt: string;
      version: string;
      sessionId: string | null;
    }): void {
      statements.insertItem.run(item);
      statements.insertOccurrence.run(item.id, item.createdAt, item.version, item.sessionId);
    },
    get(id: string): SystemFeedbackItemRecord | null {
      const row = statements.get.get(id) as ItemRow | undefined;
      return row ? toItem(row) : null;
    },
    /** The items, the latest seen first; `projectKey` limits them to one project. */
    list(opts: {
      projectKey?: string;
      limit: number;
      /** Only the items in this state. */
      state?: SystemFeedbackState;
    }): SystemFeedbackItemRecord[] {
      const where = [
        ...(opts.projectKey ? ['project_key = @projectKey'] : []),
        ...(opts.state ? ['state = @state'] : []),
      ];
      const rows = db
        .prepare(
          `SELECT * FROM system_feedback_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY last_seen_at DESC, rowid DESC LIMIT @limit`,
        )
        .all({ projectKey: opts.projectKey, state: opts.state, limit: opts.limit }) as ItemRow[];
      return rows.map(toItem);
    },
    /** A new occurrence of an item; the item has been seen now. */
    addOccurrence(id: string, occurrence: SystemFeedbackOccurrenceRecord): void {
      statements.insertOccurrence.run(id, occurrence.at, occurrence.version, occurrence.sessionId);
      statements.touch.run(occurrence.at, id);
    },
    occurrences(id: string): SystemFeedbackOccurrenceRecord[] {
      return (
        statements.occurrences.all(id) as { at: string; version: string; session_id: string | null }[]
      ).map((r) => ({ at: r.at, version: r.version, sessionId: r.session_id }));
    },
    occurrenceCount(id: string): number {
      return (statements.occurrenceCount.get(id) as { n: number }).n;
    },
    /** How many items the project opened since `since` (an ISO time), in any state. */
    createdSince(projectKey: string, since: string): number {
      return (statements.createdSince.get(projectKey, since) as { n: number }).n;
    },
    /** Sends a new item on; false when it is no longer new. */
    forward(id: string, to: SystemFeedbackForwardedRecord): boolean {
      return statements.forward.run({ id, ...to }).changes === 1;
    },
    dismiss(id: string, reason: string, by: string, at: string): boolean {
      return statements.dismiss.run(reason, by, at, id).changes === 1;
    },
    restore(id: string): boolean {
      return statements.restore.run(id).changes === 1;
    },
    /** Records why the card could not be opened (null clears it); only a new item has one. */
    setCardError(id: string, error: { code: string; message: string; at: string } | null): boolean {
      return statements.cardError.run(error ? toJson(error) : null, id).changes === 1;
    },
    newCount(projectKey?: string): number {
      const row = (projectKey ? statements.newCountOf.get(projectKey) : statements.newCount.get()) as {
        n: number;
      };
      return row.n;
    },
    appendForwarding(change: SystemFeedbackForwardingRecord): void {
      statements.insertForwarding.run(change);
    },
    /** The changes of the forwarding setting, the latest first. */
    forwardingHistory(limit: number): SystemFeedbackForwardingRecord[] {
      return (statements.forwardingHistory.all(limit) as ForwardingRow[]).map(toForwarding);
    },
  };
}
