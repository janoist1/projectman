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
  return {
    insert(e: TimelineEvent): void {
      db.prepare(
        `INSERT INTO timeline_events (id, project_key, task_key, session_id, actor_kind, actor_handle, type, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
    /** The most recent `limit` events, oldest first. */
    list(projectKey: string, opts: { taskKey?: string; limit?: number } = {}): TimelineEvent[] {
      const limit = opts.limit ?? 200;
      const rows = (
        opts.taskKey
          ? db
              .prepare(
                'SELECT * FROM timeline_events WHERE project_key = ? AND task_key = ? ORDER BY seq DESC LIMIT ?',
              )
              .all(projectKey, opts.taskKey, limit)
          : db
              .prepare('SELECT * FROM timeline_events WHERE project_key = ? ORDER BY seq DESC LIMIT ?')
              .all(projectKey, limit)
      ) as TimelineRow[];
      return rows.reverse().map(toEvent);
    },
  };
}

export type TimelineRepository = ReturnType<typeof createTimelineRepository>;
