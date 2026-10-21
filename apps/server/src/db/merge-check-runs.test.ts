import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepositories, openDatabase } from './index';
import type { MergeCheckRunStart, Repositories } from './index';

const minute = (n: number) => `2026-10-20T10:${String(n).padStart(2, '0')}:00.000Z`;
function start(n: number, patch: Partial<MergeCheckRunStart> = {}): MergeCheckRunStart {
  return {
    id: `mergecheck_${n}`,
    projectKey: 'PM',
    repo: 'projectman',
    kind: 'merge',
    trainId: null,
    taskKeys: [`PM-${n}`],
    commit: 'a'.repeat(40),
    base: 'b'.repeat(40),
    maxWorkers: 4,
    runner: 'engine',
    requestedAt: minute(n),
    ...patch,
  };
}
const end = (status: 'passed' | 'failed', n: number) => ({
  status,
  reason: null,
  durationMs: 1000 * n,
  report: null,
  url: null,
  finishedAt: minute(n + 1),
});

describe('merge check repository (PM-876)', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    for (const key of ['PM', 'OTHER'])
      repos.projects.insert({
        key,
        name: key,
        templateId: 'test',
        configVersion: '1',
        createdAt: minute(0),
        updatedAt: minute(0),
      });
  });
  afterEach(() => repos.db.close());
  const ids = (query: Partial<Parameters<Repositories['mergeCheckRuns']['list']>[0]> = {}) =>
    repos.mergeCheckRuns.list({ projectKey: 'PM', limit: 10, ...query }).runs.map((run) => run.id);

  it('round-trips a run with its ordered cards, queue turn and report, and reads an unparsable report as unknown', () => {
    const report = {
      scope: 'modules' as const,
      workers: 4,
      commandMs: 900,
      steps: [
        {
          index: 0,
          kind: 'typecheck' as const,
          workspace: 'packages/shared',
          result: 'cached' as const,
          durationMs: null,
        },
      ],
    };
    repos.mergeCheckRuns.start(start(1, { kind: 'train', trainId: 'mrg_train', taskKeys: ['PM-3', 'PM-1'] }));
    expect(repos.mergeCheckRuns.get('mergecheck_1')).toMatchObject({
      status: 'running',
      startedAt: null,
      report: null,
    });
    repos.mergeCheckRuns.markStarted('mergecheck_1', minute(2));
    repos.mergeCheckRuns.markStarted('mergecheck_1', minute(5)); // the first turn stays
    repos.mergeCheckRuns.finish('mergecheck_1', { ...end('passed', 1), durationMs: 900, report });
    expect(repos.mergeCheckRuns.get('mergecheck_1')).toEqual({
      ...start(1, { kind: 'train', trainId: 'mrg_train', taskKeys: ['PM-3', 'PM-1'] }),
      status: 'passed',
      reason: null,
      startedAt: minute(2),
      finishedAt: minute(2),
      durationMs: 900,
      report,
      url: null,
    });
    repos.db.prepare('UPDATE merge_check_runs SET report_json = \'{"scope":"nowhere"}\'').run();
    expect(repos.mergeCheckRuns.get('mergecheck_1')?.report).toBeNull();
    expect(repos.mergeCheckRuns.get('mergecheck_unknown')).toBeNull();
  });

  it('keeps the runner a run started with and the GitHub Actions run page it ended with (PM-906)', () => {
    const url = 'https://github.com/o/r/actions/runs/1';
    repos.mergeCheckRuns.start(start(1, { runner: 'github_actions' }));
    repos.mergeCheckRuns.finish('mergecheck_1', { ...end('passed', 1), url });
    repos.mergeCheckRuns.start(start(2));
    expect(repos.mergeCheckRuns.get('mergecheck_1')).toMatchObject({ runner: 'github_actions', url });
    expect(repos.mergeCheckRuns.get('mergecheck_2')).toMatchObject({ runner: 'engine', url: null });
  });

  describe('listing', () => {
    beforeEach(() => {
      repos.mergeCheckRuns.start(start(1));
      repos.mergeCheckRuns.finish('mergecheck_1', end('passed', 1));
      repos.mergeCheckRuns.start(start(2, { kind: 'train', taskKeys: ['PM-1', 'PM-2'] }));
      repos.mergeCheckRuns.finish('mergecheck_2', end('failed', 2));
      repos.mergeCheckRuns.start(start(3, { kind: 'diagnose', taskKeys: ['PM-2'] }));
      repos.mergeCheckRuns.start(start(4, { projectKey: 'OTHER' }));
    });

    it('lists the newest first and only the project', () => {
      expect(ids()).toEqual(['mergecheck_3', 'mergecheck_2', 'mergecheck_1']);
    });

    it('filters by card, outcome (running counts as not passed) and kind', () => {
      expect(ids({ taskKey: 'PM-1' })).toEqual(['mergecheck_2', 'mergecheck_1']);
      expect(ids({ outcome: 'passed' })).toEqual(['mergecheck_1']);
      expect(ids({ outcome: 'not_passed' })).toEqual(['mergecheck_3', 'mergecheck_2']);
      expect(ids({ kinds: ['merge', 'train'] })).toEqual(['mergecheck_2', 'mergecheck_1']);
      expect(ids({ kinds: [] })).toEqual([]);
    });

    it('bounds the period: since inclusive, until exclusive', () => {
      expect(ids({ since: minute(2), until: minute(3) })).toEqual(['mergecheck_2']);
    });

    it('pages with a limit and an offset, and tells whether older runs match', () => {
      expect(repos.mergeCheckRuns.list({ projectKey: 'PM', limit: 2 })).toMatchObject({ hasMore: true });
      expect(ids({ limit: 2 })).toEqual(['mergecheck_3', 'mergecheck_2']);
      expect(repos.mergeCheckRuns.list({ projectKey: 'PM', limit: 2, offset: 2 })).toMatchObject({
        runs: [expect.objectContaining({ id: 'mergecheck_1' })],
        hasMore: false,
      });
    });

    it('marks the runs still running as interrupted, and keeps the finished ones', () => {
      repos.mergeCheckRuns.interruptRunning(minute(30));
      expect(repos.mergeCheckRuns.get('mergecheck_3')).toMatchObject({
        status: 'cancelled',
        reason: 'interrupted',
        finishedAt: minute(30),
      });
      expect(repos.mergeCheckRuns.get('mergecheck_1')?.status).toBe('passed');
    });
  });
});
