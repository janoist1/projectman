import type { PauseKind, PausePoint, PauseScopeKind, PauseSource } from '@projectman/shared';
import type { Statement } from 'better-sqlite3';
import type { Db } from './database';

/** A pause of the instance or of one project (PM-219), as stored. */
export interface PauseRecord {
  id: string;
  scope: PauseScopeKind;
  /** Null for a pause of the instance. */
  projectKey: string | null;
  kind: PauseKind;
  source: PauseSource;
  reason: string | null;
  /** A user id; null for the control command and the system. */
  requestedBy: string | null;
  requestedAt: string;
  forceAfterMs: number;
  resumedAt: string | null;
  resumedBy: string | null;
}

/** A session a pause holds, as stored: one open row per session. */
export interface SessionPauseRecord {
  sessionId: string;
  /** The pause that caught the session first. */
  pauseId: string;
  projectKey: string;
  since: string;
  /** Null while the session is still stopping. */
  point: PausePoint | null;
  tool: string | null;
  waitingFor: string | null;
  pausedAt: string | null;
  /** It stopped at a point from which a session whose process is gone restarts on resume. */
  needsRestart: boolean;
  resumedAt: string | null;
}

export type SessionPausePatch = Partial<
  Pick<SessionPauseRecord, 'since' | 'point' | 'tool' | 'waitingFor' | 'pausedAt' | 'needsRestart'>
>;

interface PauseRow {
  id: string;
  scope: PauseScopeKind;
  project_key: string | null;
  kind: PauseKind;
  source: PauseSource;
  reason: string | null;
  requested_by: string | null;
  requested_at: string;
  force_after_ms: number;
  resumed_at: string | null;
  resumed_by: string | null;
}

interface SessionPauseRow {
  session_id: string;
  pause_id: string;
  project_key: string;
  since: string;
  point: PausePoint | null;
  tool: string | null;
  waiting_for: string | null;
  paused_at: string | null;
  needs_restart: number;
  resumed_at: string | null;
}

const toPause = (r: PauseRow): PauseRecord => ({
  id: r.id,
  scope: r.scope,
  projectKey: r.project_key,
  kind: r.kind,
  source: r.source,
  reason: r.reason,
  requestedBy: r.requested_by,
  requestedAt: r.requested_at,
  forceAfterMs: r.force_after_ms,
  resumedAt: r.resumed_at,
  resumedBy: r.resumed_by,
});

const toSessionPause = (r: SessionPauseRow): SessionPauseRecord => ({
  sessionId: r.session_id,
  pauseId: r.pause_id,
  projectKey: r.project_key,
  since: r.since,
  point: r.point,
  tool: r.tool,
  waitingFor: r.waiting_for,
  pausedAt: r.paused_at,
  needsRestart: Boolean(r.needs_restart),
  resumedAt: r.resumed_at,
});

const COLUMNS: Record<keyof SessionPausePatch, string> = {
  since: 'since',
  point: 'point',
  tool: 'tool',
  waitingFor: 'waiting_for',
  pausedAt: 'paused_at',
  needsRestart: 'needs_restart',
};

/** The pauses and the sessions they hold (PM-219). */
export function createPauseRepository(db: Db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO pauses (id, scope, project_key, kind, source, reason, requested_by, requested_at, force_after_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    get: db.prepare('SELECT * FROM pauses WHERE id = ?'),
    open: db.prepare('SELECT * FROM pauses WHERE resumed_at IS NULL ORDER BY requested_at, id'),
    findOpen: db.prepare(
      `SELECT * FROM pauses WHERE resumed_at IS NULL AND scope = ? AND COALESCE(project_key, '') = ?`,
    ),
    setForceAfter: db.prepare('UPDATE pauses SET force_after_ms = ? WHERE id = ?'),
    close: db.prepare('UPDATE pauses SET resumed_at = ?, resumed_by = ? WHERE id = ? AND resumed_at IS NULL'),
    insertSession: db.prepare(
      `INSERT INTO session_pauses (session_id, pause_id, project_key, since, point, tool, waiting_for,
         paused_at, needs_restart)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    openSession: db.prepare('SELECT * FROM session_pauses WHERE session_id = ? AND resumed_at IS NULL'),
    openSessions: db.prepare(
      'SELECT * FROM session_pauses WHERE resumed_at IS NULL ORDER BY since, session_id',
    ),
    openSessionsOfProject: db.prepare(
      'SELECT * FROM session_pauses WHERE project_key = ? AND resumed_at IS NULL ORDER BY since, session_id',
    ),
    closeSession: db.prepare(
      'UPDATE session_pauses SET resumed_at = ? WHERE session_id = ? AND resumed_at IS NULL',
    ),
  };
  const updates = new Map<string, Statement>();

  return {
    insert(record: Omit<PauseRecord, 'resumedAt' | 'resumedBy'>): void {
      statements.insert.run(
        record.id,
        record.scope,
        record.projectKey,
        record.kind,
        record.source,
        record.reason,
        record.requestedBy,
        record.requestedAt,
        record.forceAfterMs,
      );
    },
    get(id: string): PauseRecord | null {
      const row = statements.get.get(id) as PauseRow | undefined;
      return row ? toPause(row) : null;
    },
    /** The pauses not resumed yet, oldest first. */
    open(): PauseRecord[] {
      return (statements.open.all() as PauseRow[]).map(toPause);
    },
    /** The open pause of a scope (`projectKey` null for the instance). */
    findOpen(scope: PauseScopeKind, projectKey: string | null): PauseRecord | null {
      const row = statements.findOpen.get(scope, projectKey ?? '') as PauseRow | undefined;
      return row ? toPause(row) : null;
    },
    setForceAfter(id: string, forceAfterMs: number): void {
      statements.setForceAfter.run(forceAfterMs, id);
    },
    /** Resumes the pause; false when it was resumed already. */
    close(id: string, at: string, by: string | null): boolean {
      return statements.close.run(at, by, id).changes > 0;
    },
    insertSession(record: Omit<SessionPauseRecord, 'resumedAt'>): void {
      statements.insertSession.run(
        record.sessionId,
        record.pauseId,
        record.projectKey,
        record.since,
        record.point,
        record.tool,
        record.waitingFor,
        record.pausedAt,
        Number(record.needsRestart),
      );
    },
    /** The row holding the session, if any pause does. */
    openSession(sessionId: string): SessionPauseRecord | null {
      const row = statements.openSession.get(sessionId) as SessionPauseRow | undefined;
      return row ? toSessionPause(row) : null;
    },
    openSessions(): SessionPauseRecord[] {
      return (statements.openSessions.all() as SessionPauseRow[]).map(toSessionPause);
    },
    openSessionsOfProject(projectKey: string): SessionPauseRecord[] {
      return (statements.openSessionsOfProject.all(projectKey) as SessionPauseRow[]).map(toSessionPause);
    },
    updateSession(sessionId: string, patch: SessionPausePatch): void {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as Array<
        [keyof SessionPausePatch, unknown]
      >;
      if (entries.length === 0) return;
      const set = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(', ');
      let statement = updates.get(set);
      if (!statement) {
        statement = db.prepare(
          `UPDATE session_pauses SET ${set} WHERE session_id = ? AND resumed_at IS NULL`,
        );
        updates.set(set, statement);
      }
      statement.run(...entries.map(([, v]) => (typeof v === 'boolean' ? Number(v) : v)), sessionId);
    },
    /** Closes the session's open row; false when it had none. */
    closeSession(sessionId: string, at: string): boolean {
      return statements.closeSession.run(at, sessionId).changes > 0;
    },
  };
}
