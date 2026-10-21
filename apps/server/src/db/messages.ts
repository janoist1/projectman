import type { Actor, TeamMessage } from '@projectman/shared';
import {
  actorWithOriginMeta,
  CardVersion,
  hasSuperOrigin,
  MessageAttachmentRef,
  MessageKind,
  MessageSubject,
} from '@projectman/shared';
import type { Statement } from 'better-sqlite3';
import type { Db } from './database';
import { originMetaJson } from './actor-meta';
import { parseJson, toJson } from './json';
import { PENDING_MESSAGE_RECIPIENTS } from './message-pending';

interface MessageRow {
  seq: number;
  receipts: string | null;
  id: string;
  project_key: string;
  from_handle: string;
  to_handles: string;
  task_key: string | null;
  body: string;
  created_at: string;
  delivered_at: string | null;
  answer: string | null;
  relayed: string | null;
  operator_request: string | null;
  operator_signal: string | null;
  via: 'integrator' | null;
  /** The super mode's origin (PM-757); NULL on every older message. */
  actor_meta: string | null;
  origin: string | null;
  kind: string | null;
  version: string | null;
  subject: string | null;
  attachments: string | null;
}

/** A message without its body: who it is between and who read it. */
export type MessageSummary = Pick<TeamMessage, 'id' | 'from' | 'to' | 'receipts'>;

type SummaryRow = Pick<MessageRow, 'id' | 'from_handle' | 'to_handles' | 'receipts'>;

/** The files of a stored message; NULL (every message from before files) and anything unreadable: none. */
const attachmentsOf = (json: string | null): MessageAttachmentRef[] | undefined => {
  if (!json) return undefined;
  const parsed = MessageAttachmentRef.array().safeParse(parseJson(json, null));
  return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
};

/**
 * The full origin of a message sent in the super mode (PM-757), from the stored meta and the old columns
 * (`from_handle`, `via`); undefined for every other message, and for a row whose meta disagrees with them.
 */
const superActorOf = (r: MessageRow): Actor | undefined => {
  if (!r.actor_meta) return undefined;
  const actor = actorWithOriginMeta(
    { kind: 'ai', handle: r.from_handle, ...(r.via ? { via: r.via } : {}) },
    parseJson(r.actor_meta, null),
  );
  return hasSuperOrigin(actor) ? actor : undefined;
};

const toMessage = (r: MessageRow): TeamMessage => {
  const kind = MessageKind.safeParse(r.kind);
  const version = CardVersion.safeParse(parseJson(r.version, null));
  const subject = MessageSubject.safeParse(parseJson(r.subject, null));
  const attachments = attachmentsOf(r.attachments);
  const actor = superActorOf(r);
  return {
    id: r.id,
    projectKey: r.project_key,
    from: r.from_handle,
    to: parseJson<string[]>(r.to_handles, []),
    taskKey: r.task_key,
    body: r.body,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    ...(kind.success ? { kind: kind.data } : {}),
    ...(version.success ? { version: version.data } : {}),
    ...(subject.success ? { subject: subject.data } : {}),
    ...(r.receipts ? { receipts: parseJson(r.receipts, []) } : {}),
    ...(attachments ? { attachments } : {}),
    ...(r.via ? { via: r.via } : {}),
    ...(actor ? { actor } : {}),
    ...(r.origin
      ? { origin: parseJson<NonNullable<TeamMessage['origin']>>(r.origin, { kind: 'note', eventId: '' }) }
      : {}),
    ...(r.answer ? { answer: parseJson(r.answer, { inboxItemId: '', question: '', answer: '' }) } : {}),
    ...(r.relayed ? { relayed: parseJson(r.relayed, { sessionId: '', inReplyTo: '' }) } : {}),
    ...(r.operator_request ? { operatorRequest: r.operator_request } : {}),
    ...(r.operator_signal ? { operatorSignal: r.operator_signal } : {}),
  };
};

