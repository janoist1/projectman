import type { TimelineEvent } from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

interface TimelineRow {
  seq: number;
  id: string;
  project_key: string;
  task_key: string | null;
  session_id: string | null;
  actor_kind: string;
  actor_handle: string | null;
  type: string;
  data: string;
  created_at: string;
}

const toEvent = (r: TimelineRow): TimelineEvent => ({
  id: r.id,
  projectKey: r.project_key,
  taskKey: r.task_key,
  sessionId: r.session_id,
  actor: { kind: r.actor_kind as TimelineEvent['actor']['kind'], handle: r.actor_handle },
  type: r.type as TimelineEvent['type'],
  data: parseJson<Record<string, unknown>>(r.data, {}),
  createdAt: r.created_at,
});

export function createTimelineRepository(db: Db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO timeline_events (id, project_key, task_key, session_id, actor_kind, actor_handle, type, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ofProject: db.prepare('SELECT * FROM timeline_events WHERE project_key = ? ORDER BY seq DESC LIMIT ?'),
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
    /** One event of a project, or null. */
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
