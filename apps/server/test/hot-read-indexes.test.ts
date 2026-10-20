import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, openDatabase } from '../src/db';
import { migrations } from '../src/db/migrations';

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
    } finally {
      db.close();
    }
  });

  it('migrates an existing v90 database with rows in all five tables and creates the five indexes', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version <= 90)) db.exec(migration.sql);
      db.pragma('user_version = 90');

      const at = '2026-10-19T12:00:00.000Z';
      db.exec(`
        INSERT INTO projects VALUES ('PM', 'Projectman', NULL, 'v1', '${at}', '${at}');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_1', 'PM', 'PM-1', 1, 'Card 1', '', 'dev', 'active', 'internal', 'owner', '${at}', '${at}');
        INSERT INTO inbox_items (id, project_key, kind, assignees, source, session_id, task_key, title, body, payload, options, state, resolution, created_at, updated_at)
        VALUES ('inb_1', 'PM', 'question', '["owner"]', 'dev-4', NULL, 'PM-1', 'Q?', NULL, '{}', '[]', 'open', NULL, '${at}', '${at}');
        INSERT INTO task_merges (id, project_key, task_key, repo, base, "commit", branch, from_stage_id, to_stage_id, merger, requested_at, started_by, started_at, state, step, landed, merge_commit, created_at, updated_at, finished_at)
        VALUES ('mrg_1', 'PM', 'PM-1', 'projectman', 'main', 'abc1234', 'PM-1-branch', 'review', 'done', 'claude', '${at}', 'claude', '${at}', 'merged', 'done', 1, 'def5678', '${at}', '${at}', '${at}');
        INSERT INTO task_loops (id, project_key, task_key, started_at, raised_at, last_message_at, members, count, notified, notified_count, phase, owner_reason, deciders, inbox_item_id, head_commit)
        VALUES ('lp_1', 'PM', 'PM-1', '${at}', '${at}', '${at}', '["dev","claude"]', 4, 'claude', 4, 'notified', NULL, '["claude"]', NULL, 'abc1234');
        INSERT INTO timeline_events (id, project_key, task_key, session_id, actor_kind, actor_handle, type, data, created_at)
        VALUES ('evt_1', 'PM', NULL, NULL, 'human', 'owner', 'focus_changed', '{"keys":["PM-1"]}', '${at}');
        INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, provider, cwd, state, started_at, last_activity_at)
        VALUES ('ses_1', 'PM', 'dev-4', 'task', 'PM-1', '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11', 'gemini', '/w', 'working', '${at}', '${at}');
      `);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);

      const indexes = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('inbox_open', 'task_merges_task', 'task_loops_task_key', 'timeline_project_type', 'sessions_state') ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(indexes).toEqual([
        'inbox_open',
        'sessions_state',
        'task_loops_task_key',
        'task_merges_task',
        'timeline_project_type',
      ]);

      const repos = createRepositories(db);
      expect(repos.inbox.listOpen().map((i) => i.id)).toEqual(['inb_1']);
      expect(repos.inbox.listOpen('question').map((i) => i.id)).toEqual(['inb_1']);
      expect(repos.taskMerges.latestMerged('PM', 'PM-1')?.id).toBe('mrg_1');
      expect(repos.taskLoops.open('PM-1')?.id).toBe('lp_1');
      expect(repos.taskLoops.lastEndedAt('PM-1')).toBeNull();
      expect(repos.timeline.ofProjectType('PM', 'focus_changed', 5).map((e) => e.id)).toEqual(['evt_1']);
      expect(repos.sessions.listInStates(['working']).map((s) => s.id)).toEqual(['ses_1']);
    } finally {
      db.close();
    }
  });
});
