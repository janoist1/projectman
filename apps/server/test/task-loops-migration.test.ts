import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('task loops migration (PM-261)', () => {
  it('preserves pre-triage owner and ended rows, and signal receipts (PM-712)', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 72)) db.exec(migration.sql);
      db.pragma('user_version = 72');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
          VALUES ('tsk_1', 'AR', 'AR-1', 1, 'Owner loop', '', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01'),
            ('tsk_2', 'AR', 'AR-2', 2, 'Ended loop', '', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');
        INSERT INTO task_loops (id, project_key, task_key, started_at, raised_at, last_message_at, members, count,
        notified_count, phase, owner_reason, deciders, inbox_item_id, head_commit, ended_at, end_reason)
        VALUES ('old-owner', 'AR', 'AR-1', '2026-10-01', '2026-10-01', '2026-10-01', '["dev","cr"]', 6,
          6, 'owner', 'continued', '["owner"]', 'inb_old', 'c1', NULL, NULL),
          ('old-ended', 'AR', 'AR-2', '2026-10-01', '2026-10-01', '2026-10-01', '["dev","cr"]', 6,
          6, 'owner', 'continued', '["owner"]', 'inb_ended', 'c1', '2026-10-02', 'commit');
        INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at, delivered_at, delivered_to)
          VALUES ('ops_old', 'AR', 'silent', 'silent:old', 'open', '2026-10-01', '2026-10-01', 'pm'),
            ('ops_refinement', 'AR', 'refinement_stalled', 'refinement:old', 'pending', '2026-10-01', NULL, NULL);
        INSERT INTO question_groups VALUES ('inb_primary', 'AR', 'Existing question', '2026-10-01', 'owner', 'Shared');
        INSERT INTO question_group_items VALUES ('inb_secondary', 'inb_primary');`);
      migrate(db);
      const repos = createRepositories(db);
      expect(repos.taskLoops.get('old-owner')).toMatchObject({
        phase: 'owner',
        triage: null,
        inboxItemId: 'inb_old',
      });
      expect(repos.taskLoops.get('old-ended')).toMatchObject({
        endedAt: '2026-10-02',
        endReason: 'commit',
        triage: null,
      });
      expect(repos.operatorSignals.get('ops_old')).toMatchObject({
        state: 'open',
        deliveredTo: 'pm',
        deliveredAt: '2026-10-01',
      });
      expect(repos.operatorSignals.get('ops_refinement')).toMatchObject({
        kind: 'refinement_stalled',
        state: 'pending',
      });
      db.exec(`INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at)
        VALUES ('ops_loop', 'AR', 'loop_suspected', 'loop_suspected:loop_1:0', 'pending', '2026-10-01');`);
      expect(repos.operatorSignals.get('ops_loop')).toMatchObject({
        kind: 'loop_suspected',
        state: 'pending',
      });
      expect(
        db.prepare('SELECT primary_item_id FROM question_group_items WHERE item_id = ?').get('inb_secondary'),
      ).toEqual({ primary_item_id: 'inb_primary' });
      const versions = migrations.map((migration) => migration.version);
      expect(new Set(versions).size).toBe(versions.length);
      expect(versions.filter((version) => version >= 71 && version <= 73)).toEqual([71, 72, 73]);
    } finally {
      db.close();
    }
  });
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
        triage: null,
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
