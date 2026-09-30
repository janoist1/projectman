import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('deferred starts migration', () => {
  it('adds the table next to the existing data without touching it, and only once', () => {
    const db = new Database(':memory:');
    try {
      // A database as the build before this migration left it.
      for (const migration of migrations.filter((item) => item.version <= 9)) db.exec(migration.sql);
      db.pragma('user_version = 9');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'code_review', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');
        INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd, state, started_at, last_activity_at)
        VALUES ('ses_example', 'AR', 'cr', 'task', 'AR-1', '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11', '/w', 'exited', '2026-01-01', '2026-01-01');`);
      const tables = () =>
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name)
          .sort();
      expect(tables()).not.toContain('deferred_starts');

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tables()).toContain('deferred_starts');
      const repos = createRepositories(db);
      // Nothing is inferred from what was there: no task or session becomes a deferred start.
      expect(repos.deferredStarts.list()).toEqual([]);
      expect(repos.tasks.get('AR-1')).toMatchObject({
        key: 'AR-1',
        stageId: 'code_review',
        status: 'active',
      });
      expect(repos.sessions.get('ses_example')).toMatchObject({ member: 'cr', state: 'exited' });

      const record = {
        key: 'hand-over:AR:AR-1',
        projectKey: 'AR',
        taskKey: 'AR-1',
        spec: {
          kind: 'hand_over',
          projectKey: 'AR',
          taskKey: 'AR-1',
          from: 'development',
          to: 'code_review',
        },
        waiting: { reason: 'ai_disabled', member: 'cr', since: '2026-01-01T00:00:00.000Z' },
      };
      repos.deferredStarts.save(record);
      // A second run applies nothing and keeps what was stored.
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(repos.deferredStarts.list()).toEqual([record]);
    } finally {
      db.close();
    }
  });
});
