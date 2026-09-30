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
}

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
});

export function createMessageRepository(db: Db) {
  const statements = {
    get: db.prepare('SELECT * FROM team_messages WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO team_messages (id, project_key, from_handle, to_handles, task_key, body, created_at, delivered_at, receipts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    },
    /** Most recent messages, oldest first. `member` matches sender or recipient. */
    list(
      projectKey: string,
      filter: {
        taskKey?: string;
        member?: string;
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
      if (filter.member) {
        sql += ' AND (from_handle = ? OR EXISTS (SELECT 1 FROM json_each(to_handles) WHERE value = ?))';
        params.push(filter.member, filter.member);
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
