import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, migrations } from '../src/db';

describe('egress migration (16)', () => {
  it('keeps the data of a version 15 database and is idempotent', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version <= 15)) db.exec(migration.sql);
      db.pragma('user_version = 15');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO timeline_events (id, project_key, actor_kind, actor_handle, type, data, created_at)
        VALUES ('old_event', 'AR', 'human', 'owner', 'boundary_changed', '{"requestId":"bnd_1","state":"allowed"}', '2026-01-01');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.timeline.list('AR')[0]).toMatchObject({ type: 'boundary_changed' });
    } finally {
      db.close();
    }
  });
});
