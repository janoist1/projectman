import { describe, expect, it } from 'vitest';
import type { WorkflowJobInfo, WorkflowRunInfo, WorkflowStepInfo } from '../contracts';
import { judge, notAcquired } from './github-verdict';

const COMMIT = 'c'.repeat(40);

const run: WorkflowRunInfo = {
  id: 7,
  status: 'completed',
  conclusion: 'failure',
  headSha: COMMIT,
  headBranch: 'pm-check/x/run-1',
  htmlUrl: 'https://github.com/acme/widgets/actions/runs/7',
  createdAt: '2026-11-06T10:00:00Z',
};

const step = (
  name: string,
  conclusion: string | null,
  startedAt: string | null = null,
): WorkflowStepInfo => ({
  name,
  status: conclusion === null ? 'pending' : 'completed',
  conclusion,
  startedAt,
  completedAt: null,
});

const job = (id: number, conclusion: string | null, steps: WorkflowStepInfo[]): WorkflowJobInfo => ({
  id,
  name: `merge-test (${id}/4)`,
  status: 'completed',
  conclusion,
  startedAt: '2026-11-06T10:00:30Z',
  completedAt: '2026-11-06T10:15:30Z',
  runnerId: 100 + id,
  runnerName: `GitHub Actions ${100 + id}`,
  steps,
});

const green = (id: number) =>
  job(id, 'success', [step('checkout', 'success'), step('merge-test', 'success')]);
const red = (id: number) => job(id, 'failure', [step('checkout', 'success'), step('merge-test', 'failure')]);
/**
 * A job as the GitHub REST API lists one that never got a machine, read from the real run 42253831611 of this
 * repository (and 17 more failed since 2026-11-04): `cancelled`, `runner_id` 0, `runner_name` '', no steps at
 * all, and the job's own `started_at` / `completed_at` filled.
 */
const unacquired = (id: number): WorkflowJobInfo => ({
  ...job(id, 'cancelled', []),
  runnerId: 0,
  runnerName: '',
});

describe('notAcquired (PM-1292)', () => {
  it('is true for a job with no runner whose steps never started', () => {
    expect(notAcquired(unacquired(1))).toBe(true);
    expect(notAcquired({ ...unacquired(1), runnerId: null, runnerName: null })).toBe(true);
    expect(notAcquired({ ...unacquired(1), steps: [step('checkout', null), step('merge-test', null)] })).toBe(
      true,
    );
    expect(notAcquired({ ...unacquired(1), steps: [step('merge-test', 'skipped')] })).toBe(true);
  });

  it.each([
    ['it succeeded', { ...unacquired(1), conclusion: 'success' }],
    ['a runner id was assigned', { ...unacquired(1), runnerId: 5 }],
    ['a runner name was assigned', { ...unacquired(1), runnerName: 'GitHub Actions 5' }],
    ['a step started', { ...unacquired(1), steps: [step('checkout', null, '2026-11-06T10:01:00Z')] }],
    ['a step ended', { ...unacquired(1), steps: [step('checkout', 'failure')] }],
  ])('is false when %s', (_name, candidate) => {
    expect(notAcquired(candidate)).toBe(false);
  });
});

describe('judge: a job that got no machine (PM-1292)', () => {
  it('is unacquired when every unsuccessful job got no machine, next to green shards', () => {
    expect(judge(run, COMMIT, [green(1), green(2), green(3), unacquired(4)])).toEqual({
      kind: 'unacquired',
      jobs: ['merge-test (4/4)'],
    });
    expect(judge(run, COMMIT, [green(1), unacquired(2), unacquired(3), unacquired(4)])).toMatchObject({
      kind: 'unacquired',
      jobs: ['merge-test (2/4)', 'merge-test (3/4)', 'merge-test (4/4)'],
    });
  });

  it('is failed when a shard failed in the merge-test step, whatever happened to the others', () => {
    expect(judge(run, COMMIT, [green(1), red(2), unacquired(3), unacquired(4)])).toMatchObject({
      kind: 'failed',
      failed: [{ id: 2 }],
    });
  });

  it('is the plain error when a started job failed before the test step, and not infra', () => {
    const install = job(3, 'failure', [
      step('checkout', 'success', '2026-11-06T10:01:00Z'),
      step('npm ci', 'failure', '2026-11-06T10:01:10Z'),
      step('merge-test', 'skipped'),
    ]);
    expect(judge(run, COMMIT, [green(1), install, unacquired(4)])).toMatchObject({ kind: 'error' });
    expect(judge(run, COMMIT, [green(1), install])).toMatchObject({ kind: 'error' });
  });

  it('is a missing verdict, not unacquired, when the job ran but GitHub gave no test step', () => {
    expect(judge(run, COMMIT, [green(1), job(2, 'success', [])])).toMatchObject({ kind: 'missing' });
  });

  it('leaves the other verdicts alone', () => {
    expect(judge(run, COMMIT, [green(1), green(2)])).toEqual({ kind: 'passed' });
    expect(judge(run, 'd'.repeat(40), [unacquired(1)])).toMatchObject({ kind: 'error' });
    expect(judge(run, COMMIT, [])).toMatchObject({ kind: 'error' });
    expect(judge(run, COMMIT, [green(1), job(2, 'skipped', [])])).toMatchObject({ kind: 'error' });
  });
});
