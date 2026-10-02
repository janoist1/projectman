import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('current work migration (PM-238)', () => {
  it('reads an older session without a sentence and stores and clears one on it', () => {
    const db = new Database(':memory:');
    try {
      // A database as the build before this migration left it, with a session in it.
      for (const migration of migrations.filter((item) => item.version <= 26)) db.exec(migration.sql);
      db.pragma('user_version = 26');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd, branch, state, started_at, last_activity_at)
        VALUES ('ses_old', 'AR', 'dev-1', 'task', 'AR-1', '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11', '/home/workspace', NULL, 'working', '2026-01-01', '2026-01-01');`);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.sessions.get('ses_old')).not.toHaveProperty('doing');

      const doing = { summary: 'The gateway tests are being written', detail: 'Retries and timeouts.' };
      expect(repos.sessions.update('ses_old', { doing })?.doing).toEqual(doing);
      expect(repos.sessions.update('ses_old', { doing: { summary: 'Only a summary' } })?.doing).toEqual({
        summary: 'Only a summary',
      });
      // Other changes leave it alone; null clears it.
      expect(repos.sessions.update('ses_old', { activity: 'Bash: ls' })?.doing).toEqual({
        summary: 'Only a summary',
      });
      expect(repos.sessions.update('ses_old', { doing: null })).not.toHaveProperty('doing');
    } finally {
      db.close();
    }
  });
});
