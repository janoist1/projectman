import type { ProcessScopeKind } from '../contracts';
import type { Db } from './database';

export interface SessionCleanupFailure {
  scopeId: string;
  sessionId: string;
  projectKey: string;
  taskKey: string | null;
  kind: ProcessScopeKind;
  survivors: number;
  failedAt: string;
  lastAttemptAt: string | null;
  attempts: number;
}
const columns = `scope_id AS scopeId, session_id AS sessionId, project_key AS projectKey,
  task_key AS taskKey, kind, survivors, failed_at AS failedAt, last_attempt_at AS lastAttemptAt, attempts`;

/** Cleanup facts are independent of dismissible Operator notifications. */
export function createSessionCleanupRepository(db: Db) {
  return {
    list(): SessionCleanupFailure[] {
      return db
        .prepare(`SELECT ${columns} FROM session_cleanups ORDER BY failed_at, scope_id`)
        .all() as SessionCleanupFailure[];
    },
    forSession(sessionId: string): SessionCleanupFailure[] {
      return db
        .prepare(`SELECT ${columns} FROM session_cleanups WHERE session_id = ?`)
        .all(sessionId) as SessionCleanupFailure[];
    },
    forTask(projectKey: string, taskKey: string): SessionCleanupFailure[] {
      return db
        .prepare(`SELECT ${columns} FROM session_cleanups WHERE project_key = ? AND task_key = ?`)
        .all(projectKey, taskKey) as SessionCleanupFailure[];
    },
    failed(record: SessionCleanupFailure): void {
      db.prepare(
        `INSERT INTO session_cleanups (scope_id, session_id, project_key, task_key, kind, survivors, failed_at, last_attempt_at, attempts)
        VALUES (@scopeId, @sessionId, @projectKey, @taskKey, @kind, @survivors, @failedAt, @lastAttemptAt, @attempts)
        ON CONFLICT(scope_id) DO UPDATE SET survivors = excluded.survivors`,
      ).run(record);
    },
    attempted(scopeId: string, at: string): void {
      db.prepare(
        'UPDATE session_cleanups SET attempts = attempts + 1, last_attempt_at = ? WHERE scope_id = ?',
      ).run(at, scopeId);
    },
    recovered(sessionId: string, scopeId: string): void {
      db.prepare('DELETE FROM session_cleanups WHERE scope_id = ? AND session_id = ?').run(
        scopeId,
        sessionId,
      );
    },
  };
}
