import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('execution profile migration (PM-141)', () => {
  it('reads every older session as legacy and keeps the profile beside the session, not in its shape', () => {
    const db = new Database(':memory:');
    try {
      // A database as the build before this migration left it, with a session of the Mac installation.
      for (const migration of migrations.filter((item) => item.version <= 13)) db.exec(migration.sql);
      db.pragma('user_version = 13');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd, branch, state, started_at, last_activity_at)
        VALUES ('ses_old', 'AR', 'dev-1', 'general', '', '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11', '/home/workspace', NULL, 'exited', '2026-01-01', '2026-01-01');`);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.sessions.executionProfile('ses_old')).toBe('legacy');
      // The public session is as it was: the profile is not one of its fields.
      expect(repos.sessions.get('ses_old')).not.toHaveProperty('executionProfile');
      expect(repos.sessions.get('ses_old')).toMatchObject({ cwd: '/home/workspace', state: 'exited' });

      repos.sessions.setExecutionProfile('ses_old', 'managed_vm');
      expect(repos.sessions.executionProfile('ses_old')).toBe('managed_vm');
      repos.sessions.setExecutionProfile('ses_old', 'legacy');
      expect(repos.sessions.executionProfile('ses_old')).toBe('legacy');
      // An unknown session is legacy: nothing is freer by default.
      expect(repos.sessions.executionProfile('ses_missing')).toBe('legacy');
      // The column is never null: a profile is always named.
      expect(() => db.exec(`UPDATE sessions SET execution_profile = NULL`)).toThrow();
    } finally {
      db.close();
    }
  });
});
