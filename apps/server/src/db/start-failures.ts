import type { Db } from './database';

/** The failed session starts of a member at one place (PM-1335), as stored. */
export interface StartFailureRecord {
  projectKey: string;
  member: string;
  /** The place's key (`sessionWorkItemOf` encoded). */
  place: string;
  provider: string;
  /** The engine the member's sessions run on; null: the local one. */
  engineId: string | null;
  failures: number;
  lastCode: string;
  /** The session counted last: a count of the same session is not made twice. */
  lastSessionId: string | null;
  firstAt: string;
  lastAt: string;
  /** Until when the next automatic start waits; null once the place stopped. */
  retryAt: string | null;
  /** When the limit was reached; null while the place still tries. */
  stoppedAt: string | null;
}

interface StartFailureRow {
  project_key: string;
  member: string;
  place: string;
  provider: string;
  engine_id: string | null;
  failures: number;
  last_code: string;
  last_session_id: string | null;
  first_at: string;
  last_at: string;
  retry_at: string | null;
  stopped_at: string | null;
}

const toRecord = (row: StartFailureRow): StartFailureRecord => ({
  projectKey: row.project_key,
  member: row.member,
  place: row.place,
  provider: row.provider,
  engineId: row.engine_id,
  failures: row.failures,
  lastCode: row.last_code,
  lastSessionId: row.last_session_id,
  firstAt: row.first_at,
  lastAt: row.last_at,
  retryAt: row.retry_at,
  stoppedAt: row.stopped_at,
});

/** The start failure counters, so that a backoff and a stop survive a server restart. */
export function createStartFailureRepository(db: Db) {
  const statements = {
    get: db.prepare('SELECT * FROM start_failures WHERE project_key = ? AND member = ? AND place = ?'),
    save: db.prepare(
      `INSERT OR REPLACE INTO start_failures
         (project_key, member, place, provider, engine_id, failures, last_code, last_session_id,
          first_at, last_at, retry_at, stopped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    remove: db.prepare('DELETE FROM start_failures WHERE project_key = ? AND member = ? AND place = ?'),
    removeMember: db.prepare('DELETE FROM start_failures WHERE project_key = ? AND member = ?'),
    list: db.prepare('SELECT * FROM start_failures'),
  };
  return {
    get(projectKey: string, member: string, place: string): StartFailureRecord | undefined {
      const row = statements.get.get(projectKey, member, place) as StartFailureRow | undefined;
      return row && toRecord(row);
    },
    save(record: StartFailureRecord): void {
      statements.save.run(
        record.projectKey,
        record.member,
        record.place,
        record.provider,
        record.engineId,
        record.failures,
        record.lastCode,
        record.lastSessionId,
        record.firstAt,
        record.lastAt,
        record.retryAt,
        record.stoppedAt,
      );
    },
    remove(projectKey: string, member: string, place: string): void {
      statements.remove.run(projectKey, member, place);
    },
    /** Every place of the member (a renamed or removed member's rows). */
    removeMember(projectKey: string, member: string): void {
      statements.removeMember.run(projectKey, member);
    },
    list(): StartFailureRecord[] {
      return (statements.list.all() as StartFailureRow[]).map(toRecord);
    },
  };
}