export function createMessageRepository(db: Db) {
  const statements = {
    get: db.prepare('SELECT * FROM team_messages WHERE id = ?'),
    hasNewerAction: db.prepare(`SELECT 1 FROM team_messages
        WHERE project_key = ? AND from_handle = ? AND task_key IS ?
        AND COALESCE(kind, 'action') = 'action'
        AND CASE WHEN json_valid(subject) THEN json_extract(subject, '$.inboxItemId') ELSE NULL END IS ?
        AND EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?)
        AND seq > (SELECT seq FROM team_messages WHERE id = ?) LIMIT 1`),
    hasNote: db.prepare(
      `SELECT 1 FROM team_messages WHERE project_key = ? AND from_handle = ?
       AND EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?)
       AND instr(body, ?) > 0 LIMIT 1`,
    ),
    insert: db.prepare(
      `INSERT INTO team_messages (id, project_key, from_handle, to_handles, task_key, body, created_at, delivered_at, receipts, answer, via, origin, kind, version, subject, relayed, operator_request, operator_signal, attachments, actor_meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    setAttachments: db.prepare('UPDATE team_messages SET attachments = ? WHERE id = ?'),
    countUnread: db.prepare(
      `SELECT COUNT(*) AS n FROM team_messages WHERE project_key = ?
       AND EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?)
       AND NOT EXISTS (SELECT 1 FROM json_each(receipts) WHERE json_extract(value, '$.handle') = ?
         AND json_extract(value, '$.readAt') IS NOT NULL)`,
    ),
    pending: db.prepare(`SELECT m.* FROM team_message_pending AS p
      JOIN team_messages AS m ON m.id = p.message_id
      WHERE p.project_key = ? AND p.handle = ? ORDER BY p.seq`),
    pendingObligationReminders: db.prepare(`SELECT m.* FROM team_message_pending AS p
      JOIN team_messages AS m ON m.id = p.message_id
      WHERE p.project_key = ? AND CASE WHEN json_valid(m.subject) THEN json_extract(m.subject, '$.type') ELSE NULL END = 'obligation'
      GROUP BY m.id ORDER BY m.seq`),
    pendingHandles: db.prepare(
      'SELECT handle FROM team_message_pending WHERE message_id = ? ORDER BY handle',
    ),
    pendingCount: db.prepare(`SELECT COUNT(*) AS n FROM team_message_pending
      WHERE project_key = ? AND handle = ?`),
    clearPending: db.prepare('DELETE FROM team_message_pending WHERE message_id = ?'),
    derivePending: db.prepare(`INSERT INTO team_message_pending (message_id, project_key, handle, seq)
      ${PENDING_MESSAGE_RECIPIENTS} AND m.id = ?`),
    involving: db.prepare(
      `SELECT id, from_handle, to_handles, receipts FROM team_messages WHERE project_key = ?
       AND (from_handle = ? OR EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?)) ORDER BY seq`,
    ),
    pendingFrom: db.prepare(
      `SELECT * FROM team_messages WHERE task_key = ? AND project_key = ? AND from_handle = ?
       AND delivered_at IS NULL AND receipts IS NOT NULL ORDER BY seq`,
    ),
    updateReceipts: db.prepare('UPDATE team_messages SET receipts = ?, delivered_at = ? WHERE id = ?'),
    markDelivered: db.prepare(
      'UPDATE team_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
    ),
  };
  /** SELECT statements of `list` per combination of filters. */
  const lists = new Map<string, Statement>();

  const get = (id: string): TeamMessage | null => {
    const row = statements.get.get(id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  };

  // Each caller owns a transaction, including standalone repository calls. better-sqlite3 nests
  // these as savepoints, so the enclosing domain unitOfWork can still roll back both tables.
  const pendingListeners: Array<(message: TeamMessage) => void> = [];
  const refreshPending = (id: string): void => {
    statements.clearPending.run(id);
    statements.derivePending.run(id);
    if (pendingListeners.length === 0) return;
    const message = get(id);
    if (message) for (const listener of pendingListeners) listener(message);
  };

  return {
    get,
    /**
     * `listener` runs inside the transaction of every write that may change who a message is still pending
     * for (a new message, a receipt change, a delivery), after the pending rows are derived anew (the member
     * queue keeps its message items equal to them, PM-894). It must be idempotent.
     */
    onPendingChange(listener: (message: TeamMessage) => void): void {
      pendingListeners.push(listener);
    },
    /** Every durable carrier, without a recent-message limit (shared question answers, PM-695). */
    listByAttachment(projectKey: string, attachmentId: string): TeamMessage[] {
      const rows = db
        .prepare(
          `SELECT * FROM team_messages WHERE project_key = ? AND
        EXISTS (SELECT 1 FROM json_each(attachments) WHERE json_extract(value, '$.id') = ?) ORDER BY seq`,
        )
        .all(projectKey, attachmentId) as MessageRow[];
      return rows.map(toMessage);
    },
    hasNewerAction(message: TeamMessage, recipient: string): boolean {
      const subject = message.subject?.type === 'permission' ? message.subject.inboxItemId : null;
      if (message.from === 'system' && subject === null) return false;
      return !!statements.hasNewerAction.get(
        message.projectKey,
        message.from,
        message.taskKey,
        subject,
        recipient,
        message.id,
      );
    },
    /** Whether `from` already sent `to` a message whose text holds `marker` (a once-only note's own key). */
    hasNote(projectKey: string, from: string, to: string, marker: string): boolean {
      return !!statements.hasNote.get(projectKey, from, to, marker);
    },
    insert(m: TeamMessage): void {
      db.transaction(() => {
        statements.insert.run(
          m.id,
          m.projectKey,
          m.from,
          toJson(m.to),
          m.taskKey,
          m.body,
          m.createdAt,
          m.deliveredAt,
          m.receipts ? toJson(m.receipts) : null,
          m.answer ? toJson(m.answer) : null,
          m.via ?? null,
          m.origin ? toJson(m.origin) : null,
          m.kind ?? null,
          m.version ? toJson(m.version) : null,
          m.subject ? toJson(m.subject) : null,
          m.relayed ? toJson(m.relayed) : null,
          m.operatorRequest ?? null,
          m.operatorSignal ?? null,
          m.attachments?.length ? toJson(m.attachments) : null,
          m.actor ? originMetaJson(m.actor) : null,
        );
        refreshPending(m.id);
      })();
    },
    /**
     * The file of the message is deleted: its entry keeps its place and gets `goneAt`/`goneBy`.
     * Returns the changed message; null when there is no such message or file, or it was gone already.
     */
    markAttachmentGone(messageId: string, attachmentId: string, at: string, by: Actor): TeamMessage | null {
      const message = get(messageId);
      const entry = message?.attachments?.find((a) => a.id === attachmentId);
      if (!message?.attachments || !entry || entry.goneAt) return null;
      const attachments = message.attachments.map((a) =>
        a.id === attachmentId ? { ...a, goneAt: at, goneBy: by } : a,
      );
      statements.setAttachments.run(toJson(attachments), messageId);
      return get(messageId);
    },
    /**
     * Most recent messages, oldest first. `member` and `participant` both match sender or recipient and
     * both apply when given: `participant` is the viewer's own narrowing, which no other filter widens.
     */
    list(
      projectKey: string,
      filter: {
        taskKey?: string;
        member?: string;
        participant?: string;
        between?: [string, string];
        unreadFor?: string;
        limit?: number;
      } = {},
    ): TeamMessage[] {
      let sql = 'SELECT * FROM team_messages WHERE project_key = ?';
      const params: Array<string | number> = [projectKey];
      if (filter.taskKey) {
        sql += ' AND task_key = ?';
        params.push(filter.taskKey);
      }
      for (const handle of [filter.member, filter.participant]) {
        if (!handle) continue;
        sql += ' AND (from_handle = ? OR EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?))';
        params.push(handle, handle);
      }
      if (filter.between) {
        const [a, b] = filter.between;
        sql +=
          ' AND ((from_handle = ? AND EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?)) OR (from_handle = ? AND EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?)))';
        params.push(a, b, b, a);
      }
      if (filter.unreadFor) {
        sql += ` AND EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?)
          AND NOT EXISTS (SELECT 1 FROM json_each(receipts) WHERE json_extract(value, '$.handle') = ? AND json_extract(value, '$.readAt') IS NOT NULL)`;
        params.push(filter.unreadFor, filter.unreadFor);
      }
      sql += ' ORDER BY seq DESC LIMIT ?';
      params.push(filter.limit ?? 200);
      let statement = lists.get(sql);
      if (!statement) {
        statement = db.prepare(sql);
        lists.set(sql, statement);
      }
      return (statement.all(...params) as MessageRow[]).reverse().map(toMessage);
    },
    /** Every message the member sent or got, oldest first, without its body: all a conversation list needs. */
    involving(projectKey: string, handle: string): MessageSummary[] {
      return (statements.involving.all(projectKey, handle, handle) as SummaryRow[]).map((r) => ({
        id: r.id,
        from: r.from_handle,
        to: parseJson<string[]>(r.to_handles, []),
        ...(r.receipts ? { receipts: parseJson(r.receipts, []) } : {}),
      }));
    },
    countUnread(projectKey: string, handle: string): number {
      return (statements.countUnread.get(projectKey, handle, handle) as { n: number }).n;
    },
    /** Messages to an AI recipient that were not typed into one of its sessions yet, oldest first. */
    pending(projectKey: string, handle: string): TeamMessage[] {
      return (statements.pending.all(projectKey, handle) as MessageRow[]).map(toMessage);
    },
    /**
     * The undelivered reminders of obligations (PM-813) with the handles still waiting for each, oldest first.
     * Narrow on purpose: the pending queue holds a few rows, and only those with an obligation subject are read.
     */
    pendingObligationReminders(projectKey: string): { message: TeamMessage; handles: string[] }[] {
      return (statements.pendingObligationReminders.all(projectKey) as MessageRow[]).map((row) => ({
        message: toMessage(row),
        handles: (statements.pendingHandles.all(row.id) as { handle: string }[]).map((h) => h.handle),
      }));
    },
    /** The handles one message is still pending for (`team_message_pending`). */
    pendingHandlesOf(messageId: string): string[] {
      return (statements.pendingHandles.all(messageId) as { handle: string }[]).map((h) => h.handle);
    },
    /** The same recipient set without reading or decoding message rows. */
    pendingCount(projectKey: string, handle: string): number {
      return (statements.pendingCount.get(projectKey, handle) as { n: number }).n;
    },
    /**
     * `from`'s messages about a card that are not typed into every AI recipient's session yet (PM-144),
     * oldest first: `delivered_at` stays null while an AI receipt has none.
     */
    pendingFrom(projectKey: string, from: string, taskKey: string): TeamMessage[] {
      return (statements.pendingFrom.all(taskKey, projectKey, from) as MessageRow[]).map(toMessage);
    },
    updateReceipts(
      id: string,
      receipts: NonNullable<TeamMessage['receipts']>,
      deliveredAt: string | null,
    ): TeamMessage | null {
      return db.transaction(() => {
        statements.updateReceipts.run(toJson(receipts), deliveredAt, id);
        refreshPending(id);
        return get(id);
      })();
    },
    markDelivered(id: string, at: string): TeamMessage | null {
      return db.transaction(() => {
        statements.markDelivered.run(at, id);
        refreshPending(id);
        return get(id);
      })();
    },
  };
}
