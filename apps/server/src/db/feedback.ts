import type {
  FeedbackAnchor,
  FeedbackEnvironment,
  FeedbackEventType,
  FeedbackMarkKind,
  FeedbackOutcome,
  FeedbackScreenshotMeta,
  FeedbackStatus,
} from '@projectman/shared';
import type { Db } from './database';

/** A screenshot as stored: what the views show, and the file it lives in (below `feedback/<KEY>/`). */
export interface StoredFeedbackScreenshot extends FeedbackScreenshotMeta {
  file: string;
}

export interface FeedbackMarkRecord {
  id: string;
  projectKey: string;
  author: string;
  surfaceId: string;
  origin: string;
  pageUrl: string;
  pagePath: string;
  pageTitle: string;
  kind: FeedbackMarkKind;
  body: string;
  anchor: FeedbackAnchor;
  environment: FeedbackEnvironment;
  status: FeedbackStatus;
  outcome: FeedbackOutcome | null;
  taskKey: string | null;
  screenshot: StoredFeedbackScreenshot | null;
  handedTo: string | null;
  handedAt: string | null;
  handedMessageId: string | null;
  inboxItemId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** What may change on a mark after it was made. */
export type FeedbackMarkPatch = Partial<
  Pick<
    FeedbackMarkRecord,
    | 'status'
    | 'outcome'
    | 'taskKey'
    | 'handedTo'
    | 'handedAt'
    | 'handedMessageId'
    | 'inboxItemId'
    | 'updatedAt'
    | 'closedAt'
  >
>;

export interface FeedbackEventRecord {
  id: string;
  markId: string;
  actor: string;
  type: FeedbackEventType;
  body: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

/** What the list needs per mark, counted in one query: the thread's size, its latest entry, whether the viewer has unread entries. */
export interface FeedbackMarkStats {
  commentCount: number;
  lastEventAt: string | null;
  unread: boolean;
}

export interface FeedbackLaunchCodeRecord {
  codeHash: string;
  projectKey: string;
  member: string;
  surfaceId: string;
  origin: string;
  appOrigin: string;
  markId: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface FeedbackSessionRecord {
  id: string;
  tokenHash: string;
  projectKey: string;
  member: string;
  surfaceId: string;
  origin: string;
  appOrigin: string;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

interface MarkRow {
  id: string;
  project_key: string;
  author: string;
  surface_id: string;
  origin: string;
  page_url: string;
  page_path: string;
  page_title: string;
  kind: string;
  body: string;
  anchor: string;
  environment: string;
  status: string;
  outcome: string | null;
  task_key: string | null;
  screenshot: string | null;
  handed_to: string | null;
  handed_at: string | null;
  handed_message_id: string | null;
  inbox_item_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface EventRow {
  id: string;
  mark_id: string;
  actor: string;
  type: string;
  body: string | null;
  data: string;
  created_at: string;
}

interface LaunchCodeRow {
  code_hash: string;
  project_key: string;
  member: string;
  surface_id: string;
  origin: string;
  app_origin: string;
  mark_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

interface SessionRow {
  id: string;
  token_hash: string;
  project_key: string;
  member: string;
  surface_id: string;
  origin: string;
  app_origin: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** These columns are written by this server only, from validated values. */
const readJson = <T>(text: string): T => JSON.parse(text) as T;

const toMark = (r: MarkRow): FeedbackMarkRecord => ({
  id: r.id,
  projectKey: r.project_key,
  author: r.author,
  surfaceId: r.surface_id,
  origin: r.origin,
  pageUrl: r.page_url,
  pagePath: r.page_path,
  pageTitle: r.page_title,
  kind: r.kind as FeedbackMarkKind,
  body: r.body,
  anchor: readJson<FeedbackAnchor>(r.anchor),
  environment: readJson<FeedbackEnvironment>(r.environment),
  status: r.status as FeedbackStatus,
  outcome: r.outcome as FeedbackOutcome | null,
  taskKey: r.task_key,
  screenshot: r.screenshot ? readJson<StoredFeedbackScreenshot>(r.screenshot) : null,
  handedTo: r.handed_to,
  handedAt: r.handed_at,
  handedMessageId: r.handed_message_id,
  inboxItemId: r.inbox_item_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
});

const toEvent = (r: EventRow): FeedbackEventRecord => ({
  id: r.id,
  markId: r.mark_id,
  actor: r.actor,
  type: r.type as FeedbackEventType,
  body: r.body,
  data: readJson<Record<string, unknown>>(r.data),
  createdAt: r.created_at,
});

const toCode = (r: LaunchCodeRow): FeedbackLaunchCodeRecord => ({
  codeHash: r.code_hash,
  projectKey: r.project_key,
  member: r.member,
  surfaceId: r.surface_id,
  origin: r.origin,
  appOrigin: r.app_origin,
  markId: r.mark_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
});

const toSession = (r: SessionRow): FeedbackSessionRecord => ({
  id: r.id,
  tokenHash: r.token_hash,
  projectKey: r.project_key,
  member: r.member,
  surfaceId: r.surface_id,
  origin: r.origin,
  appOrigin: r.app_origin,
  userAgent: r.user_agent,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  revokedBy: r.revoked_by,
});

/** The columns `FeedbackMarkPatch` may set. */
const PATCH_COLUMNS: Record<keyof FeedbackMarkPatch, string> = {
  status: 'status',
  outcome: 'outcome',
  taskKey: 'task_key',
  handedTo: 'handed_to',
  handedAt: 'handed_at',
  handedMessageId: 'handed_message_id',
  inboxItemId: 'inbox_item_id',
  updatedAt: 'updated_at',
  closedAt: 'closed_at',
};

/** How long a launch code row is kept after it expired. */
const LAUNCH_CODE_KEEP_MS = 24 * 60 * 60 * 1000;

export function createFeedbackRepository(db: Db) {
  const statements = {
    insertMark: db.prepare(
      `INSERT INTO feedback_marks (id, project_key, author, surface_id, origin, page_url, page_path,
         page_title, kind, body, anchor, environment, status, outcome, task_key, screenshot,
         created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
    ),
    getMark: db.prepare('SELECT * FROM feedback_marks WHERE id = ?'),
    listMarks: db.prepare(
      `SELECT * FROM feedback_marks WHERE project_key = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ),
    listMarksOfTask: db.prepare(
      `SELECT * FROM feedback_marks WHERE project_key = ? AND task_key = ?
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ),
    insertEvent: db.prepare(
      `INSERT INTO feedback_events (id, mark_id, actor, type, body, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    listEvents: db.prepare('SELECT * FROM feedback_events WHERE mark_id = ? ORDER BY created_at, rowid'),
    stats: db.prepare(
      `SELECT m.id AS id,
         COALESCE(SUM(e.type = 'comment'), 0) AS comments,
         MAX(e.created_at) AS last_at,
         COALESCE(SUM(e.actor <> @viewer AND e.rowid > COALESCE(r.last_event_rowid, 0)), 0) AS unread
       FROM feedback_marks m
       LEFT JOIN feedback_events e ON e.mark_id = m.id
       LEFT JOIN feedback_reads r
         ON r.project_key = m.project_key AND r.mark_id = m.id AND r.member = @viewer
       WHERE m.project_key = @project AND (@mark IS NULL OR m.id = @mark)
       GROUP BY m.id`,
    ),
    markRead: db.prepare(
      `INSERT INTO feedback_reads (project_key, member, mark_id, read_at, last_event_rowid)
       VALUES (@project, @member, @mark, @at,
         (SELECT COALESCE(MAX(rowid), 0) FROM feedback_events WHERE mark_id = @mark))
       ON CONFLICT (project_key, member, mark_id) DO UPDATE
         SET read_at = excluded.read_at, last_event_rowid = excluded.last_event_rowid`,
    ),
    todoOf: db.prepare(
      `SELECT COUNT(*) AS n FROM feedback_marks
       WHERE project_key = ? AND status IN ('new','waiting_owner') AND author <> ?`,
    ),
    todoAll: db.prepare(
      `SELECT COUNT(*) AS n FROM feedback_marks WHERE project_key = ? AND status IN ('new','waiting_owner')`,
    ),
    unreadOwn: db.prepare(
      `SELECT COUNT(*) AS n FROM feedback_marks m
       WHERE m.project_key = @project AND m.author = @viewer AND EXISTS (
         SELECT 1 FROM feedback_events e
         LEFT JOIN feedback_reads r
           ON r.project_key = m.project_key AND r.mark_id = m.id AND r.member = @viewer
         WHERE e.mark_id = m.id AND e.actor <> @viewer
           AND e.rowid > COALESCE(r.last_event_rowid, 0))`,
    ),
    lastByAuthor: db.prepare(
      `SELECT author AS k, MAX(created_at) AS at FROM feedback_marks WHERE project_key = ? GROUP BY author`,
    ),
    lastBySurface: db.prepare(
      `SELECT surface_id AS k, MAX(created_at) AS at FROM feedback_marks WHERE project_key = ? GROUP BY surface_id`,
    ),
    colorOf: db.prepare(
      'SELECT color_index AS c FROM feedback_marker_colors WHERE project_key = ? AND member = ?',
    ),
    colors: db.prepare('SELECT member, color_index AS c FROM feedback_marker_colors WHERE project_key = ?'),
    // The next index is the number of rows the project has, round the palette (one statement, so atomic).
    assignColor: db.prepare(
      `INSERT OR IGNORE INTO feedback_marker_colors (project_key, member, color_index)
       SELECT ?, ?, COUNT(*) % 8 FROM feedback_marker_colors WHERE project_key = ?`,
    ),
    purgeCodes: db.prepare('DELETE FROM feedback_launch_codes WHERE expires_at < ?'),
    insertCode: db.prepare(
      `INSERT INTO feedback_launch_codes (code_hash, project_key, member, surface_id, origin, app_origin,
         mark_id, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ),
    consumeCode: db.prepare(
      `UPDATE feedback_launch_codes SET used_at = @at
       WHERE code_hash = @hash AND used_at IS NULL AND expires_at > @at RETURNING *`,
    ),
    insertSession: db.prepare(
      `INSERT INTO feedback_sessions (id, token_hash, project_key, member, surface_id, origin, app_origin,
         user_agent, created_at, last_used_at, expires_at, revoked_at, revoked_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ),
    getSessionByToken: db.prepare('SELECT * FROM feedback_sessions WHERE token_hash = ?'),
    revokeSessions: db.prepare(
      `UPDATE feedback_sessions SET revoked_at = ?, revoked_by = ?
       WHERE project_key = ? AND member = ? AND revoked_at IS NULL`,
    ),
    activeSessions: db.prepare(
      `SELECT member AS k, COUNT(*) AS n FROM feedback_sessions
       WHERE project_key = ? AND revoked_at IS NULL AND expires_at > ? GROUP BY member`,
    ),
  };

  return {
    insertMark(mark: FeedbackMarkRecord): void {
      statements.insertMark.run(
        mark.id,
        mark.projectKey,
        mark.author,
        mark.surfaceId,
        mark.origin,
        mark.pageUrl,
        mark.pagePath,
        mark.pageTitle,
        mark.kind,
        mark.body,
        JSON.stringify(mark.anchor),
        JSON.stringify(mark.environment),
        mark.status,
        mark.screenshot ? JSON.stringify(mark.screenshot) : null,
        mark.createdAt,
        mark.updatedAt,
      );
    },
    getMark(id: string): FeedbackMarkRecord | null {
      const row = statements.getMark.get(id) as MarkRow | undefined;
      return row ? toMark(row) : null;
    },
    /** The project's marks, the latest activity first; `taskKey` keeps those tied to that card. */
    listMarks(projectKey: string, opts: { taskKey?: string; limit: number }): FeedbackMarkRecord[] {
      const rows = (
        opts.taskKey
          ? statements.listMarksOfTask.all(projectKey, opts.taskKey, opts.limit)
          : statements.listMarks.all(projectKey, opts.limit)
      ) as MarkRow[];
      return rows.map(toMark);
    },
    updateMark(id: string, patch: FeedbackMarkPatch): boolean {
      const keys = (Object.keys(patch) as Array<keyof FeedbackMarkPatch>).filter(
        (key) => patch[key] !== undefined,
      );
      if (keys.length === 0) return false;
      const sql = `UPDATE feedback_marks SET ${keys.map((key) => `${PATCH_COLUMNS[key]} = ?`).join(', ')} WHERE id = ?`;
      return db.prepare(sql).run(...keys.map((key) => patch[key] ?? null), id).changes > 0;
    },
    insertEvent(event: FeedbackEventRecord): void {
      statements.insertEvent.run(
        event.id,
        event.markId,
        event.actor,
        event.type,
        event.body,
        JSON.stringify(event.data),
        event.createdAt,
      );
    },
    listEvents(markId: string): FeedbackEventRecord[] {
      return (statements.listEvents.all(markId) as EventRow[]).map(toEvent);
    },
    /** Per mark of the project (or just `markId`): comments, latest entry and whether `viewer` has unread entries. */
    stats(projectKey: string, viewer: string, markId: string | null = null): Map<string, FeedbackMarkStats> {
      const rows = statements.stats.all({ project: projectKey, viewer, mark: markId }) as Array<{
        id: string;
        comments: number;
        last_at: string | null;
        unread: number;
      }>;
      return new Map(
        rows.map((r) => [r.id, { commentCount: r.comments, lastEventAt: r.last_at, unread: r.unread > 0 }]),
      );
    },
    markRead(projectKey: string, member: string, markId: string, at: string): void {
      statements.markRead.run({ project: projectKey, member, mark: markId, at });
    },
    /** Marks that wait for a decision; `exceptAuthor` leaves out a person's own. */
    todoCount(projectKey: string, exceptAuthor: string | null): number {
      const row = (
        exceptAuthor === null
          ? statements.todoAll.get(projectKey)
          : statements.todoOf.get(projectKey, exceptAuthor)
      ) as { n: number };
      return row.n;
    },
    /** Marks of `member` with an entry by someone else they have not read. */
    unreadOwnCount(projectKey: string, member: string): number {
      return (statements.unreadOwn.get({ project: projectKey, viewer: member }) as { n: number }).n;
    },
    lastMarkByAuthor(projectKey: string): Map<string, string> {
      const rows = statements.lastByAuthor.all(projectKey) as Array<{ k: string; at: string }>;
      return new Map(rows.map((r) => [r.k, r.at]));
    },
    lastMarkBySurface(projectKey: string): Map<string, string> {
      const rows = statements.lastBySurface.all(projectKey) as Array<{ k: string; at: string }>;
      return new Map(rows.map((r) => [r.k, r.at]));
    },
    /** The member's marker colour, or null before they first needed one. */
    colorOf(projectKey: string, member: string): number | null {
      const row = statements.colorOf.get(projectKey, member) as { c: number } | undefined;
      return row ? row.c : null;
    },
    colors(projectKey: string): Map<string, number> {
      const rows = statements.colors.all(projectKey) as Array<{ member: string; c: number }>;
      return new Map(rows.map((r) => [r.member, r.c]));
    },
    /** Gives the member the next free colour of the project (kept for good); a member who has one keeps it. */
    assignColor(projectKey: string, member: string): number {
      statements.assignColor.run(projectKey, member, projectKey);
      return (statements.colorOf.get(projectKey, member) as { c: number }).c;
    },
    /** Stores a launch code; codes that expired more than a day ago are deleted first. */
    insertLaunchCode(code: Omit<FeedbackLaunchCodeRecord, 'usedAt'>, now: Date): void {
      statements.purgeCodes.run(new Date(now.getTime() - LAUNCH_CODE_KEEP_MS).toISOString());
      statements.insertCode.run(
        code.codeHash,
        code.projectKey,
        code.member,
        code.surfaceId,
        code.origin,
        code.appOrigin,
        code.markId,
        code.createdAt,
        code.expiresAt,
      );
    },
    /** Marks the code used and returns it; null when it is unknown, used or expired. */
    consumeLaunchCode(codeHash: string, at: string): FeedbackLaunchCodeRecord | null {
      const row = statements.consumeCode.get({ hash: codeHash, at }) as LaunchCodeRow | undefined;
      return row ? toCode(row) : null;
    },
    insertSession(session: Omit<FeedbackSessionRecord, 'revokedAt' | 'revokedBy'>): void {
      statements.insertSession.run(
        session.id,
        session.tokenHash,
        session.projectKey,
        session.member,
        session.surfaceId,
        session.origin,
        session.appOrigin,
        session.userAgent,
        session.createdAt,
        session.lastUsedAt,
        session.expiresAt,
      );
    },
    sessionByTokenHash(tokenHash: string): FeedbackSessionRecord | null {
      const row = statements.getSessionByToken.get(tokenHash) as SessionRow | undefined;
      return row ? toSession(row) : null;
    },
    /** Revokes all of the member's sessions; how many were still valid. */
    revokeSessions(projectKey: string, member: string, by: string, at: string): number {
      return statements.revokeSessions.run(at, by, projectKey, member).changes;
    },
    activeSessionCounts(projectKey: string, at: string): Map<string, number> {
      const rows = statements.activeSessions.all(projectKey, at) as Array<{ k: string; n: number }>;
      return new Map(rows.map((r) => [r.k, r.n]));
    },
  };
}
