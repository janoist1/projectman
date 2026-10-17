import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, migrate, migrations } from '../src/db';
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
  it('preserves old queue order and starts the migrated revision at zero', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version < 80)) db.exec(migration.sql);
      db.pragma('user_version = 79');
      db.prepare(
        `INSERT INTO task_merges (id, project_key, task_key, repo, base, from_stage_id, to_stage_id,
        merger, requested_at, state, landed, created_at, updated_at) VALUES ('old', 'AR', 'AR-1', 'web',
        'main', 'review', 'done', 'owner', ?, 'queued', 'nowhere', ?, ?)`,
      ).run(at, at, at);
      migrate(db);
      const repos = createRepositories(db);
      expect(repos.taskMerges.queueOrder('AR', 'web')).toEqual({ revision: 0, taskKeys: ['AR-1'] });
      expect(repos.taskMerges.get('old')).not.toHaveProperty('queueRank');
      migrate(db);
      expect(repos.taskMerges.queueOrder('AR', 'web').revision).toBe(0);
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
