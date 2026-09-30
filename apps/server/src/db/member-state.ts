import type { MemberStatus } from '@projectman/shared';
import type { Db } from './database';

export interface MemberStateRecord {
  projectKey: string;
  handle: string;
  status: MemberStatus;
  activity: string | null;
  updatedAt: string;
}

interface MemberStateRow {
  project_key: string;
  handle: string;
  status: string;
  activity: string | null;
  updated_at: string;
}

const toRecord = (r: MemberStateRow): MemberStateRecord => ({
  projectKey: r.project_key,
  handle: r.handle,
  status: r.status as MemberStatus,
  activity: r.activity,
  updatedAt: r.updated_at,
});

/** Runtime state of members (status, activity). Retired members keep a row, so handles are never reused. */
export function createMemberStateRepository(db: Db) {
  const statements = {
    get: db.prepare('SELECT * FROM member_state WHERE project_key = ? AND handle = ?'),
    list: db.prepare('SELECT * FROM member_state WHERE project_key = ? ORDER BY handle'),
    upsert: db.prepare(
      `INSERT INTO member_state (project_key, handle, status, activity, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_key, handle) DO UPDATE SET status = excluded.status, activity = excluded.activity,
         updated_at = excluded.updated_at`,
    ),
  };
  return {
    get(projectKey: string, handle: string): MemberStateRecord | null {
      const row = statements.get.get(projectKey, handle) as MemberStateRow | undefined;
      return row ? toRecord(row) : null;
    },
    list(projectKey: string): MemberStateRecord[] {
      return (statements.list.all(projectKey) as MemberStateRow[]).map(toRecord);
    },
    upsert(r: MemberStateRecord): void {
      statements.upsert.run(r.projectKey, r.handle, r.status, r.activity, r.updatedAt);
    },
  };
}
