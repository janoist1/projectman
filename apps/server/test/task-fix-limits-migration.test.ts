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
});
