import type { InboxItem, InboxKind, InboxState } from '@projectman/shared';
import type { Statement } from 'better-sqlite3';
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

export interface InboxFilter {
  state?: InboxState;
  kind?: InboxKind;
  taskKey?: string;
  limit?: number;
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
  const statements = {
    get: db.prepare('SELECT * FROM inbox_items WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO inbox_items (id, project_key, kind, assignees, source, session_id, task_key, title, body, payload,
         options, state, resolution, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateAssignees: db.prepare(
      "UPDATE inbox_items SET assignees = ?, updated_at = ? WHERE id = ? AND state = 'open'",
    ),
    close: db.prepare(
      `UPDATE inbox_items SET state = ?, resolution = ?, updated_at = ? WHERE id = ? AND state = 'open'`,
    ),
    listOpen: db.prepare(`SELECT * FROM inbox_items WHERE state = 'open' ORDER BY seq`),
    listOpenOfKind: db.prepare(`SELECT * FROM inbox_items WHERE state = 'open' AND kind = ? ORDER BY seq`),
    gateRequest: db.prepare(
      `SELECT * FROM inbox_items WHERE project_key = ? AND kind = 'decision' AND task_key = ?
         AND json_extract(payload, '$.gate.requestId') = ? ORDER BY seq`,
    ),
    openGateRequests: db.prepare(
      `SELECT * FROM inbox_items WHERE project_key = ? AND kind = 'decision' AND state = 'open' AND task_key = ?
         AND json_extract(payload, '$.gate.fromStageId') = ? AND json_extract(payload, '$.gate.toStageId') = ?
       ORDER BY seq`,
    ),
    countOpenFor: db.prepare(
      `SELECT COUNT(*) AS n FROM inbox_items
       WHERE project_key = ? AND state = 'open' AND EXISTS (SELECT 1 FROM json_each(assignees) WHERE value = ?)`,
    ),
  };
  /** List statements per combination of filters. */
  const lists = new Map<string, Statement>();

  const get = (id: string): InboxItem | null => {
    const row = statements.get.get(id) as InboxRow | undefined;
    return row ? toItem(row) : null;
  };

  return {
    retireBoundary(
      id: string,
      state: 'cancelled' | 'expired',
      resolution: InboxItem['resolution'],
      at: string,
    ): void {
      db.prepare(
        "UPDATE inbox_items SET state = ?, resolution = ?, updated_at = ? WHERE id = ? AND kind = 'boundary'",
      ).run(state, toJson(resolution), at, id);
    },
    updateBoundary(id: string, payload: Record<string, unknown>, assignees: string[], at: string): void {
      db.prepare('UPDATE inbox_items SET payload = ?, assignees = ?, updated_at = ? WHERE id = ?').run(
        toJson(payload),
        toJson(assignees),
        at,
        id,
      );
    },
    get,
    insert(item: InboxItem): void {
      statements.insert.run(
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
    updateAssignees(id: string, assignees: string[], at: string): InboxItem | null {
      statements.updateAssignees.run(toJson(assignees), at, id);
      return get(id);
    },
    /** Changes state/resolution only while the item is still open; returns the item or null if it was not open. */
    close(
      id: string,
      state: Exclude<InboxState, 'open'>,
      resolution: InboxItem['resolution'],
      at: string,
    ): InboxItem | null {
      const changes = statements.close.run(state, resolution ? toJson(resolution) : null, at, id).changes;
      return changes > 0 ? get(id) : null;
    },
    /** Items of a project, oldest first. */
    list(projectKey: string, filter: InboxFilter = {}): InboxItem[] {
      const signature = [filter.state && 'state', filter.kind && 'kind', filter.taskKey && 'task'].join(',');
      let statement = lists.get(signature);
      if (!statement) {
        let sql = 'SELECT * FROM inbox_items WHERE project_key = @projectKey';
        if (filter.state) sql += ' AND state = @state';
        if (filter.kind) sql += ' AND kind = @kind';
        if (filter.taskKey) sql += ' AND task_key = @taskKey';
        statement = db.prepare(`${sql} ORDER BY seq DESC LIMIT @limit`);
        lists.set(signature, statement);
      }
      const params: Record<string, string | number> = { projectKey, limit: filter.limit ?? 500 };
      if (filter.state) params.state = filter.state;
      if (filter.kind) params.kind = filter.kind;
      if (filter.taskKey) params.taskKey = filter.taskKey;
      return (statement.all(params) as InboxRow[]).reverse().map(toItem);
    },
    /** Open items across all projects, optionally of one kind. */
    listOpen(kind?: InboxKind): InboxItem[] {
      const rows = (kind ? statements.listOpenOfKind.all(kind) : statements.listOpen.all()) as InboxRow[];
      return rows.map(toItem);
    },
    /** The decision items of one gate request of a task (`payload.gate.requestId`), oldest first. */
    listGateRequest(projectKey: string, taskKey: string, requestId: string): InboxItem[] {
      return (statements.gateRequest.all(projectKey, taskKey, requestId) as InboxRow[]).map(toItem);
    },
    /** Open decision items requesting to move a task from one stage to another, oldest first. */
    listOpenGateRequests(
      projectKey: string,
      taskKey: string,
      fromStageId: string,
      toStageId: string,
    ): InboxItem[] {
      return (statements.openGateRequests.all(projectKey, taskKey, fromStageId, toStageId) as InboxRow[]).map(
        toItem,
      );
    },
    countOpenFor(projectKey: string, handle: string): number {
      return (statements.countOpenFor.get(projectKey, handle) as { n: number }).n;
    },
  };
}
