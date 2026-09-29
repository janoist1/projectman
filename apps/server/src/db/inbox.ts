import type { InboxItem, InboxKind, InboxState } from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

interface InboxRow {
  seq: number;
  id: string;
  project_key: string;
  kind: string;
  assignees: string;
  source: string;
  session_id: string | null;
  task_key: string | null;
  title: string;
  body: string | null;
  payload: string;
  options: string;
  state: string;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

const toItem = (r: InboxRow): InboxItem => ({
  id: r.id,
  projectKey: r.project_key,
  kind: r.kind as InboxKind,
  assignees: parseJson<string[]>(r.assignees, []),
  source: r.source,
  sessionId: r.session_id,
  taskKey: r.task_key,
  title: r.title,
  body: r.body,
  payload: parseJson<Record<string, unknown>>(r.payload, {}),
  options: parseJson<InboxItem['options']>(r.options, []),
  state: r.state as InboxState,
  resolution: parseJson<InboxItem['resolution']>(r.resolution, null),
  createdAt: r.created_at,
});

export function createInboxRepository(db: Db) {
  const get = (id: string): InboxItem | null => {
    const row = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(id) as InboxRow | undefined;
    return row ? toItem(row) : null;
  };

  return {
    get,
    insert(item: InboxItem): void {
      db.prepare(
        `INSERT INTO inbox_items (id, project_key, kind, assignees, source, session_id, task_key, title, body, payload,
           options, state, resolution, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id,
        item.projectKey,
        item.kind,
        toJson(item.assignees),
        item.source,
        item.sessionId,
        item.taskKey,
        item.title,
        item.body,
        toJson(item.payload),
        toJson(item.options),
        item.state,
        item.resolution ? toJson(item.resolution) : null,
        item.createdAt,
        item.createdAt,
      );
    },
    /** Changes state/resolution only while the item is still open; returns the item or null if it was not open. */
    close(
      id: string,
      state: Exclude<InboxState, 'open'>,
      resolution: InboxItem['resolution'],
      at: string,
    ): InboxItem | null {
      const changes = db
        .prepare(
          `UPDATE inbox_items SET state = ?, resolution = ?, updated_at = ? WHERE id = ? AND state = 'open'`,
        )
        .run(state, resolution ? toJson(resolution) : null, at, id).changes;
      return changes > 0 ? get(id) : null;
    },
    /** Items of a project, oldest first. */
    list(
      projectKey: string,
      filter: { state?: InboxState; kind?: InboxKind; taskKey?: string; limit?: number } = {},
    ): InboxItem[] {
      let sql = 'SELECT * FROM inbox_items WHERE project_key = ?';
      const params: Array<string | number> = [projectKey];
      if (filter.state) {
        sql += ' AND state = ?';
        params.push(filter.state);
      }
      if (filter.kind) {
        sql += ' AND kind = ?';
        params.push(filter.kind);
      }
      if (filter.taskKey) {
        sql += ' AND task_key = ?';
        params.push(filter.taskKey);
      }
      sql += ' ORDER BY seq DESC LIMIT ?';
      params.push(filter.limit ?? 500);
      return (db.prepare(sql).all(...params) as InboxRow[]).reverse().map(toItem);
    },
    /** Open items across all projects, optionally of one kind. */
    listOpen(kind?: InboxKind): InboxItem[] {
      const rows = (
        kind
          ? db.prepare(`SELECT * FROM inbox_items WHERE state = 'open' AND kind = ? ORDER BY seq`).all(kind)
          : db.prepare(`SELECT * FROM inbox_items WHERE state = 'open' ORDER BY seq`).all()
      ) as InboxRow[];
      return rows.map(toItem);
    },
    countOpenFor(projectKey: string, handle: string): number {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM inbox_items
           WHERE project_key = ? AND state = 'open' AND EXISTS (SELECT 1 FROM json_each(assignees) WHERE value = ?)`,
        )
        .get(projectKey, handle) as { n: number };
      return row.n;
    },
  };
}

export type InboxRepository = ReturnType<typeof createInboxRepository>;
