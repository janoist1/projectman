import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

const LEVEL_VERSION = migrations.find((item) => item.name === 'task developer level')!.version;

describe('developer level migration (PM-347)', () => {
  it('adds the column to an old database and reads the cards that exist as having no recommendation', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version < LEVEL_VERSION))
        db.exec(migration.sql);
      db.pragma(`user_version = ${LEVEL_VERSION - 1}`);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');`);
      db.prepare(
        `INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
         VALUES ('t1', 'AR', 'AR-1', 1, 'Old card', '', 'backlog', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01')`,
      ).run();
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const tasks = createRepositories(db).tasks;
      expect(tasks.get('AR-1')).toMatchObject({ title: 'Old card' });
      expect(tasks.get('AR-1')).not.toHaveProperty('developerLevel');
      // Run again: nothing changes.
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
