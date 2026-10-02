import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { BOARD_RANK_STEP } from '@projectman/shared';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

const BOARD_ORDER_VERSION = migrations.find((item) => item.name === 'manual board order of tasks')!.version;

describe('board order migration', () => {
  it('numbers the cards that exist, newest update first, project by project, and keeps their data', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version < BOARD_ORDER_VERSION))
        db.exec(migration.sql);
      db.pragma(`user_version = ${BOARD_ORDER_VERSION - 1}`);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO projects VALUES ('BR', 'Other', NULL, 'v1', '2026-01-01', '2026-01-01');`);
      const insert = db.prepare(
        `INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', 'backlog', 'active', 'internal', 'owner', '2026-01-01', ?)`,
      );
      insert.run('t1', 'AR', 'AR-1', 1, 'Oldest', '2026-01-01T00:00:00Z');
      insert.run('t2', 'AR', 'AR-2', 2, 'Newest', '2026-01-03T00:00:00Z');
      insert.run('t3', 'AR', 'AR-3', 3, 'Tied, later number', '2026-01-02T00:00:00Z');
      insert.run('t4', 'AR', 'AR-4', 4, 'Tied, higher number', '2026-01-02T00:00:00Z');
      insert.run('t5', 'BR', 'BR-1', 1, 'Other project', '2026-01-01T00:00:00Z');
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const rank = (key: string) => createRepositories(db).tasks.get(key)!.boardRank;
      // updated_at DESC, then seq DESC; every project counts from the start.
      expect(['AR-2', 'AR-4', 'AR-3', 'AR-1'].map(rank)).toEqual(
        [1, 2, 3, 4].map((n) => n * BOARD_RANK_STEP),
      );
      expect(rank('BR-1')).toBe(BOARD_RANK_STEP);
      expect(createRepositories(db).tasks.get('AR-1')).toMatchObject({ title: 'Oldest', stageId: 'backlog' });
      // Run again: nothing is numbered twice.
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(rank('AR-2')).toBe(BOARD_RANK_STEP);
    } finally {
      db.close();
    }
  });
});
