import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrate, migrations } from '../src/db';

describe('in-app Operator queue removal migration (120)', () => {
  it('cancels the Operator members open queue rows, keeps the others and the inbox items', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      for (const migration of migrations.filter((m) => m.version <= 119)) db.exec(migration.sql);
      db.pragma('user_version = 119');
      db.exec(`INSERT INTO projects (key, name, config_version, created_at, updated_at)
        VALUES ('AR', 'Example', 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO inbox_items (id, project_key, kind, assignees, source, title, payload, options, state, created_at, updated_at)
        VALUES ('todo_1', 'AR', 'todo', '["operator"]', 'dev', 'Todo', '{}', '[]', 'open', '2026-01-01', '2026-01-01');
        INSERT INTO member_queue_items (id, project_key, member, kind, source_type, source_id, place, state, queued_at, closed_at, close_reason)
        VALUES ('mq_open', 'AR', 'operator', 'todo', 'inbox', 'todo_1', 'general', 'queued', '2026-01-01', NULL, NULL),
               ('mq_busy', 'AR', 'operator-2', 'message', 'message', 'msg_1', 'general', 'processing', '2026-01-01', NULL, NULL),
               ('mq_done', 'AR', 'operator', 'message', 'message', 'msg_2', 'general', 'done', '2026-01-01', '2026-01-02', 'finished'),
               ('mq_other', 'AR', 'lead', 'todo', 'inbox', 'todo_1', 'general', 'queued', '2026-01-01', NULL, NULL);`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const rows = db
        .prepare('SELECT id, state, close_reason AS reason FROM member_queue_items ORDER BY id')
        .all();
      expect(rows).toEqual([
        { id: 'mq_busy', state: 'cancelled', reason: 'source_closed' },
        { id: 'mq_done', state: 'done', reason: 'finished' },
        { id: 'mq_open', state: 'cancelled', reason: 'source_closed' },
        { id: 'mq_other', state: 'queued', reason: null },
      ]);
      expect(db.prepare("SELECT state FROM inbox_items WHERE id = 'todo_1'").get()).toEqual({
        state: 'open',
      });
    } finally {
      db.close();
    }
  });
});
