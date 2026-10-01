import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('token usage migration (PM-178)', () => {
  it('reads every older session without usage ("no data") and counts usage once it is measured', () => {
    const db = new Database(':memory:');
    try {
      // A database as the build before this migration left it.
      for (const migration of migrations.filter((item) => item.version <= 17)) db.exec(migration.sql);
      db.pragma('user_version = 17');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd, branch, state, started_at, last_activity_at)
        VALUES ('ses_old', 'AR', 'dev-1', 'task', 'AR-1', '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11', '/work', NULL, 'exited', '2026-01-01', '2026-01-01');`);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.sessions.get('ses_old')).not.toHaveProperty('usage');

      const owner = { sessionId: 'ses_old', projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
      const at = new Date('2026-10-01T12:34:00.000Z');
      const row = {
        model: 'claude-opus-5-5',
        scope: 'main' as const,
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
      };
      repos.sessions.update('ses_old', { usageSince: at.toISOString() });
      repos.tokenUsage.add(owner, at, [row]);
      repos.tokenUsage.add(owner, new Date('2026-10-01T12:59:59.000Z'), [row]);
      repos.tokenUsage.add(owner, new Date('2026-10-01T13:00:00.000Z'), [row]);
      // One row per hour, added to.
      expect(db.prepare('SELECT hour, input_tokens FROM token_usage ORDER BY hour').all()).toEqual([
        { hour: '2026-10-01T12', input_tokens: 2 },
        { hour: '2026-10-01T13', input_tokens: 1 },
      ]);
      expect(repos.sessions.get('ses_old')?.usage).toEqual({
        since: '2026-10-01T12:34:00.000Z',
        rows: [{ ...row, input: 3, output: 6, cacheRead: 9, cacheWrite: 12 }],
      });
    } finally {
      db.close();
    }
  });
});
