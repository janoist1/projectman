import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { TimelineEvent } from '@projectman/shared';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('attachments migration', () => {
  it('adds the table next to the existing data without touching it, and only once', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    try {
      // A database as the build before this migration left it (version 10), with old rows.
      for (const migration of migrations.filter((item) => item.version <= 10)) db.exec(migration.sql);
      db.pragma('user_version = 10');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'code_review', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');
        INSERT INTO timeline_events (id, project_key, task_key, actor_kind, actor_handle, type, data, created_at)
        VALUES ('evt_old', 'AR', 'AR-1', 'human', 'owner', 'task_note', '{"text":"an old note"}', '2026-01-01');`);
      const tables = () =>
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name)
          .sort();
      expect(tables()).not.toContain('attachments');

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
      expect(tables()).toContain('attachments');

      const repos = createRepositories(db);
      // Nothing is made up for the old tasks, and what was there reads as before.
      expect(repos.attachments.listReady('AR', 'AR-1')).toEqual([]);
      expect(repos.tasks.get('AR-1')).toMatchObject({ key: 'AR-1', stageId: 'code_review' });
      const [old] = repos.timeline.list('AR', { taskKey: 'AR-1' });
      expect(TimelineEvent.safeParse(old).success).toBe(true);
      expect(old).toMatchObject({ type: 'task_note', data: { text: 'an old note' } });

      // The rows work: pending, ready, deleting, removed.
      const base = {
        id: 'att_migrationtest1',
        projectKey: 'AR',
        taskKey: 'AR-1',
        fileName: 'a.png',
        uploadedBy: { kind: 'human' as const, handle: 'owner' },
        createdAt: '2026-01-02T00:00:00.000Z',
      };
      repos.attachments.insertPending(base);
      expect(repos.attachments.listReady('AR', 'AR-1')).toEqual([]);
      expect(
        repos.attachments.markReady(base.id, { size: 3, mediaType: 'image/png', preview: 'image' }),
      ).toBe(true);
      expect(repos.attachments.listReady('AR', 'AR-1')).toMatchObject([{ id: base.id, size: 3 }]);
      // No hard delete of a task takes its attachments' rows (and files) along silently.
      expect(() => db.exec("DELETE FROM tasks WHERE key = 'AR-1'")).toThrow(/FOREIGN KEY/);
      expect(repos.attachments.markDeleting(base.id, { kind: 'human', handle: 'owner' }, 'now')).toBe(true);
      expect(repos.attachments.listReady('AR', 'AR-1')).toEqual([]);
      expect(repos.attachments.remove(base.id)).toBe(true);

      // A second run applies nothing.
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(repos.tasks.get('AR-1')).toMatchObject({ key: 'AR-1' });
    } finally {
      db.close();
    }
  });

  it('refuses states and previews it does not know', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', '', 'backlog', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);
      const insert = (state: string, preview: string) =>
        db.exec(`INSERT INTO attachments (id, project_key, task_key, file_name, size, media_type, preview,
          uploaded_by_kind, uploaded_by_handle, created_at, state)
          VALUES ('att_x${Math.random().toString(36).slice(2, 12)}', 'AR', 'AR-1', 'a', 1, 'x/y', '${preview}', 'human', 'owner', 'now', '${state}')`);
      expect(() => insert('ready', 'image')).not.toThrow();
      expect(() => insert('archived', 'image')).toThrow(/CHECK/);
      expect(() => insert('ready', 'svg')).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
