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

describe('senior recommendation migration (PM-1007)', () => {
  it('turns a senior recommendation into 8 points and leaves the other cards alone', () => {
    const version = migrations.find((m) => m.name === 'senior recommendation to complexity')!.version;
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version < version)) db.exec(migration.sql);
      db.pragma(`user_version = ${version - 1}`);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');`);
      const insert = db.prepare(
        `INSERT INTO tasks (id, project_key, key, seq, title, stage_id, status, visibility, created_by, created_at, updated_at, developer_level)
         VALUES (?, 'AR', ?, ?, 'Card', 'backlog', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01', ?)`,
      );
      const senior = { level: 'senior', reason: 'the runner', setBy: 'arch', setAt: '2026-02-03T04:05:06Z' };
      insert.run('t1', 'AR-1', 1, JSON.stringify(senior));
      insert.run('t2', 'AR-2', 2, JSON.stringify({ ...senior, level: 'any' }));
      insert.run('t3', 'AR-3', 3, null);
      insert.run('t4', 'AR-4', 4, '{broken');
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const stored = (key: string) =>
        (db.prepare('SELECT complexity FROM tasks WHERE key = ?').get(key) as { complexity: string | null })
          .complexity;
      expect(JSON.parse(stored('AR-1')!)).toEqual({
        points: 8,
        reason: 'the runner',
        setBy: 'arch',
        setAt: '2026-02-03T04:05:06Z',
      });
      expect([stored('AR-2'), stored('AR-3'), stored('AR-4')]).toEqual([null, null, null]);
      expect(createRepositories(db).tasks.get('AR-1')?.complexity).toMatchObject({ points: 8 });
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});

describe('task complexity migration', () => {
  it('adds a nullable column to existing cards and is idempotent', () => {
    const version = migrations.find((m) => m.name === 'task complexity')!.version;
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version < version)) db.exec(migration.sql);
      db.pragma(`user_version = ${version - 1}`);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');`);
      db.exec(`INSERT INTO tasks (id, project_key, key, seq, title, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('t1', 'AR', 'AR-1', 1, 'Old card', 'backlog', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01')`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare('SELECT complexity FROM tasks').get()).toEqual({ complexity: null });
      expect(createRepositories(db).tasks.get('AR-1')).not.toHaveProperty('complexity');
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
