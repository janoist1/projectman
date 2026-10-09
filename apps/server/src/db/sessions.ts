import {
  Approver,
  DEFAULT_AGENT_PROVIDER,
  EngineId,
  LOCAL_ENGINE_ID,
  mergeTokenUsage,
  SelectablePermissionMode,
  SessionStop,
  SessionStartCause,
} from '@projectman/shared';
import type {
  AgentProvider,
  ExecutionProfile,
  Session,
  SessionPause,
  SessionState,
  SessionUsageAlert,
  TokenUsage,
  WorkDoing,
  WorkItemRef,
} from '@projectman/shared';
import type { Statement } from 'better-sqlite3';
import type { Db } from './database';

interface SessionRow {
  id: string;
  project_key: string;
  member: string;
  work_item_type: string;
  work_item_ref: string;
  claude_session_id: string;
  provider: string;
  cwd: string;
  branch: string | null;
  transcript_path: string | null;
  state: string;
  activity: string | null;
  state_since: string | null;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
  permission_mode: string | null;
  approver: string | null;
  permission_restart_pending: number;
  permission_grants_lost: number;
  usage_since: string | null;
  usage_alert_at: string | null;
  usage_alert_tokens: number | null;
  usage_alert_limit: number | null;
  compact_pending: number;
  context_tokens: number | null;
  reviewed_commit: string | null;
  doing_summary: string | null;
  doing_detail: string | null;
  last_stop: string | null;
  start_cause: string | null;
  engine_id: string;
}

