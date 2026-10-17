import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('super-mode handoff migration (PM-762)', () => {
  it('adds the handoff and operation tables to an older database, keeps its rows and journals the new ones', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 82)) db.exec(migration.sql);
      db.pragma('user_version = 82');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');`);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare("SELECT key FROM projects WHERE key = 'AR'").get()).toBeTruthy();

      const insertHandoff = db.prepare(
        `INSERT INTO super_handoffs (id, project_key, task_key, request_id, requested_by, reason, command,
           command_hash, expected_config_version, state, operation_id, created_at, updated_at)
         VALUES (?, 'AR', NULL, ?, '{}', 'Reason', '{}', 'hash', NULL, 'pending', NULL, '2026-01-02', '2026-01-02')`,
      );
      insertHandoff.run('sho_1', 'req-1');
      // One request id is one handoff in a project.
      expect(() => insertHandoff.run('sho_2', 'req-1')).toThrow(/UNIQUE/);

      const insertOperation = db.prepare(
        `INSERT INTO super_operations (id, project_key, task_key, key_id, request_id, handoff_id, command,
           command_hash, expected_config_version, state, created_at, updated_at)
         VALUES (?, 'AR', NULL, 'ikey_1', ?, 'sho_1', '{}', 'hash', NULL, 'pending', '2026-01-02', '2026-01-02')`,
      );
      insertOperation.run('sop_1', 'req-1');
      // One (token, request id) is one operation: a retry can never start a second one.
      expect(() => insertOperation.run('sop_2', 'req-1')).toThrow(/UNIQUE/);

      const journal = db
        .prepare(
          "SELECT kind, entity_id FROM project_change_events WHERE project_key = 'AR' AND entity_id IN ('sho_1', 'sop_1')",
        )
        .all() as { kind: string; entity_id: string }[];
      expect(journal.map((row) => [row.kind, row.entity_id]).sort()).toEqual([
        ['handoff', 'sho_1'],
        ['operation', 'sop_1'],
      ]);

      // A project's deletion takes its handoffs along.
      db.prepare("DELETE FROM projects WHERE key = 'AR'").run();
      expect(db.prepare('SELECT count(*) AS n FROM super_handoffs').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM super_operations').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
