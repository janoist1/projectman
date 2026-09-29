import type { Session, SessionState, WorkItemRef } from '@projectman/shared';
import type { Db } from './database';

interface SessionRow {
  id: string;
  project_key: string;
  member: string;
  work_item_type: string;
  work_item_ref: string;
  claude_session_id: string;
  cwd: string;
  branch: string | null;
  transcript_path: string | null;
  state: string;
  activity: string | null;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
}

/** Column encoding of a work item: (type, ref). */
export function encodeWorkItem(item: WorkItemRef): { type: string; ref: string } {
  switch (item.type) {
    case 'task':
      return { type: 'task', ref: item.taskKey };
    case 'meeting':
      return { type: 'meeting', ref: item.meetingId };
    case 'general':
      return { type: 'general', ref: '' };
  }
}

export function decodeWorkItem(type: string, ref: string): WorkItemRef {
  if (type === 'task') return { type: 'task', taskKey: ref };
  if (type === 'meeting') return { type: 'meeting', meetingId: ref };
  return { type: 'general' };
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  projectKey: r.project_key,
  member: r.member,
  workItem: decodeWorkItem(r.work_item_type, r.work_item_ref),
  claudeSessionId: r.claude_session_id,
  cwd: r.cwd,
  branch: r.branch,
  transcriptPath: r.transcript_path,
  state: r.state as SessionState,
  activity: r.activity,
  startedAt: r.started_at,
  lastActivityAt: r.last_activity_at,
  endedAt: r.ended_at,
});

export type SessionPatch = Partial<
  Pick<
    Session,
    | 'claudeSessionId'
    | 'cwd'
    | 'branch'
    | 'transcriptPath'
    | 'state'
    | 'activity'
    | 'startedAt'
    | 'lastActivityAt'
    | 'endedAt'
  >
>;

const COLUMNS: Record<keyof SessionPatch, string> = {
  claudeSessionId: 'claude_session_id',
  cwd: 'cwd',
  branch: 'branch',
  transcriptPath: 'transcript_path',
  state: 'state',
  activity: 'activity',
  startedAt: 'started_at',
  lastActivityAt: 'last_activity_at',
  endedAt: 'ended_at',
};

export function createSessionRepository(db: Db) {
  const get = (id: string): Session | null => {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  };

  return {
    get,
    insert(s: Session): void {
      const wi = encodeWorkItem(s.workItem);
      db.prepare(
        `INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd, branch,
           transcript_path, state, activity, started_at, last_activity_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        s.id,
        s.projectKey,
        s.member,
        wi.type,
        wi.ref,
        s.claudeSessionId,
        s.cwd,
        s.branch,
        s.transcriptPath,
        s.state,
        s.activity,
        s.startedAt,
        s.lastActivityAt,
        s.endedAt,
      );
    },
    findByWorkItem(projectKey: string, member: string, item: WorkItemRef): Session | null {
      const wi = encodeWorkItem(item);
      const row = db
        .prepare(
          'SELECT * FROM sessions WHERE project_key = ? AND member = ? AND work_item_type = ? AND work_item_ref = ?',
        )
        .get(projectKey, member, wi.type, wi.ref) as SessionRow | undefined;
      return row ? toSession(row) : null;
    },
    list(projectKey: string, filter: { member?: string; taskKey?: string } = {}): Session[] {
      let sql = 'SELECT * FROM sessions WHERE project_key = ?';
      const params: string[] = [projectKey];
      if (filter.member) {
        sql += ' AND member = ?';
        params.push(filter.member);
      }
      if (filter.taskKey) {
        sql += " AND work_item_type = 'task' AND work_item_ref = ?";
        params.push(filter.taskKey);
      }
      sql += ' ORDER BY started_at, id';
      return (db.prepare(sql).all(...params) as SessionRow[]).map(toSession);
    },
    /** Sessions in any of the given states, across all projects. */
    listInStates(states: SessionState[]): Session[] {
      if (states.length === 0) return [];
      const placeholders = states.map(() => '?').join(', ');
      return (
        db
          .prepare(`SELECT * FROM sessions WHERE state IN (${placeholders}) ORDER BY started_at`)
          .all(...states) as SessionRow[]
      ).map(toSession);
    },
    update(id: string, patch: SessionPatch): Session | null {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as Array<
        [keyof SessionPatch, unknown]
      >;
      if (entries.length > 0) {
        const set = entries.map(([k]) => `${COLUMNS[k]} = ?`).join(', ');
        db.prepare(`UPDATE sessions SET ${set} WHERE id = ?`).run(...entries.map(([, v]) => v), id);
      }
      return get(id);
    },
  };
}

export type SessionRepository = ReturnType<typeof createSessionRepository>;