/** The stored reason of the last stop (JSON); a broken or empty value is no reason (PM-288). */
function lastStopOf(raw: string | null): SessionStop | undefined {
  if (!raw) return undefined;
  try {
    const parsed = SessionStop.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Ignore malformed or newer start causes while keeping the session readable. */
function startCauseOf(raw: string | null): SessionStartCause | undefined {
  if (!raw) return undefined;
  try {
    const parsed = SessionStartCause.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** What a session's conversation owes and measures for the end-of-round compaction (PM-213). */
export interface SessionCompaction {
  /** Its round ended and no compaction ran or was given up since. */
  pending: boolean;
  /** The context of the conversation's last step (input + cache read + cache write); null: unknown. */
  contextTokens: number | null;
}

/** Token usage rows summed per model and scope. */
export interface UsageRow {
  model: string;
  scope: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** Column encoding of a work item: (type, ref). */
export function encodeWorkItem(item: WorkItemRef): { type: string; ref: string } {
  switch (item.type) {
    case 'task':
      return { type: 'task', ref: item.taskKey };
    case 'meeting':
      return { type: 'meeting', ref: item.meetingId };
    case 'schedule':
      return { type: 'schedule', ref: item.runId };
    case 'general':
      return { type: 'general', ref: '' };
  }
}

export function decodeWorkItem(type: string, ref: string): WorkItemRef {
  if (type === 'task') return { type: 'task', taskKey: ref };
  if (type === 'schedule') return { type: 'schedule', runId: ref };
  if (type === 'meeting') return { type: 'meeting', meetingId: ref };
  return { type: 'general' };
}

/** The session without its token usage, which comes from another table. */
const baseSession = (r: SessionRow): Session => ({
  id: r.id,
  projectKey: r.project_key,
  member: r.member,
  workItem: decodeWorkItem(r.work_item_type, r.work_item_ref),
  claudeSessionId: r.claude_session_id,
  provider: r.provider as AgentProvider,
  cwd: r.cwd,
  branch: r.branch,
  transcriptPath: r.transcript_path,
  state: r.state as SessionState,
  activity: r.activity,
  ...(r.state_since ? { stateSince: r.state_since } : {}),
  startedAt: r.started_at,
  lastActivityAt: r.last_activity_at,
  endedAt: r.ended_at,
  ...(SelectablePermissionMode.safeParse(r.permission_mode).success
    ? { permissionModeOverride: r.permission_mode as SelectablePermissionMode }
    : {}),
  ...(Approver.safeParse(r.approver).success ? { approverOverride: r.approver as Approver } : {}),
  ...(r.permission_restart_pending ? { permissionRestartPending: true as const } : {}),
  ...(r.permission_grants_lost ? { permissionGrantsLost: true as const } : {}),
  ...(r.usage_alert_at
    ? {
        usageAlert: {
          at: r.usage_alert_at,
          countedTokens: r.usage_alert_tokens ?? 0,
          limitTokens: r.usage_alert_limit ?? 0,
        },
      }
    : {}),
  ...(r.doing_summary
    ? { doing: { summary: r.doing_summary, ...(r.doing_detail ? { detail: r.doing_detail } : {}) } }
    : {}),
  ...(lastStopOf(r.last_stop) ? { lastStop: lastStopOf(r.last_stop) } : {}),
  ...(startCauseOf(r.start_cause) ? { startCause: startCauseOf(r.start_cause) } : {}),
  // The column has a default, so a row from before engines is the local one; a session without an
  // `engineId` is local, so a local session reads as it always did.
  ...(r.engine_id !== LOCAL_ENGINE_ID && EngineId.safeParse(r.engine_id).success
    ? { engineId: r.engine_id }
    : {}),
});

/** A summed row of the token_usage table. */
export function tokenUsageOf(r: UsageRow): TokenUsage {
  return {
    model: r.model,
    scope: r.scope === 'subagent' ? 'subagent' : 'main',
    input: r.input,
    output: r.output,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_write,
  };
}

export type SessionPatch = Partial<
  Pick<
    Session,
    | 'claudeSessionId'
    | 'provider'
    | 'cwd'
    | 'branch'
    | 'transcriptPath'
    | 'state'
    | 'activity'
    | 'stateSince'
    | 'startedAt'
    | 'lastActivityAt'
    | 'endedAt'
    | 'engineId'
  >
> & {
  /** The session's own permission settings (PM-170); null goes back to the member's. */
  permissionModeOverride?: SelectablePermissionMode | null;
  approverOverride?: Approver | null;
  permissionRestartPending?: boolean;
  permissionGrantsLost?: boolean;
  /** Since when the session's token usage is counted (PM-178). */
  usageSince?: string;
  /** What the member says it does now (PM-238); null clears it. */
  doing?: WorkDoing | null;
  /** Why the session stopped (PM-288); null clears it. */
  lastStop?: SessionStop | null;
  startCause?: SessionStartCause | null;
};

/** The patch with `doing` spread over its two columns; the other keys are columns of their own. */
const COLUMNS: Record<Exclude<keyof SessionPatch, 'doing' | 'lastStop' | 'startCause'>, string> = {
  usageSince: 'usage_since',
  permissionModeOverride: 'permission_mode',
  approverOverride: 'approver',
  permissionRestartPending: 'permission_restart_pending',
  permissionGrantsLost: 'permission_grants_lost',
  claudeSessionId: 'claude_session_id',
  provider: 'provider',
  cwd: 'cwd',
  branch: 'branch',
  transcriptPath: 'transcript_path',
  state: 'state',
  activity: 'activity',
  stateSince: 'state_since',
  startedAt: 'started_at',
  lastActivityAt: 'last_activity_at',
  endedAt: 'ended_at',
  engineId: 'engine_id',
};

export function createSessionRepository(db: Db) {
  const statements = {
    get: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    countResumable: db.prepare(
      `SELECT COUNT(*) AS n FROM sessions s
       WHERE s.state IN ('exited', 'failed')
         AND (s.work_item_type = 'general'
              OR (s.work_item_type = 'task' AND EXISTS (
                    SELECT 1 FROM tasks t WHERE t.key = s.work_item_ref AND t.status NOT IN ('done', 'cancelled'))))`,
    ),
    profile: db.prepare('SELECT execution_profile FROM sessions WHERE id = ?'),
    setProfile: db.prepare('UPDATE sessions SET execution_profile = ? WHERE id = ?'),
    compaction: db.prepare('SELECT compact_pending, context_tokens FROM sessions WHERE id = ?'),
    setCompactPending: db.prepare('UPDATE sessions SET compact_pending = ? WHERE id = ?'),
    setContextTokens: db.prepare('UPDATE sessions SET context_tokens = ? WHERE id = ?'),
    reviewedCommit: db.prepare('SELECT reviewed_commit FROM sessions WHERE id = ?'),
    setReviewedCommit: db.prepare('UPDATE sessions SET reviewed_commit = ? WHERE id = ?'),
    markUsageAlert: db.prepare(
      `UPDATE sessions SET usage_alert_at = ?, usage_alert_tokens = ?, usage_alert_limit = ?
       WHERE id = ? AND usage_alert_at IS NULL`,
    ),
    insert: db.prepare(
      `INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, provider,
         cwd, branch, transcript_path, state, activity, state_since, started_at, last_activity_at, ended_at,
         engine_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    findByWorkItem: db.prepare(
      'SELECT * FROM sessions WHERE project_key = ? AND member = ? AND work_item_type = ? AND work_item_ref = ?',
    ),
    list: db.prepare('SELECT * FROM sessions WHERE project_key = ? ORDER BY started_at, id'),
    listByMember: db.prepare(
      'SELECT * FROM sessions WHERE project_key = ? AND member = ? ORDER BY started_at, id',
    ),
    listByTask: db.prepare(
      `SELECT * FROM sessions WHERE project_key = ? AND work_item_type = 'task' AND work_item_ref = ?
       ORDER BY started_at, id`,
    ),
    listByMemberAndTask: db.prepare(
      `SELECT * FROM sessions WHERE project_key = ? AND member = ? AND work_item_type = 'task'
         AND work_item_ref = ? ORDER BY started_at, id`,
    ),
  };
  /** SELECT statements per number of states, UPDATE statements per set of changed columns. */
  const inStates = new Map<number, Statement>();
  const updates = new Map<string, Statement>();

  const usageOf = db.prepare(
    `SELECT model, scope, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
       SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write
     FROM token_usage WHERE session_id = ? GROUP BY model, scope`,
  );
  /** The open row of the pause that holds the session (PM-219). */
  const pauseOf = db.prepare(
    'SELECT since, point, tool FROM session_pauses WHERE session_id = ? AND resumed_at IS NULL',
  );
  /** The session with what it used, when its usage is measured (PM-178), and the pause that holds it. */
  const toSession = (r: SessionRow): Session => {
    let session = baseSession(r);
    const pause = pauseOf.get(r.id) as SessionPause | undefined;
    if (pause) session = { ...session, pause: { since: pause.since, point: pause.point, tool: pause.tool } };
    if (!r.usage_since) return session;
    const rows = (usageOf.all(r.id) as UsageRow[]).map(tokenUsageOf);
    return { ...session, usage: { since: r.usage_since, rows: mergeTokenUsage(rows) } };
  };

  const get = (id: string): Session | null => {
    const row = statements.get.get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  };

  return {
    get,
    /**
     * The execution profile the session's conversation ran in (PM-141). Kept beside the session, not
     * in its public shape: it only decides whether a conversation may be resumed.
     */
    executionProfile(id: string): ExecutionProfile {
      const row = statements.profile.get(id) as { execution_profile: string } | undefined;
      return row?.execution_profile === 'managed_vm' ? 'managed_vm' : 'legacy';
    },
    setExecutionProfile(id: string, profile: ExecutionProfile): void {
      statements.setProfile.run(profile, id);
    },
    /** The end-of-round compaction state of the session's conversation (PM-213). */
    compaction(id: string): SessionCompaction {
      const row = statements.compaction.get(id) as
        { compact_pending: number; context_tokens: number | null } | undefined;
      return { pending: Boolean(row?.compact_pending), contextTokens: row?.context_tokens ?? null };
    },
    setCompactPending(id: string, pending: boolean): void {
      statements.setCompactPending.run(Number(pending), id);
    },
    setContextTokens(id: string, tokens: number | null): void {
      statements.setContextTokens.run(tokens, id);
    },
    /** The commit the session reviewed in its last round on its task (PM-213); null: none known. */
    reviewedCommit(id: string): string | null {
      const row = statements.reviewedCommit.get(id) as { reviewed_commit: string | null } | undefined;
      return row?.reviewed_commit ?? null;
    },
    setReviewedCommit(id: string, commit: string | null): void {
      statements.setReviewedCommit.run(commit, id);
    },
    /**
     * Marks that the session's usage reached the warning limit (PM-187), unless it already is:
     * true when this call marked it, so only one caller raises the warning.
     */
    markUsageAlert(id: string, alert: SessionUsageAlert): boolean {
      return statements.markUsageAlert.run(alert.at, alert.countedTokens, alert.limitTokens, id).changes > 0;
    },
    insert(s: Session): void {
      const wi = encodeWorkItem(s.workItem);
      statements.insert.run(
        s.id,
        s.projectKey,
        s.member,
        wi.type,
        wi.ref,
        s.claudeSessionId,
        s.provider ?? DEFAULT_AGENT_PROVIDER,
        s.cwd,
        s.branch,
        s.transcriptPath,
        s.state,
        s.activity,
        s.stateSince ?? null,
        s.startedAt,
        s.lastActivityAt,
        s.endedAt,
        s.engineId ?? LOCAL_ENGINE_ID,
      );
    },
    findByWorkItem(projectKey: string, member: string, item: WorkItemRef): Session | null {
      const wi = encodeWorkItem(item);
      const row = statements.findByWorkItem.get(projectKey, member, wi.type, wi.ref) as
        SessionRow | undefined;
      return row ? toSession(row) : null;
    },
    list(projectKey: string, filter: { member?: string; taskKey?: string } = {}): Session[] {
      const rows =
        filter.member && filter.taskKey
          ? statements.listByMemberAndTask.all(projectKey, filter.member, filter.taskKey)
          : filter.member
            ? statements.listByMember.all(projectKey, filter.member)
            : filter.taskKey
              ? statements.listByTask.all(projectKey, filter.taskKey)
              : statements.list.all(projectKey);
      return (rows as SessionRow[]).map(toSession);
    },
    /** Sessions in any of the given states, across all projects. */
    listInStates(states: SessionState[]): Session[] {
      if (states.length === 0) return [];
      let statement = inStates.get(states.length);
      if (!statement) {
        const placeholders = states.map(() => '?').join(', ');
        statement = db.prepare(`SELECT * FROM sessions WHERE state IN (${placeholders}) ORDER BY started_at`);
        inStates.set(states.length, statement);
      }
      return (statement.all(...states) as SessionRow[]).map(toSession);
    },
    /**
     * How many sessions are closed but can be resumed (PM-320): the session of a (project, member, work
     * item) is one row, so each triple counts once when it exited or failed and its work item is a
     * general chat or a card that is not done or cancelled. Meetings and scheduled runs do not count.
     */
    countResumable(): number {
      const row = statements.countResumable.get() as { n: number };
      return row.n;
    },
    update(id: string, patch: SessionPatch): Session | null {
      const { doing, lastStop, startCause, ...columns } = patch;
      const entries = Object.entries(columns).filter(([, v]) => v !== undefined) as Array<
        [keyof typeof COLUMNS, unknown]
      >;
      const named: Array<[string, unknown]> = entries.map(([k, v]) => [COLUMNS[k], v]);
      if (doing !== undefined) {
        named.push(['doing_summary', doing?.summary ?? null], ['doing_detail', doing?.detail ?? null]);
      }
      if (lastStop !== undefined) named.push(['last_stop', lastStop ? JSON.stringify(lastStop) : null]);
      if (startCause !== undefined)
        named.push(['start_cause', startCause ? JSON.stringify(startCause) : null]);
      if (named.length > 0) {
        const set = named.map(([column]) => `${column} = ?`).join(', ');
        let statement = updates.get(set);
        if (!statement) {
          statement = db.prepare(`UPDATE sessions SET ${set} WHERE id = ?`);
          updates.set(set, statement);
        }
        // SQLite binds no booleans: the flags are stored as 0 and 1.
        statement.run(...named.map(([, v]) => (typeof v === 'boolean' ? Number(v) : v)), id);
      }
      return get(id);
    },
  };
}
