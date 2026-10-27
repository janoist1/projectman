import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrate, migrations } from '../src/db';

describe('external operation requests removal migration (113)', () => {
  it('drops the request tables and the rows made for them, keeps the rest and is idempotent', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      for (const migration of migrations.filter((m) => m.version <= 112)) db.exec(migration.sql);
      db.pragma('user_version = 112');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO boundary_requests VALUES ('bnd_1', 'AR', 'ses_1', 'retry-1', '{}');
        INSERT INTO boundary_grants VALUES ('grant_1', 'bnd_1', '{}');
        INSERT INTO egress_operations VALUES ('op_1', 'AR', 'dev', 'ses_1', NULL, 'example.test', 443, '2026-01-01', '2026-01-02');
        INSERT INTO egress_allowances VALUES ('al_1', 'AR', 'dev', 'example.test', 443, 'bnd_1', 'op_1', '2026-01-01', '2026-01-02', NULL, NULL);
        INSERT INTO inbox_items (id, project_key, kind, assignees, source, title, payload, options, state, created_at, updated_at)
        VALUES ('bnd_1', 'AR', 'boundary', '["owner"]', 'dev', 'External operation', '{}', '[]', 'open', '2026-01-01', '2026-01-01'),
               ('perm_1', 'AR', 'permission', '["owner"]', 'dev', 'Permission', '{}', '[]', 'open', '2026-01-01', '2026-01-01');
        INSERT INTO member_queue_items (id, project_key, member, kind, source_type, source_id, place, queued_at)
        VALUES ('mq_1', 'AR', 'lead', 'boundary', 'boundary', 'bnd_1', 'general', '2026-01-01'),
               ('mq_2', 'AR', 'lead', 'permission', 'inbox', 'perm_1', 'general', '2026-01-01');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      ).map((row) => row.name);
      expect(names).not.toContain('boundary_requests');
      expect(names).not.toContain('boundary_grants');
      expect(db.prepare('SELECT id FROM inbox_items').all()).toEqual([{ id: 'perm_1' }]);
      expect(db.prepare('SELECT id FROM member_queue_items').all()).toEqual([{ id: 'mq_2' }]);
    } finally {
      db.close();
    }
  });
});
