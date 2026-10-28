import type { HostRequestState } from '@projectman/shared';
import type { Db } from './database';

export interface HostRequestRecord {
  id: string;
  projectKey: string;
  taskKey: string | null;
  openedBy: string;
  title: string;
  body: string;
  state: HostRequestState;
  answer: string | null;
  answeredBy: string | null;
  answeredVia: 'web' | 'super' | null;
  createdAt: string;
  updatedAt: string;
}

interface HostRequestRow {
  id: string;
  project_key: string;
  task_key: string | null;
  opened_by: string;
  title: string;
  body: string;
  state: HostRequestState;
  answer: string | null;
  answered_by: string | null;
  answered_via: 'web' | 'super' | null;
  created_at: string;
  updated_at: string;
}

const fromRow = (row: HostRequestRow): HostRequestRecord => ({
  id: row.id,
  projectKey: row.project_key,
  taskKey: row.task_key,
  openedBy: row.opened_by,
  title: row.title,
  body: row.body,
  state: row.state,
  answer: row.answer,
  answeredBy: row.answered_by,
  answeredVia: row.answered_via,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The requests of project managers to the instance's host (PM-1064). */
export function createHostRequestRepository(db: Db) {
  return {
    /** Inserts an open request unless the project already has `limit` open ones; false: the limit is reached. */
    insertWithinLimit(
      request: Pick<
        HostRequestRecord,
        'id' | 'projectKey' | 'taskKey' | 'openedBy' | 'title' | 'body' | 'createdAt'
      >,
      limit: number,
    ): boolean {
      return db
        .transaction((): boolean => {
          const open = db
            .prepare(`SELECT COUNT(*) AS n FROM host_requests WHERE project_key = ? AND state = 'open'`)
            .get(request.projectKey) as { n: number };
          if (open.n >= limit) return false;
          db.prepare(
            `INSERT INTO host_requests
             (id, project_key, task_key, opened_by, title, body, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
          ).run(
            request.id,
            request.projectKey,
            request.taskKey,
            request.openedBy,
            request.title,
            request.body,
            request.createdAt,
            request.createdAt,
          );
          return true;
        })
        .immediate();
    },
    get(id: string): HostRequestRecord | null {
      const row = db.prepare('SELECT * FROM host_requests WHERE id = ?').get(id) as
        HostRequestRow | undefined;
      return row ? fromRow(row) : null;
    },
    /** Newest first. */
    listForProject(
      projectKey: string,
      state: HostRequestState | undefined,
      limit: number,
    ): HostRequestRecord[] {
      return (
        db
          .prepare(
            `SELECT * FROM host_requests WHERE project_key = ? AND (? IS NULL OR state = ?)
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(projectKey, state ?? null, state ?? null, limit) as HostRequestRow[]
      ).map(fromRow);
    },
    /** Newest first, across the projects. */
    listAll(state: HostRequestState | undefined, limit: number): HostRequestRecord[] {
      return (
        db
          .prepare(
            `SELECT * FROM host_requests WHERE (? IS NULL OR state = ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(state ?? null, state ?? null, limit) as HostRequestRow[]
      ).map(fromRow);
    },
    /** Closes an open request; false: it was closed already (answered, declined or withdrawn). */
    close(
      id: string,
      close: {
        state: Exclude<HostRequestState, 'open'>;
        answer: string | null;
        answeredBy: string | null;
        answeredVia: 'web' | 'super' | null;
        now: string;
      },
    ): boolean {
      const result = db
        .prepare(
          `UPDATE host_requests SET state = ?, answer = ?, answered_by = ?, answered_via = ?, updated_at = ?
           WHERE id = ? AND state = 'open'`,
        )
        .run(close.state, close.answer, close.answeredBy, close.answeredVia, close.now, id);
      return result.changes > 0;
    },
  };
}
