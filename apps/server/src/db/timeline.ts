import type { Statement } from 'better-sqlite3';
import { actorWithOriginMeta } from '@projectman/shared';
import type { InvolvementQuery, TimelineEvent } from '@projectman/shared';
import type { Db } from './database';
import { originMetaJson } from './actor-meta';
import { parseJson, toJson } from './json';

interface TimelineRow {
  seq: number;
  id: string;
  project_key: string;
  task_key: string | null;
  session_id: string | null;
  actor_kind: string;
  actor_handle: string | null;
  actor_via: 'integrator' | null;
  /** The super mode's origin (PM-757); NULL on every older row. */
  actor_meta: string | null;
  type: string;
  data: string;
  created_at: string;
}

const toEvent = (r: TimelineRow): TimelineEvent => ({
  id: r.id,
  projectKey: r.project_key,
  taskKey: r.task_key,
  sessionId: r.session_id,
  actor: actorWithOriginMeta(
    {
      kind: r.actor_kind as TimelineEvent['actor']['kind'],
      handle: r.actor_handle,
      ...(r.actor_via ? { via: r.actor_via } : {}),
    },
    r.actor_meta ? parseJson(r.actor_meta, null) : null,
  ),
  type: r.type as TimelineEvent['type'],
  data: parseJson<Record<string, unknown>>(r.data, {}),
  createdAt: r.created_at,
});

/** The reads whose query plan a test pins (PM-771). */
export const TIMELINE_SQL = {
  /**
   * The state-setting event with the greatest seq before a time, per card (`latestTaskStatesBefore`). The
   * `type IN (...)` term repeats the partial index `timeline_task_state_before`, which is what lets the
   * planner use it; the `action` test then picks the task_updated events that set a state.
   */
  stateBefore: `SELECT * FROM timeline_events WHERE project_key = ? AND seq IN (
      SELECT (SELECT t.seq FROM timeline_events t
               WHERE t.project_key = ? AND t.task_key = k.value AND t.created_at < ?
                 AND t.type IN ('task_stage_changed', 'task_updated')
                 AND (t.type = 'task_stage_changed'
                   OR json_extract(t.data, '$.action') IN ('cancelled', 'reopened'))
               ORDER BY t.seq DESC LIMIT 1)
        FROM json_each(?) k)
    ORDER BY seq`,
  /** Structured detector evidence in a fixed time window (`structuralEvidence`). */
  structuralEvidence: `SELECT * FROM timeline_events WHERE project_key = ?
      AND created_at >= ? AND created_at <= ?
      AND type IN ('task_merge_requested', 'task_merge_failed', 'task_full_test',
        'task_stage_changed', 'task_labels_changed', 'task_updated')
      ORDER BY seq`,
};

