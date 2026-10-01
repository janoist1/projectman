import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('usage alert migration (PM-187)', () => {
  it('reads every older session as not over the limit, and marks a session only once', () => {
    const db = new Database(':memory:');
    try {
      // A database as the build before this migration left it.
      for (const migration of migrations.filter((item) => item.version <= 18)) db.exec(migration.sql);
      db.pragma('user_version = 18');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd, branch, state, started_at, last_activity_at, usage_since)
        VALUES ('ses_old', 'AR', 'dev-1', 'task', 'AR-1', '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11', '/work', NULL, 'exited', '2026-01-01', '2026-01-01', '2026-01-01');`);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.sessions.get('ses_old')).not.toHaveProperty('usageAlert');

      const alert = { at: '2026-10-01T12:00:00.000Z', countedTokens: 12_345, limitTokens: 10_000 };
      expect(repos.sessions.markUsageAlert('ses_old', alert)).toBe(true);
      expect(repos.sessions.markUsageAlert('ses_old', { ...alert, countedTokens: 99_999 })).toBe(false);
      expect(repos.sessions.get('ses_old')?.usageAlert).toEqual(alert);
    } finally {
      db.close();
    }
  });
});
