import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('task stage entered at migration', () => {
  it('fills stage_entered_at with the time of the last stage change, or created_at if none', () => {
    const db = new Database(':memory:');
    try {
      const MIGRATION_VERSION = migrations.find((item) => item.name === 'task stage entered at')!.version;
      const before = migrations.filter((item) => item.version < MIGRATION_VERSION);
      
      for (const migration of before) db.exec(migration.sql);
      db.pragma(`user_version = ${Math.max(...before.map((item) => item.version))}`);
      
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        
        -- Task 1: no events at all -> should fall back to created_at
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at, parent_key)
        VALUES ('tsk_1', 'AR', 'AR-1', 1, 'T1', '', 's1', 'active', 'internal', 'owner', '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z', NULL);
        
        -- Task 2: has a stage change event -> should use the last stage change event's time
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at, parent_key)
        VALUES ('tsk_2', 'AR', 'AR-2', 2, 'T2', '', 's2', 'active', 'internal', 'owner', '2026-01-01T10:00:00Z', '2026-01-02T12:00:00Z', NULL);
        
        INSERT INTO timeline_events (id, project_key, task_key, actor_kind, actor_handle, type, data, created_at)
        VALUES ('evt_1', 'AR', 'AR-2', 'human', 'owner', 'task_stage_changed', '{"from":"s1","to":"s2"}', '2026-01-02T10:00:00Z'),
               ('evt_2', 'AR', 'AR-2', 'human', 'owner', 'task_stage_changed', '{"from":"s2","to":"s3"}', '2026-01-02T12:00:00Z');
               
        -- Task 3: has events, but no stage change event -> should fall back to created_at
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at, parent_key)
        VALUES ('tsk_3', 'AR', 'AR-3', 3, 'T3', '', 's1', 'active', 'internal', 'owner', '2026-01-01T10:00:00Z', '2026-01-03T10:00:00Z', NULL);
        
        INSERT INTO timeline_events (id, project_key, task_key, actor_kind, actor_handle, type, data, created_at)
        VALUES ('evt_3', 'AR', 'AR-3', 'human', 'owner', 'task_created', '{}', '2026-01-01T10:00:00Z');
      `);

      // Run the migration we are testing and subsequent ones
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

      const rows = db.prepare('SELECT key, stage_entered_at FROM tasks ORDER BY seq').all() as any[];
      expect(rows).toEqual([
        { key: 'AR-1', stage_entered_at: '2026-01-01T10:00:00Z' },
        { key: 'AR-2', stage_entered_at: '2026-01-02T12:00:00Z' },
        { key: 'AR-3', stage_entered_at: '2026-01-01T10:00:00Z' },
      ]);

      // Check with repositories
      const repos = createRepositories(db);
      expect(repos.tasks.get('AR-1')!.stageEnteredAt).toBe('2026-01-01T10:00:00Z');
      expect(repos.tasks.get('AR-2')!.stageEnteredAt).toBe('2026-01-02T12:00:00Z');
      expect(repos.tasks.get('AR-3')!.stageEnteredAt).toBe('2026-01-01T10:00:00Z');
      
    } finally {
      db.close();
    }
  });
});
