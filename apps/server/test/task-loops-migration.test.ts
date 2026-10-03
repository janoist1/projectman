import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('task loops migration (PM-261)', () => {
  it('adds the table to a database from before it, and keeps one open loop per card with its history', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 28)) db.exec(migration.sql);
      db.pragma('user_version = 28');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const { taskLoops } = createRepositories(db);
      expect(taskLoops.open('AR-1')).toBeNull();
      expect(taskLoops.lastEndedAt('AR-1')).toBeNull();

      const loop = {
        id: 'loop_1',
        projectKey: 'AR',
        taskKey: 'AR-1',
        startedAt: '2026-10-01T12:00:00.000Z',
        raisedAt: '2026-10-01T12:05:00.000Z',
        lastMessageAt: '2026-10-01T12:05:00.000Z',
        members: ['cr', 'dev-1'],
        count: 6,
        notified: 'pm',
        notifiedCount: 6,
        phase: 'notified' as const,
        ownerReason: null,
        deciders: [],
        inboxItemId: null,
        headCommit: 'c1',
      };
      taskLoops.create(loop);
      expect(taskLoops.open('AR-1')).toEqual({ ...loop, endedAt: null, endReason: null, letRunBy: null });
      expect(taskLoops.listOpen('AR')).toHaveLength(1);
      expect(taskLoops.listOpen('OTHER')).toEqual([]);

      taskLoops.save({
        ...loop,
        endedAt: null,
        endReason: null,
        count: 9,
        phase: 'let_run',
        letRunBy: 'owner',
        inboxItemId: 'inb_1',
        deciders: ['owner'],
      });
      expect(taskLoops.ofInboxItem('inb_1')).toMatchObject({ count: 9, phase: 'let_run', letRunBy: 'owner' });

      taskLoops.close('loop_1', '2026-10-01T12:30:00.000Z', 'quiet');
      expect(taskLoops.open('AR-1')).toBeNull();
      expect(taskLoops.get('loop_1')).toMatchObject({
        endedAt: '2026-10-01T12:30:00.000Z',
        endReason: 'quiet',
      });
      expect(taskLoops.lastEndedAt('AR-1')).toBe('2026-10-01T12:30:00.000Z');
      // An ended loop is not written to again.
      taskLoops.close('loop_1', '2026-10-01T13:00:00.000Z', 'commit');
      expect(taskLoops.get('loop_1')).toMatchObject({ endReason: 'quiet' });
    } finally {
      db.close();
    }
  });
});
