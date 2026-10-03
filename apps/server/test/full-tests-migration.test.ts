import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('full test runs migration', () => {
  it('adds the table next to the existing data without touching it, and only once', () => {
    const db = new Database(':memory:');
    try {
      // A database as the build before this migration left it.
      for (const migration of migrations.filter((item) => item.version <= 31)) db.exec(migration.sql);
      db.pragma('user_version = 31');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'code_review', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);
      const tables = () =>
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name)
          .sort();
      expect(tables()).not.toContain('full_test_runs');

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tables()).toContain('full_test_runs');
      const repos = createRepositories(db);
      // Nothing is inferred from what was there: no card gets a run.
      expect(repos.fullTestRuns.list('queued')).toEqual([]);
      expect(repos.fullTestRuns.forTask('AR-1')).toEqual([]);
      expect(repos.tasks.get('AR-1')).toMatchObject({ key: 'AR-1', stageId: 'code_review' });

      repos.fullTestRuns.queue({
        id: 'ftr_1',
        projectKey: 'AR',
        taskKey: 'AR-1',
        repo: 'web',
        branch: 'task/AR-1',
        commit: 'c1',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      repos.fullTestRuns.start('ftr_1', '2026-01-02T00:00:01.000Z');
      repos.fullTestRuns.finish('ftr_1', {
        status: 'failed',
        exitCode: 1,
        failedFiles: ['a.test.ts'],
        durationMs: 5,
        finishedAt: '2026-01-02T00:00:02.000Z',
      });
      // A second run applies nothing and keeps what was stored.
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(repos.fullTestRuns.get('ftr_1')).toMatchObject({
        status: 'failed',
        commit: 'c1',
        failedFiles: ['a.test.ts'],
        exitCode: 1,
      });
    } finally {
      db.close();
    }
  });

  it('finds the runs of a pin: its commit, made since it was pinned', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'code_review', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);
      const repos = createRepositories(db);
      const queue = (id: string, commit: string, createdAt: string) =>
        repos.fullTestRuns.queue({
          id,
          projectKey: 'AR',
          taskKey: 'AR-1',
          repo: 'web',
          branch: 'task/AR-1',
          commit,
          createdAt,
        });
      queue('before', 'c1', '2026-01-02T00:00:00.000Z');
      queue('other', 'c2', '2026-01-03T00:00:00.000Z');
      queue('after', 'c1', '2026-01-04T00:00:00.000Z');
      const pin = { taskKey: 'AR-1', commit: 'c1', pinnedAt: '2026-01-03T12:00:00.000Z' };
      expect(repos.fullTestRuns.forPin(pin).map((run) => run.id)).toEqual(['after']);
    } finally {
      db.close();
    }
  });
});
