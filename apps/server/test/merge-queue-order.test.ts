import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, migrations, schemaVersion } from '../src/db';
import type { MergeRecord } from '../src/db';

const at = '2026-10-17T12:00:00.000Z';
function row(taskKey: string, extra: Partial<MergeRecord> = {}): MergeRecord {
  return {
    id: `merge_${taskKey}`,
    taskKey,
    projectKey: 'AR',
    repo: 'web',
    base: 'main',
    fromStageId: 'review',
    toStageId: 'done',
    merger: 'owner',
    requestedAt: at,
    state: 'queued',
    landed: 'nowhere',
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

describe('repository merge queue compare-and-swap', () => {
  it('keeps queue rank and priority for retries and system requeues; a person-driven requeue goes to the tail', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      const { taskMerges: queue } = createRepositories(db);
      queue.save(row('AR-1'));
      queue.save(row('AR-2'));
      const order = queue.queueOrder('AR', 'web');
      queue.orderQueue('AR', 'web', order.revision, ['AR-2', 'AR-1'], { taskKey: 'AR-2', at });
      const retrying = queue.get('merge_AR-2')!;
      queue.save({ ...retrying, state: 'running' });
      const retry = {
        attempt: 2,
        at,
        cause: 'verdict_missing' as const,
        runner: 'github_actions' as const,
        lastRunId: 'run',
      };
      queue.save({ ...retrying, state: 'queued', retry });
      expect(queue.queueOrder('AR', 'web').taskKeys).toEqual(['AR-2', 'AR-1']);
      expect(queue.get(retrying.id)).toMatchObject({ retry, prioritizedAt: at, queueRank: 0 });
      queue.save({ ...retrying, state: 'running' });
      queue.save({ ...retrying, state: 'queued' });
      // A system requeue of a running merge keeps its place.
      expect(queue.queueOrder('AR', 'web').taskKeys).toEqual(['AR-2', 'AR-1']);
      queue.save({ ...retrying, state: 'failed' });
      queue.save({ ...retrying, state: 'queued' });
      expect(queue.queueOrder('AR', 'web').taskKeys).toEqual(['AR-1', 'AR-2']);
    } finally {
      db.close();
    }
  });

  it.each(['merged', 'failed', 'blocked', 'cancelled'] as const)(
    'clears retry state when the row becomes %s',
    (state) => {
      const db = new Database(':memory:');
      try {
        migrate(db);
        const { taskMerges: queue } = createRepositories(db);
        const retry = {
          attempt: 2,
          at,
          cause: 'verdict_missing' as const,
          runner: 'github_actions' as const,
          lastRunId: 'run',
        };
        queue.save(row('AR-1', { retry }));
        queue.save({ ...queue.get('merge_AR-1')!, state });
        expect(queue.get('merge_AR-1')?.retry).toBeUndefined();
      } finally {
        db.close();
      }
    },
  );

  it.each([79, 80, 81])('preserves old queue order and starts revision at zero from schema %i', (version) => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version <= version)) db.exec(migration.sql);
      db.pragma(`user_version = ${version}`);
      db.prepare(
        `INSERT INTO task_merges (id, project_key, task_key, repo, base, from_stage_id, to_stage_id,
        merger, requested_at, state, landed, created_at, updated_at) VALUES ('old', 'AR', 'AR-1', 'web',
        'main', 'review', 'done', 'owner', ?, 'queued', 'nowhere', ?, ?)`,
      ).run(at, at, at);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.taskMerges.queueOrder('AR', 'web')).toEqual({ revision: 0, taskKeys: ['AR-1'] });
      expect(repos.taskMerges.get('old')).not.toHaveProperty('queueRank');
      migrate(db);
      expect(repos.taskMerges.queueOrder('AR', 'web').revision).toBe(0);
    } finally {
      db.close();
    }
  });

  it('announces queue changes through merge records and rolls the journal back with the queue', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      const { taskMerges: queue, projectChanges: journal } = createRepositories(db);
      queue.save(row('AR-1'));
      queue.save(row('AR-2'));
      const before = queue.queueOrder('AR', 'web');
      const cursor = journal.head('AR');
      expect(() =>
        db.transaction(() => {
          queue.orderQueue('AR', 'web', before.revision, ['AR-2', 'AR-1']);
          throw new Error('Roll back queue and journal');
        })(),
      ).toThrow('Roll back queue and journal');
      expect(queue.queueOrder('AR', 'web')).toEqual(before);
      expect(journal.list('AR', cursor, 100)).toEqual([]);
      const ordered = queue.orderQueue('AR', 'web', before.revision, ['AR-2', 'AR-1'])!;
      expect(journal.list('AR', cursor, 100).map(({ kind, entityId }) => ({ kind, entityId }))).toEqual([
        { kind: 'operation', entityId: 'merge_AR-2' },
        { kind: 'operation', entityId: 'merge_AR-1' },
      ]);
      const after = journal.head('AR');
      queue.orderQueue('AR', 'web', ordered.revision, ordered.taskKeys);
      expect(queue.orderQueue('AR', 'web', before.revision, before.taskKeys)).toBeNull();
      expect(journal.list('AR', after, 100)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('accepts a complete permutation once and refuses stale, duplicate, missing and foreign cards atomically', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      const { taskMerges: queue } = createRepositories(db);
      queue.save(row('AR-1'));
      queue.save(row('AR-2'));
      queue.save(row('AR-3', { state: 'running' }));
      queue.save(row('AR-4', { repo: 'api' }));
      queue.save(row('BR-1', { projectKey: 'BR' }));
      const first = queue.queueOrder('AR', 'web');
      const staleQueued = queue.get('merge_AR-1')!;
      expect(first).toEqual({ revision: 2, taskKeys: ['AR-1', 'AR-2'] });
      for (const keys of [['AR-1'], ['AR-1', 'AR-1'], ['AR-1', 'AR-3'], ['AR-1', 'AR-4'], ['AR-1', 'BR-1']]) {
        expect(queue.orderQueue('AR', 'web', first.revision, keys)).toBeNull();
        expect(queue.queueOrder('AR', 'web')).toEqual(first);
      }
      const running = queue.get('merge_AR-3');
      const ordered = queue.orderQueue('AR', 'web', first.revision, ['AR-2', 'AR-1']);
      expect(ordered).toEqual({ revision: 3, taskKeys: ['AR-2', 'AR-1'] });
      queue.save(staleQueued);
      expect(queue.queueOrder('AR', 'web')).toEqual(ordered);
      expect(queue.orderQueue('AR', 'web', first.revision, ['AR-1', 'AR-2'])).toBeNull();
      expect(queue.get('merge_AR-3')).toEqual(running);
      expect(queue.queueOrder('AR', 'api')).toEqual({ revision: 1, taskKeys: ['AR-4'] });
      expect(queue.queueOrder('BR', 'web')).toEqual({ revision: 1, taskKeys: ['BR-1'] });
      queue.save(row('AR-5'));
      expect(queue.queueOrder('AR', 'web')).toEqual({ revision: 4, taskKeys: ['AR-2', 'AR-1', 'AR-5'] });
      queue.save({ ...queue.get('merge_AR-2')!, state: 'running' });
      expect(queue.queueOrder('AR', 'web')).toEqual({ revision: 5, taskKeys: ['AR-1', 'AR-5'] });
      const snapshot = queue.queueOrder('AR', 'web');
      expect(queue.orderQueue('AR', 'web', snapshot.revision, snapshot.taskKeys)).toEqual(snapshot);
      expect(
        queue.orderQueue('AR', 'web', snapshot.revision, ['AR-5', 'AR-1'], { taskKey: 'AR-5', at }),
      ).toEqual({ revision: 6, taskKeys: ['AR-5', 'AR-1'] });
    } finally {
      db.close();
    }
  });
});
