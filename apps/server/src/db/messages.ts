import type { TeamMessage } from '@projectman/shared';
import type { Statement } from 'better-sqlite3';
import type { Db } from './database';
import { parseJson, toJson } from './json';

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
  via: 'integrator' | null;
  origin: string | null;
}

/** A message without its body: who it is between and who read it. */
export type MessageSummary = Pick<TeamMessage, 'id' | 'from' | 'to' | 'receipts'>;

type SummaryRow = Pick<MessageRow, 'id' | 'from_handle' | 'to_handles' | 'receipts'>;

const toMessage = (r: MessageRow): TeamMessage => ({
  id: r.id,
  projectKey: r.project_key,
  from: r.from_handle,
  to: parseJson<string[]>(r.to_handles, []),
  taskKey: r.task_key,
  body: r.body,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
  ...(r.receipts ? { receipts: parseJson(r.receipts, []) } : {}),
  ...(r.via ? { via: r.via } : {}),
  ...(r.origin
    ? { origin: parseJson<NonNullable<TeamMessage['origin']>>(r.origin, { kind: 'note', eventId: '' }) }
    : {}),
  ...(r.answer ? { answer: parseJson(r.answer, { inboxItemId: '', question: '', answer: '' }) } : {}),
});

export function createMessageRepository(db: Db) {
  const statements = {
    get: db.prepare('SELECT * FROM team_messages WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO team_messages (id, project_key, from_handle, to_handles, task_key, body, created_at, delivered_at, receipts, answer, via, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    countUnread: db.prepare(
      `SELECT COUNT(*) AS n FROM team_messages WHERE project_key = ?
       AND EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?)
       AND NOT EXISTS (SELECT 1 FROM json_each(receipts) WHERE json_extract(value, '$.handle') = ?
         AND json_extract(value, '$.readAt') IS NOT NULL)`,
    ),
    addressedTo: db.prepare(
      `SELECT * FROM team_messages WHERE project_key = ? AND
       EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?) ORDER BY seq`,
    ),
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

  return {
    get,
    insert(m: TeamMessage): void {
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
      );
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
      return (statements.addressedTo.all(projectKey, handle) as MessageRow[])
        .map(toMessage)
        .filter((m) =>
          m.receipts
            ? m.receipts.some((r) => r.handle === handle && r.kind === 'ai' && !r.deliveredAt)
            : !m.deliveredAt,
        );
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
      statements.updateReceipts.run(toJson(receipts), deliveredAt, id);
      return get(id);
    },
    markDelivered(id: string, at: string): TeamMessage | null {
      statements.markDelivered.run(at, id);
      return get(id);
    },
  };
}
