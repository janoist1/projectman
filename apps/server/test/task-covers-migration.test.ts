import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('task covers migration', () => {
  it('adds the table next to the existing data without touching it, and only once', () => {
    const db = new Database(':memory:');
    try {
      // A database as the build before this migration left it.
      for (const migration of migrations.filter((item) => item.version <= 25)) db.exec(migration.sql);
      db.pragma('user_version = 25');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'code_review', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);
      const tables = () =>
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name)
          .sort();
      expect(tables()).not.toContain('task_covers');

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tables()).toContain('task_covers');
      const repos = createRepositories(db);
      // Every existing card keeps the automatic cover.
      expect(repos.taskCovers.get('AR-1')).toBeNull();
      expect(repos.tasks.get('AR-1')).toMatchObject({ key: 'AR-1', stageId: 'code_review' });

      const setBy = { kind: 'human' as const, handle: 'owner' };
      repos.taskCovers.save({
        projectKey: 'AR',
        taskKey: 'AR-1',
        choice: { mode: 'pinned', attachmentId: 'att_aaaaaaaaaa' },
        setAt: '2026-01-02',
        setBy,
      });
      // A second run applies nothing and keeps what was stored; a new choice replaces the old.
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(repos.taskCovers.get('AR-1')?.choice).toEqual({
        mode: 'pinned',
        attachmentId: 'att_aaaaaaaaaa',
      });
      repos.taskCovers.save({
        projectKey: 'AR',
        taskKey: 'AR-1',
        choice: { mode: 'hidden' },
        setAt: '2026-01-03',
        setBy,
      });
      expect(repos.taskCovers.get('AR-1')).toMatchObject({ choice: { mode: 'hidden' }, setBy });
      // Another file's deletion leaves a hidden choice alone.
      repos.taskCovers.clearPinned('AR-1', 'att_aaaaaaaaaa');
      expect(repos.taskCovers.get('AR-1')?.choice).toEqual({ mode: 'hidden' });
    } finally {
      db.close();
    }
  });

  it('refuses a mode the table does not know', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'code_review', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);
      const insert = (mode: string, attachment: string | null) =>
        db.exec(
          `INSERT INTO task_covers VALUES ('AR', 'AR-1', '${mode}', ${attachment ? `'${attachment}'` : 'NULL'}, '2026-01-01', 'human', 'owner')`,
        );
      expect(() => insert('other', null)).toThrow();
      expect(() => insert('pinned', null)).toThrow();
      expect(() => insert('hidden', 'att_aaaaaaaaaa')).toThrow();
    } finally {
      db.close();
    }
  });
});
