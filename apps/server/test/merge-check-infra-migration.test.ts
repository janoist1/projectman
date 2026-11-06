import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

it('keeps a merge check recorded before the infrastructure cause existed, with no cause (PM-1292)', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of migrations.filter((m) => m.version < 147)) db.exec(migration.sql);
    db.pragma('user_version = 146');
    db.exec(`INSERT INTO projects (key, name, config_version, created_at, updated_at) VALUES ('AR', 'Example', 'v1', '2026-01-01', '2026-01-01');
      INSERT INTO merge_check_runs (id, project_key, repo, kind, commit_sha, status, reason, max_workers, requested_at, runner)
      VALUES ('old', 'AR', 'web', 'merge', '${'a'.repeat(40)}', 'error', 'github_unavailable', 4, '2026-01-01', 'github_actions');`);
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(createRepositories(db).mergeCheckRuns.get('old')).toMatchObject({
      status: 'error',
      reason: 'github_unavailable',
      infra: null,
    });
  } finally {
    db.close();
  }
});
