import { describe, expect, it } from 'vitest';
import { createRepositories, openDatabase } from '../src/db';

const HOT_READ_SQL = {
  listOpen: `SELECT * FROM inbox_items WHERE state = 'open' ORDER BY seq`,
  listOpenOfKind: `SELECT * FROM inbox_items WHERE state = 'open' AND kind = ? ORDER BY seq`,
  latestMerged:
    "SELECT * FROM task_merges WHERE project_key = ? AND task_key = ? AND state = 'merged' ORDER BY finished_at DESC, rowid DESC LIMIT 1",
  openOfTask: 'SELECT * FROM task_loops WHERE task_key = ? AND ended_at IS NULL',
  lastEnded:
    'SELECT ended_at FROM task_loops WHERE task_key = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1',
  ofProjectType: 'SELECT * FROM timeline_events WHERE project_key = ? AND type = ? ORDER BY seq DESC LIMIT ?',
  listInStates: 'SELECT * FROM sessions WHERE state IN (?, ?) ORDER BY started_at',
  sentSince: `SELECT * FROM team_messages WHERE project_key = ? AND from_handle IN (SELECT value FROM json_each(?))
       AND created_at >= ? ORDER BY created_at, seq`,
};

describe('hot read indexes (PM-834)', () => {
  it('prepares the exact hot-read statements in the repositories and serves them from their named indexes', () => {
    const db = openDatabase(':memory:');
    try {
      const prepared = new Set<string>();
      const origPrepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        prepared.add(sql);
        return origPrepare(sql);
      }) as typeof db.prepare;

      const repos = createRepositories(db);
      repos.taskMerges.latestMerged('PM', 'PM-1');
      repos.sessions.listInStates(['working', 'idle']);
      repos.messages.sentSince('PM', ['pm'], '2026-11-06T00:00:00.000Z');

      for (const sql of Object.values(HOT_READ_SQL)) {
        expect(prepared).toContain(sql);
      }

      const plan = (sql: string, ...params: unknown[]) =>
        (origPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
          .map((row) => row.detail)
          .join('\n');

      expect(plan(HOT_READ_SQL.listOpen)).toContain('inbox_open');
      expect(plan(HOT_READ_SQL.listOpenOfKind, 'question')).toContain('inbox_open');
      expect(plan(HOT_READ_SQL.latestMerged, 'PM', 'PM-1')).toContain('task_merges_task');
      expect(plan(HOT_READ_SQL.openOfTask, 'PM-1')).toContain('task_loops_task_key');
      expect(plan(HOT_READ_SQL.lastEnded, 'PM-1')).toContain('task_loops_task_key');
      expect(plan(HOT_READ_SQL.ofProjectType, 'PM', 'focus_changed', 1)).toContain('timeline_project_type');
      expect(plan(HOT_READ_SQL.listInStates, 'working', 'idle')).toContain('sessions_state');
      expect(plan(HOT_READ_SQL.sentSince, 'PM', '["pm"]', '2026-11-06T00:00:00.000Z')).toContain(
        'team_messages_from',
      );
    } finally {
      db.close();
    }
  });
});
