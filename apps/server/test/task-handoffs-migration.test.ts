import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import type { TaskHandoffRow } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('task handoffs migration (PM-342)', () => {
  const row: TaskHandoffRow = {
    id: 'hof_1',
    projectKey: 'AR',
    taskKey: 'AR-1',
    from: 'dev-1',
    to: 'dev-2',
    fromProvider: 'claude',
    toProvider: 'claude',
    fromSessionId: 'ses_1',
    reason: 'manual',
    step: 'waiting_point',
    startedAt: '2026-10-05T08:00:00.000Z',
    deadlineAt: '2026-10-05T08:10:00.000Z',
    outcome: null,
    fallbackReason: null,
    note: null,
    branch: null,
    lastCommit: null,
    uncommitted: null,
    summary: null,
    closingAt: null,
    endedAt: null,
    takenOverAt: null,
    takenOverSessionId: null,
  };

  it('adds the table to a database from before it, with at most one open handoff per card', () => {
    const db = new Database(':memory:');
    try {
      const handoffs = migrations.find((item) => item.name === 'task handoffs');
      expect(handoffs).toBeDefined();
      const before = (handoffs?.version ?? 1) - 1;
      for (const migration of migrations.filter((item) => item.version <= before)) db.exec(migration.sql);
      db.pragma(`user_version = ${before}`);
      expect(() => db.prepare('SELECT * FROM task_handoffs').all()).toThrow(/no such table/);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);

      const { taskHandoffs } = createRepositories(db);
      expect(taskHandoffs.open('AR-1')).toBeNull();
      expect(taskHandoffs.listOpen()).toEqual([]);
      taskHandoffs.create(row);
      expect(taskHandoffs.open('AR-1')).toEqual(row);
      expect(taskHandoffs.listOpen('AR')).toHaveLength(1);
      expect(taskHandoffs.listOpen('OTHER')).toEqual([]);
      // A second open handoff on the same card is refused by the database.
      expect(() => taskHandoffs.create({ ...row, id: 'hof_2' })).toThrow(/UNIQUE/);

      const summary = { source: 'last_replies' as const, text: 'Login form is done.', at: null };
      const closed: TaskHandoffRow = {
        ...row,
        step: 'closing',
        deadlineAt: null,
        outcome: 'fallback',
        fallbackReason: 'timeout',
        summary,
        branch: 'AR-1-login',
        lastCommit: 'abc1234',
        uncommitted: true,
        closingAt: '2026-10-05T08:10:00.000Z',
        endedAt: '2026-10-05T08:10:01.000Z',
      };
      taskHandoffs.save(closed);
      expect(taskHandoffs.get('hof_1')).toEqual(closed);
      expect(taskHandoffs.open('AR-1')).toBeNull();
      expect(taskHandoffs.latestClosed('AR-1')).toEqual(closed);
      expect(taskHandoffs.latestNote('AR-1')).toBeNull();
      expect(taskHandoffs.untakenFor('AR-1', 'dev-2')?.id).toBe('hof_1');
      expect(taskHandoffs.untakenFor('AR-1', 'dev-1')).toBeNull();

      // A new handoff may open once the first one ended; the one with a note is found as the latest note.
      const second: TaskHandoffRow = {
        ...row,
        id: 'hof_2',
        from: 'dev-2',
        to: 'dev-1',
        startedAt: '2026-10-05T09:00:00.000Z',
      };
      taskHandoffs.create(second);
      taskHandoffs.save({
        ...second,
        step: 'closing',
        deadlineAt: null,
        outcome: 'note',
        note: 'Over to you.',
        uncommitted: false,
        endedAt: '2026-10-05T09:05:00.000Z',
        takenOverAt: '2026-10-05T09:06:00.000Z',
        takenOverSessionId: 'ses_2',
      });
      expect(taskHandoffs.latestNote('AR-1')).toMatchObject({
        id: 'hof_2',
        note: 'Over to you.',
        uncommitted: false,
      });
      expect(taskHandoffs.latestClosed('AR-1')?.id).toBe('hof_2');
      expect(taskHandoffs.untakenFor('AR-1', 'dev-1')).toBeNull();
    } finally {
      db.close();
    }
  });
});
