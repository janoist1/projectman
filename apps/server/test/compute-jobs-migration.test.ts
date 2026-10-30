import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('compute job runs migration', () => {
  it('adds the table next to the existing data without touching it, and only once', () => {
    const db = new Database(':memory:');
    try {
      // A database as the build before this migration left it.
      for (const migration of migrations.filter((item) => item.version < 133)) db.exec(migration.sql);
      db.pragma('user_version = 132');
      db.exec(
        `INSERT INTO projects (key, name, config_version, created_at, updated_at) VALUES ('AR', 'Example', 'v1', '2026-01-01', '2026-01-01');`,
      );
      const tables = () =>
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        ).map((row) => row.name);
      expect(tables()).not.toContain('compute_job_runs');

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tables()).toContain('compute_job_runs');
      const repos = createRepositories(db);
      // Nothing is inferred from what was there: no run exists.
      expect(repos.computeJobRuns.unfinished()).toEqual([]);

      repos.computeJobRuns.insert({
        id: 'job_1',
        projectKey: 'AR',
        repo: 'web',
        job: 'cloud-image',
        commit: 'a'.repeat(40),
        runner: 'github_actions',
        requestedBy: 'devops',
        taskKey: null,
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(repos.computeJobRuns.get('job_1')).toMatchObject({ status: 'queued', job: 'cloud-image' });
    } finally {
      db.close();
    }
  });
});
