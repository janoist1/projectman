import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, latestSchemaVersion, migrate, schemaVersion } from '../src/db';

describe('full-tests baseline schema', () => {
  it('preserves stored rows when reopened and supports repository writes', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(`INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at) VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'code_review', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);
      const tables = () =>
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name)
          .sort();

      expect(migrate(db)).toBe(latestSchemaVersion());
      expect(schemaVersion(db)).toBe(latestSchemaVersion());
      expect(tables()).toContain('full_test_runs');
      const repos = createRepositories(db);
      // Nothing is inferred from what was there: no card gets a run.
      expect(repos.fullTestRuns.list('queued')).toEqual([]);
      expect(repos.fullTestRuns.forTask('AR-1')).toEqual([]);
      expect(repos.tasks.get('AR-1')).toMatchObject({ key: 'AR-1', stageId: 'code_review' });

      repos.fullTestRuns.queue({
        id: 'ftr_1',
        projectKey: 'AR',
        taskKey: 'AR-1',
        repo: 'web',
        branch: 'task/AR-1',
        commit: 'c1',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      repos.fullTestRuns.start('ftr_1', '2026-01-02T00:00:01.000Z');
      repos.fullTestRuns.finish('ftr_1', {
        status: 'failed',
        exitCode: 1,
        failedFiles: ['a.test.ts'],
        durationMs: 5,
        finishedAt: '2026-01-02T00:00:02.000Z',
      });
      // A second run applies nothing and keeps what was stored.
      expect(migrate(db)).toBe(latestSchemaVersion());
      expect(repos.fullTestRuns.get('ftr_1')).toMatchObject({
        status: 'failed',
        commit: 'c1',
        failedFiles: ['a.test.ts'],
        exitCode: 1,
      });
    } finally {
      db.close();
    }
  });

  it('defaults to engine results and stores the runner and run page of GitHub results', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(`INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at) VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'code_review', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');
        INSERT INTO full_test_runs (id, project_key, task_key, repo, branch, commit_sha, status, created_at)
        VALUES ('old', 'AR', 'AR-1', 'web', 'task/AR-1', 'c1', 'passed', '2026-01-02T00:00:00.000Z');`);
      expect(migrate(db)).toBe(latestSchemaVersion());
      const repos = createRepositories(db);
      expect(repos.fullTestRuns.get('old')).toMatchObject({ runner: 'engine', externalUrl: null });

      repos.fullTestRuns.queue({
        id: 'gh',
        projectKey: 'AR',
        taskKey: 'AR-1',
        repo: 'web',
        branch: 'task/AR-1',
        commit: 'c1',
        runner: 'github_actions',
        createdAt: '2026-01-03T00:00:00.000Z',
      });
      repos.fullTestRuns.finish('gh', {
        status: 'passed',
        externalUrl: 'https://github.com/acme/web/actions/runs/7',
        finishedAt: '2026-01-03T00:01:00.000Z',
      });
      expect(repos.fullTestRuns.get('gh')).toMatchObject({
        runner: 'github_actions',
        externalUrl: 'https://github.com/acme/web/actions/runs/7',
      });

      // The runner filter picks the runs before the earlier verdict is chosen: the older engine pass of the
      // same commit is no GitHub Actions result, and the GitHub pass is no engine result.
      const pin = { taskKey: 'AR-1', commit: 'c1', pinnedAt: '2026-01-04T00:00:00.000Z' };
      expect(repos.fullTestRuns.forPin(pin).map((run) => run.id)).toEqual(['gh']);
      expect(repos.fullTestRuns.forPin(pin, { runner: 'engine' }).map((run) => run.id)).toEqual(['old']);
      expect(repos.fullTestRuns.forPin(pin, { runner: 'github_actions' }).map((run) => run.id)).toEqual([
        'gh',
      ]);
    } finally {
      db.close();
    }
  });

  it('finds the runs of a pin: its commit, made since it was pinned', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(`INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at) VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
        VALUES ('tsk_example', 'AR', 'AR-1', 1, 'Example task', 'An example', 'code_review', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01');`);
      const repos = createRepositories(db);
      const queue = (id: string, commit: string, createdAt: string) =>
        repos.fullTestRuns.queue({
          id,
          projectKey: 'AR',
          taskKey: 'AR-1',
          repo: 'web',
          branch: 'task/AR-1',
          commit,
          createdAt,
        });
      queue('before', 'c1', '2026-01-02T00:00:00.000Z');
      queue('other', 'c2', '2026-01-03T00:00:00.000Z');
      queue('after', 'c1', '2026-01-04T00:00:00.000Z');
      const pin = { taskKey: 'AR-1', commit: 'c1', pinnedAt: '2026-01-03T12:00:00.000Z' };
      expect(repos.fullTestRuns.forPin(pin).map((run) => run.id)).toEqual(['after']);
      repos.fullTestRuns.finish('before', { status: 'passed', finishedAt: '2026-01-02T00:01:00.000Z' });
      expect(repos.fullTestRuns.forPin(pin).map((run) => run.id)).toEqual(['after', 'before']);
      queue('cancelled', 'c1', '2026-01-03T00:00:00.000Z');
      repos.fullTestRuns.finish('cancelled', {
        status: 'cancelled',
        reason: 'interrupted',
        finishedAt: '2026-01-03T00:01:00.000Z',
      });
      expect(repos.fullTestRuns.forPin(pin).map((run) => run.id)).toEqual(['after', 'before']);
      for (const status of ['failed', 'error'] as const) {
        queue(status, 'c1', '2026-01-03T01:00:00.000Z');
        repos.fullTestRuns.finish(status, { status, finishedAt: '2026-01-03T01:01:00.000Z' });
        expect(repos.fullTestRuns.forPin(pin).map((run) => run.id)).toEqual(['after']);
      }
      queue('at-pin', 'c1', pin.pinnedAt);
      expect(repos.fullTestRuns.forPin(pin).map((run) => run.id)).toEqual(['after', 'at-pin']);
    } finally {
      db.close();
    }
  });
});
