import type { TeamMessage } from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

interface MessageRow {
  seq: number;
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
});

export function createMessageRepository(db: Db) {
  const get = (id: string): TeamMessage | null => {
    const row = db.prepare('SELECT * FROM team_messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  };

  return {
    get,
    insert(m: TeamMessage): void {
      db.prepare(
        `INSERT INTO team_messages (id, project_key, from_handle, to_handles, task_key, body, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(m.id, m.projectKey, m.from, toJson(m.to), m.taskKey, m.body, m.createdAt, m.deliveredAt);
    },
    /** Most recent messages, oldest first. `member` matches sender or recipient. */
    list(
      projectKey: string,
      filter: { taskKey?: string; member?: string; limit?: number } = {},
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
      sql += ' ORDER BY seq DESC LIMIT ?';
      params.push(filter.limit ?? 200);
      return (db.prepare(sql).all(...params) as MessageRow[]).reverse().map(toMessage);
    },
    markDelivered(id: string, at: string): TeamMessage | null {
      db.prepare('UPDATE team_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(
        at,
        id,
      );
      return get(id);
    },
  };
}

export type MessageRepository = ReturnType<typeof createMessageRepository>;
