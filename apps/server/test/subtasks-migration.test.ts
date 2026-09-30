import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('subtask migration', () => {
  it('adds a nullable parent to existing tasks without rewriting their data', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 6)) db.exec(migration.sql);
      db.pragma('user_version = 6');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', '**Existing description**', 'backlog', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(createRepositories(db).tasks.get('AR-1')).toMatchObject({
        key: 'AR-1',
        title: 'Example task',
        description: '**Existing description**',
        parentKey: null,
      });
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
