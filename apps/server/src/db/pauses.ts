import type { EngineId, PauseKind, PausePoint, PauseScopeKind, PauseSource } from '@projectman/shared';
import type { Statement } from 'better-sqlite3';
import type { Db } from './database';

/** A pause the team sees: of the instance or of one project. */
export type TeamPauseRecord = PauseRecord & { scope: PauseScopeKind };

/**
 * A pause of the instance, of one project (PM-219) or of one engine (PM-1159), as stored. The engine's is the pause
 * it makes before it stops: always a system `shutdown` pause, and not part of what the team sees.
 */
export interface PauseRecord {
  id: string;
  scope: PauseScopeKind | 'engine';
  /** Null for a pause of the instance or of an engine. */
  projectKey: string | null;
  /** Set for a pause of an engine only. */
  engineId: EngineId | null;
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

type SessionPausePatch = Partial<
  Pick<SessionPauseRecord, 'since' | 'point' | 'tool' | 'waitingFor' | 'pausedAt' | 'needsRestart'>
>;

interface PauseRow {
  id: string;
  scope: PauseRecord['scope'];
  project_key: string | null;
  engine_id: string | null;
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
  engineId: r.engine_id,
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
      `INSERT INTO pauses (id, scope, project_key, engine_id, kind, source, reason, requested_by, requested_at,
         force_after_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    get: db.prepare('SELECT * FROM pauses WHERE id = ?'),
    open: db.prepare(
      `SELECT * FROM pauses WHERE resumed_at IS NULL AND scope != 'engine' ORDER BY requested_at, id`,
    ),
    findOpen: db.prepare(
      `SELECT * FROM pauses WHERE resumed_at IS NULL AND scope = ? AND COALESCE(project_key, '') = ?`,
    ),
    findOpenEngine: db.prepare(
      `SELECT * FROM pauses WHERE resumed_at IS NULL AND scope = 'engine' AND engine_id = ?`,
    ),
    openSessionsOfPause: db.prepare(
      'SELECT * FROM session_pauses WHERE pause_id = ? AND resumed_at IS NULL ORDER BY since, session_id',
    ),
    movePauseSession: db.prepare(
      'UPDATE session_pauses SET pause_id = ? WHERE session_id = ? AND resumed_at IS NULL',
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
    // The sessions the team's pauses hold: the ones an engine's pause holds are that pause's alone.
    openTeamSessions: db.prepare(
      `SELECT sp.* FROM session_pauses sp JOIN pauses p ON p.id = sp.pause_id
       WHERE sp.resumed_at IS NULL AND p.scope != 'engine' ORDER BY sp.since, sp.session_id`,
    ),
    openSessionsOfProject: db.prepare(
      `SELECT sp.* FROM session_pauses sp JOIN pauses p ON p.id = sp.pause_id
       WHERE sp.project_key = ? AND sp.resumed_at IS NULL AND p.scope != 'engine' ORDER BY sp.since, sp.session_id`,
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
        record.engineId,
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
    /** The pauses of the team (the instance's and the projects') not resumed yet, oldest first; never an engine's. */
    open(): TeamPauseRecord[] {
      return (statements.open.all() as PauseRow[]).map(toPause) as TeamPauseRecord[];
    },
    /** The open pause of a scope (`projectKey` null for the instance). */
    findOpen(scope: PauseScopeKind, projectKey: string | null): TeamPauseRecord | null {
      const row = statements.findOpen.get(scope, projectKey ?? '') as PauseRow | undefined;
      return row ? (toPause(row) as TeamPauseRecord) : null;
    },
    /** The open pause the engine made before it stopped (PM-1159). */
    findOpenEngine(engineId: EngineId): PauseRecord | null {
      const row = statements.findOpenEngine.get(engineId) as PauseRow | undefined;
      return row ? toPause(row) : null;
    },
    /** The open rows a pause holds (the first pause to catch a session holds it). */
    openSessionsOfPause(pauseId: string): SessionPauseRecord[] {
      return (statements.openSessionsOfPause.all(pauseId) as SessionPauseRow[]).map(toSessionPause);
    },
    /** The session's open row passes to another pause (a shutdown pause to the pause of the session's engine). */
    movePauseSession(sessionId: string, pauseId: string): void {
      statements.movePauseSession.run(pauseId, sessionId);
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
    /** The open rows the team's pauses hold, not an engine's. */
    openTeamSessions(): SessionPauseRecord[] {
      return (statements.openTeamSessions.all() as SessionPauseRow[]).map(toSessionPause);
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