export function createTimelineRepository(db: Db) {
  // `listOfTypes` statements by how many types they take.
  const ofTypes = new Map<number, Statement>();
  const statements = {
    insert: db.prepare(
      `INSERT INTO timeline_events (id, project_key, task_key, session_id, actor_kind, actor_handle, type, data, created_at, actor_via, actor_meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    forMember: db.prepare(
      `SELECT * FROM timeline_events WHERE project_key = ? AND
        (actor_handle = ? OR json_extract(data, '$.handle') = ? OR json_extract(data, '$.member') = ?
        OR json_extract(data, '$.assignee') = ? OR EXISTS (SELECT 1 FROM json_each(data, '$.to') WHERE value = ?))
        ORDER BY seq DESC LIMIT ?`,
    ),
    ofTask: db.prepare(
      'SELECT * FROM timeline_events WHERE project_key = ? AND task_key = ? ORDER BY seq DESC LIMIT ?',
    ),
    // What the card's rounds are counted from (PM-222), all of it: the card's whole history.
    roundEvents: db.prepare(
      `SELECT * FROM timeline_events WHERE project_key = ? AND task_key = ?
         AND type IN ('task_stage_changed', 'task_labels_changed', 'task_full_test', 'task_fix_limit') ORDER BY seq`,
    ),
    latestOfType: db.prepare(
      'SELECT * FROM timeline_events WHERE project_key = ? AND task_key = ? AND type = ? ORDER BY seq DESC LIMIT 1',
    ),
    // The work of a card (PM-431), the rule of `isLoopWork` in `packages/shared`.
    latestWork: db.prepare(
      `SELECT * FROM timeline_events WHERE project_key = ? AND task_key = ?
         AND (type = 'attachment_added'
           OR (type = 'task_note'
             AND json_extract(data, '$.importedAuthor') IS NULL AND json_extract(data, '$.importedAt') IS NULL)
           OR (type = 'task_updated' AND EXISTS (SELECT 1 FROM json_each(data, '$.fields') WHERE value = 'description')))
       ORDER BY seq DESC LIMIT 1`,
    ),
    // The ids of what `isLoopTriageEvidence` accepts (PM-1120): the work of the card (as `latestWork`) and its stage,
    // label and check events, newest first. Only ids are read; the events themselves are not.
    loopEvidenceIds: db.prepare(
      `SELECT id FROM timeline_events WHERE project_key = ? AND task_key = ?
         AND (type IN ('attachment_added', 'task_stage_changed', 'task_labels_changed', 'task_check_changed')
           OR (type = 'task_note'
             AND json_extract(data, '$.importedAuthor') IS NULL AND json_extract(data, '$.importedAt') IS NULL)
           OR (type = 'task_updated' AND EXISTS (SELECT 1 FROM json_each(data, '$.fields') WHERE value = 'description')))
       ORDER BY seq DESC LIMIT ?`,
    ),
    stateBefore: db.prepare(TIMELINE_SQL.stateBefore),
    structuralEvidence: db.prepare(TIMELINE_SQL.structuralEvidence),
    ofProject: db.prepare('SELECT * FROM timeline_events WHERE project_key = ? ORDER BY seq DESC LIMIT ?'),
    ofProjectType: db.prepare(
      'SELECT * FROM timeline_events WHERE project_key = ? AND type = ? ORDER BY seq DESC LIMIT ?',
    ),
    byId: db.prepare('SELECT * FROM timeline_events WHERE project_key = ? AND id = ?'),
    // Imported comments (a ClickUp import) are history, not conversation.
    talkSince: db.prepare(
      `SELECT * FROM timeline_events WHERE project_key = ? AND task_key = ? AND created_at >= ?
         AND type IN ('team_message', 'task_note')
         AND json_extract(data, '$.importedAuthor') IS NULL AND json_extract(data, '$.importedAt') IS NULL
       ORDER BY seq DESC LIMIT ?`,
    ),
  };
  return {
    /** Structured detector evidence in a fixed time window, independent of unrelated project traffic. */
    structuralEvidence(projectKey: string, since: string, until: string): TimelineEvent[] {
      return (statements.structuralEvidence.all(projectKey, since, until) as TimelineRow[]).map(toEvent);
    },
    /**
     * `TaskStateHistoryReader`: per card the last state-setting event created before `before`, found per key
     * through `timeline_task_state_before` (so a card's notes and messages are never walked).
     */
    latestTaskStatesBefore(projectKey: string, taskKeys: readonly string[], before: string): TimelineEvent[] {
      if (taskKeys.length === 0) return [];
      const keys = JSON.stringify([...new Set(taskKeys)]);
      return (statements.stateBefore.all(projectKey, projectKey, before, keys) as TimelineRow[]).map(toEvent);
    },
    involvements(projectKey: string, query: InvolvementQuery, cursor?: [string, string]) {
      const params: (string | number)[] = [projectKey];
      let where = `project_key = ? AND type IN ('session_started', 'session_ended')
        AND COALESCE(json_extract(data, '$.stop.kind'), '') <> 'restart'`;
      if (query.member) {
        where += " AND json_extract(data, '$.member') = ?";
        params.push(query.member);
      }
      if (query.task) {
        where += ' AND task_key = ?';
        params.push(query.task);
      }
      if (query.since) {
        where += ' AND created_at >= ?';
        params.push(query.since);
      }
      if (query.kind) {
        where += ' AND type = ?';
        params.push(query.kind === 'started' ? 'session_started' : 'session_ended');
      }
      if (query.by) {
        const by =
          "CASE WHEN type = 'session_started' THEN json_extract(data, '$.cause.by') ELSE json_extract(data, '$.stop.by') END";
        const known =
          "CASE WHEN type = 'session_started' THEN json_extract(data, '$.cause') ELSE json_extract(data, '$.stop') END";
        where += ` AND (${known}) IS NOT NULL`;
        if (query.by === 'system')
          where += ` AND ((${by}) IS NULL OR json_extract((${by}), '$.kind') = 'system')`;
        else if (query.by === 'integrator') where += ` AND json_extract((${by}), '$.via') = 'integrator'`;
        else {
          where += ` AND json_extract((${by}), '$.handle') = ? AND json_extract((${by}), '$.via') IS NULL`;
          params.push(query.by);
        }
      }
      const countRows = db
        .prepare(`SELECT type, COUNT(*) AS n FROM timeline_events WHERE ${where} GROUP BY type`)
        .all(...params) as { type: string; n: number }[];
      const counts = { started: 0, stopped: 0 };
      for (const row of countRows) counts[row.type === 'session_started' ? 'started' : 'stopped'] = row.n;
      if (cursor) {
        where += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
        params.push(cursor[0], cursor[0], cursor[1]);
      }
      const rows = db
        .prepare(`SELECT * FROM timeline_events WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...params, query.limit + 1) as TimelineRow[];
      return { events: rows.slice(0, query.limit).map(toEvent), counts, more: rows.length > query.limit };
    },
    /** One event of a project, or null. */
    /** The ids of the card's newest events a loop assessment may name as evidence (`isLoopTriageEvidence`). */
    loopEvidenceIds(projectKey: string, taskKey: string, limit: number): string[] {
      return (statements.loopEvidenceIds.all(projectKey, taskKey, limit) as Array<{ id: string }>).map(
        (row) => row.id,
      );
    },
    get(projectKey: string, id: string): TimelineEvent | null {
      const row = statements.byId.get(projectKey, id) as TimelineRow | undefined;
      return row ? toEvent(row) : null;
    },
    insert(e: TimelineEvent): void {
      statements.insert.run(
        e.id,
        e.projectKey,
        e.taskKey,
        e.sessionId,
        e.actor.kind,
        e.actor.handle,
        e.type,
        toJson(e.data),
        e.createdAt,
        e.actor.via ?? null,
        originMetaJson(e.actor),
      );
    },
    forMember(projectKey: string, handle: string, limit = 30): TimelineEvent[] {
      const rows = statements.forMember.all(
        projectKey,
        handle,
        handle,
        handle,
        handle,
        handle,
        limit,
      ) as TimelineRow[];
      return rows.reverse().map(toEvent);
    },
    /**
     * The team messages and notes (not imported ones) on a card from `since` (an ISO time) on,
     * oldest first; at most `limit`, the most recent ones.
     */
    talkSince(projectKey: string, taskKey: string, since: string, limit = 1000): TimelineEvent[] {
      const rows = statements.talkSince.all(projectKey, taskKey, since, limit) as TimelineRow[];
      return rows.reverse().map(toEvent);
    },
    /** All stage, label, full-test and fix-limit sources of a card in database sequence order. */
    roundEvents(projectKey: string, taskKey: string): TimelineEvent[] {
      return (statements.roundEvents.all(projectKey, taskKey) as TimelineRow[]).map(toEvent);
    },
    /** The most recent event of a type in a session, regardless of project activity. */
    latestForSession(
      projectKey: string,
      sessionId: string,
      type: TimelineEvent['type'],
    ): TimelineEvent | null {
      const row = db
        .prepare(
          'SELECT * FROM timeline_events WHERE project_key = ? AND session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1',
        )
        .get(projectKey, sessionId, type) as TimelineRow | undefined;
      return row ? toEvent(row) : null;
    },
    /** The most recent event of a type on a card, or null. */
    latestOfType(projectKey: string, taskKey: string, type: TimelineEvent['type']): TimelineEvent | null {
      const row = statements.latestOfType.get(projectKey, taskKey, type) as TimelineRow | undefined;
      return row ? toEvent(row) : null;
    },
    /** The most recent `limit` events of a type in a project, cards or not, newest first. */
    ofProjectType(projectKey: string, type: TimelineEvent['type'], limit: number): TimelineEvent[] {
      return (statements.ofProjectType.all(projectKey, type, limit) as TimelineRow[]).map(toEvent);
    },
    /** The most recent work on a card: a note, an attachment or a new description (PM-431), or null. */
    latestWork(projectKey: string, taskKey: string): TimelineEvent | null {
      const row = statements.latestWork.get(projectKey, taskKey) as TimelineRow | undefined;
      return row ? toEvent(row) : null;
    },
    /** The most recent `limit` events of the given types on a card, oldest first. */
    listOfTypes(
      projectKey: string,
      taskKey: string,
      types: TimelineEvent['type'][],
      limit: number,
    ): TimelineEvent[] {
      if (types.length === 0) return [];
      const signature = types.length;
      let statement = ofTypes.get(signature);
      if (!statement) {
        statement = db.prepare(
          `SELECT * FROM timeline_events WHERE project_key = ? AND task_key = ?
             AND type IN (${types.map(() => '?').join(', ')}) ORDER BY seq DESC LIMIT ?`,
        );
        ofTypes.set(signature, statement);
      }
      const rows = statement.all(projectKey, taskKey, ...types, limit) as TimelineRow[];
      return rows.reverse().map(toEvent);
    },
    /** The most recent `limit` events, oldest first. */
    list(projectKey: string, opts: { taskKey?: string; limit?: number } = {}): TimelineEvent[] {
      const limit = opts.limit ?? 200;
      const rows = (
        opts.taskKey
          ? statements.ofTask.all(projectKey, opts.taskKey, limit)
          : statements.ofProject.all(projectKey, limit)
      ) as TimelineRow[];
      return rows.reverse().map(toEvent);
    },
  };
}
