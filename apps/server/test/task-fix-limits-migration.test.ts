import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('task fix limits migration (PM-262)', () => {
  it('adds the table to a database from before it, and keeps one row per card', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 29)) db.exec(migration.sql);
      db.pragma('user_version = 29');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(30);
      const { taskFixLimits } = createRepositories(db);
      expect(taskFixLimits.get('AR-1')).toBeNull();
      expect(taskFixLimits.listHeld()).toEqual([]);

      const record = {
        taskKey: 'AR-1',
        projectKey: 'AR',
        countedFrom: null,
        extraRounds: 0,
        holdPhase: 'lead' as const,
        heldAt: '2026-10-03T08:00:00.000Z',
        decider: 'lead',
        deciders: [],
        reason: null,
        inboxItemId: null,
      };
      taskFixLimits.save(record);
      expect(taskFixLimits.get('AR-1')).toEqual(record);
      expect(taskFixLimits.listHeld('AR')).toHaveLength(1);
      expect(taskFixLimits.listHeld('OTHER')).toEqual([]);

      const passed = {
        ...record,
        holdPhase: 'owner' as const,
        decider: null,
        deciders: ['owner'],
        reason: 'passed_on' as const,
        inboxItemId: 'inb_1',
      };
      taskFixLimits.save(passed);
      expect(taskFixLimits.get('AR-1')).toEqual(passed);
      expect(taskFixLimits.ofInboxItem('inb_1')).toMatchObject({ taskKey: 'AR-1', deciders: ['owner'] });

      // Let go on: the count begins again, the row stays with no hold.
      taskFixLimits.save({
        ...passed,
        countedFrom: '2026-10-03T09:00:00.000Z',
        extraRounds: 1,
        holdPhase: null,
        heldAt: null,
        decider: null,
        deciders: [],
        reason: null,
        inboxItemId: null,
      });
      expect(taskFixLimits.get('AR-1')).toMatchObject({ holdPhase: null, extraRounds: 1 });
      expect(taskFixLimits.listHeld()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('migration 46 clears stalled fix limits (PM-469)', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 45)) db.exec(migration.sql);
      db.pragma('user_version = 45');

      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES 
        ('tsk_1', 'AR', 'AR-1', 1, 'Task 1', '', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01'),
        ('tsk_2', 'AR', 'AR-2', 2, 'Task 2', '', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01'),
        ('tsk_3', 'AR', 'AR-3', 3, 'Task 3', '', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01'),
        ('tsk_4', 'AR', 'AR-4', 4, 'Task 4', '', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');
      `);

      db.exec(`INSERT INTO inbox_items (id, project_key, kind, state, title, payload, assignees, source, options, created_at, updated_at) VALUES 
        ('inb_resolved', 'AR', 'decision', 'resolved', 'Resolved', '{}', '[]', 'system', '[]', '2026-01-01', '2026-01-01'),
        ('inb_open', 'AR', 'decision', 'open', 'Open', '{}', '[]', 'system', '[]', '2026-01-01', '2026-01-01'),
        ('inb_cancelled', 'AR', 'decision', 'cancelled', 'Cancelled', '{}', '[]', 'system', '[]', '2026-01-01', '2026-01-01');
      `);

      db.exec(`INSERT INTO task_fix_limits (task_key, project_key, extra_rounds, hold_phase, deciders, inbox_item_id) VALUES
        ('AR-1', 'AR', 0, 'owner', '[]', 'inb_resolved'),
        ('AR-2', 'AR', 0, 'owner', '[]', 'inb_open'),
        ('AR-3', 'AR', 0, 'owner', '[]', 'inb_cancelled'),
        ('AR-4', 'AR', 0, 'owner', '[]', 'inb_missing');
      `);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);

      const { taskFixLimits } = createRepositories(db);
      expect(taskFixLimits.get('AR-1')).toMatchObject({ holdPhase: 'owner', inboxItemId: 'inb_resolved' });
      expect(taskFixLimits.get('AR-2')).toMatchObject({ holdPhase: 'owner', inboxItemId: 'inb_open' });
      expect(taskFixLimits.get('AR-3')).toMatchObject({ holdPhase: null, inboxItemId: null });
      expect(taskFixLimits.get('AR-4')).toMatchObject({ holdPhase: null, inboxItemId: null });
    } finally {
      db.close();
    }
  });
});
