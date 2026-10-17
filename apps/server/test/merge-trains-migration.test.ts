import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, migrations, schemaVersion } from '../src/db';

describe('merge trains migration', () => {
  it('preserves historical merge rows and adds nullable train membership idempotently', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version < 60)) db.exec(migration.sql);
      db.pragma('user_version = 59');
      const at = '2026-10-14T10:00:00.000Z';
      const failure = { reason: 'check_failed', base: 'b'.repeat(40), at, command: 'npm test' };
      db.prepare(
        `INSERT INTO task_merges
        (id, project_key, task_key, repo, base, "commit", branch, from_stage_id, to_stage_id,
         merger, requested_at, state, landed, failure_json, created_at, updated_at, prioritized_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'merge_old00001',
        'PM',
        'PM-1',
        'projectman',
        'main',
        'a'.repeat(40),
        'PM-1-change',
        'review',
        'done',
        'claude',
        at,
        'failed',
        'nowhere',
        JSON.stringify(failure),
        at,
        at,
        at,
      );
      const before = db.prepare('SELECT * FROM task_merges').get() as Record<string, unknown>;

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare('SELECT * FROM task_merges').get()).toEqual({
        ...before,
        train_id: null,
        diagnostic_json: null,
        queue_rank: null,
      });
      const repos = createRepositories(db);
      const row = repos.taskMerges.get('merge_old00001')!;
      expect(row).toMatchObject({ state: 'failed', failure, prioritizedAt: at });
      expect(row).not.toHaveProperty('trainId');
      expect(row).not.toHaveProperty('diagnostic');
      expect(repos.mergeTrains.listRunning()).toEqual([]);
      repos.taskMerges.save(row);
      expect(db.prepare('SELECT * FROM task_merges').get()).toEqual({
        ...before,
        train_id: null,
        diagnostic_json: null,
        queue_rank: null,
      });

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(repos.taskMerges.get(row.id)).toEqual(row);
    } finally {
      db.close();
    }
  });
});
