import { ScheduleRun } from '@projectman/shared';
import type { Db } from './database';

export function createScheduleRepository(db: Db) {
  const select = `SELECT id, project_key AS projectKey, member, scheduled_for AS scheduledFor,
    started_at AS startedAt, session_id AS sessionId, status, reason FROM schedule_runs`;
  const get = (id: string) => {
    const row = db.prepare(`${select} WHERE id = ?`).get(id);
    return row ? ScheduleRun.parse(row) : null;
  };
  return {
    get,
    list(projectKey: string, limit = 20): ScheduleRun[] {
      return db
        .prepare(`${select} WHERE project_key = ? ORDER BY seq DESC LIMIT ?`)
        .all(projectKey, limit)
        .map((row) => ScheduleRun.parse(row));
    },
    occurrence(projectKey: string, member: string, at: string): ScheduleRun | null {
      const row = db
        .prepare(`${select} WHERE project_key = ? AND member = ? AND scheduled_for = ? AND automatic = 1`)
        .get(projectKey, member, at);
      return row ? ScheduleRun.parse(row) : null;
    },
    insert(run: ScheduleRun, automatic: boolean): void {
      db.prepare(
        `INSERT INTO schedule_runs
        (id, project_key, member, scheduled_for, started_at, session_id, status, reason, automatic)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.projectKey,
        run.member,
        run.scheduledFor,
        run.startedAt,
        run.sessionId,
        run.status,
        run.reason,
        Number(automatic),
      );
    },
    update(
      id: string,
      patch: Pick<ScheduleRun, 'status' | 'reason' | 'sessionId' | 'startedAt'>,
    ): ScheduleRun {
      db.prepare(
        'UPDATE schedule_runs SET status = ?, reason = ?, session_id = ?, started_at = ? WHERE id = ?',
      ).run(patch.status, patch.reason, patch.sessionId, patch.startedAt, id);
      return get(id)!;
    },
    live(): ScheduleRun[] {
      return db
        .prepare(`${select} WHERE status = 'started'`)
        .all()
        .map((row) => ScheduleRun.parse(row));
    },
  };
}
