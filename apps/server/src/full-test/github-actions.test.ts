import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { MERGE_CHECK_WORKFLOW } from '@projectman/shared';
import {
  GithubError,
  type CheckBranchGit,
  type FullTestExecutor,
  type FullTestResult,
  type FullTestSpec,
  type GithubActionsCheck,
  type GithubActionsClient,
  type WorkflowJobInfo,
  type WorkflowRunInfo,
  type WorkflowStepInfo,
} from '../contracts';
import {
  CANCEL_WAIT_MS,
  DISPATCH_RETRIES,
  RUN_APPEAR_MAX_MS,
  STALE_BRANCH_MS,
  STALE_BRANCHES_PER_SWEEP,
  withGithubActions,
} from './github-actions';
import { GITHUB_OUTPUT_TAIL_CHARS } from './github-verdict';

/** The executor against a fake client and a fake branch git; the clock moves only when it sleeps. */

const COMMIT = 'c'.repeat(40);
const REF = { projectKey: 'PM', repo: 'projectman' };
const T0 = 1_800_000_000_000;
const RUN_URL = 'https://github.com/acme/widgets/actions/runs/7';

const check = (over: Partial<GithubActionsCheck> = {}): GithubActionsCheck => ({
  ref: REF,
  mergeId: 'merge-1',
  repo: 'acme/widgets',
  base: 'main',
  commit: COMMIT,
  workflow: MERGE_CHECK_WORKFLOW,
  ...over,
});

const spec = (over: Partial<FullTestSpec> = {}, githubActions: GithubActionsCheck | null = check()) =>
  ({
    runId: 'run-1',
    cwd: '/repo',
    command: '',
    maxWorkers: 1,
    timeoutMs: 600_000,
    sandbox: { denyRead: [], allowRead: [] },
    ...(githubActions ? { githubActions } : {}),
    ...over,
  }) satisfies FullTestSpec;

const run = (over: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo => ({
  id: 7,
  status: 'in_progress',
  conclusion: null,
  headSha: COMMIT,
  headBranch: 'pm-check/x/run-1',
  htmlUrl: RUN_URL,
  createdAt: '2026-10-20T10:00:00Z',
  ...over,
});
const completed = (conclusion: string, over: Partial<WorkflowRunInfo> = {}) =>
  run({ status: 'completed', conclusion, ...over });

const step = (name: string, conclusion: string | null): WorkflowStepInfo => ({
  name,
  status: 'completed',
  conclusion,
  startedAt: null,
  completedAt: null,
});
const job = (
  id: number,
  conclusion: string | null,
  steps: WorkflowStepInfo[],
  name = `shard ${id}`,
): WorkflowJobInfo => ({
  id,
  name,
  status: 'completed',
  conclusion,
  startedAt: null,
  completedAt: null,
  steps,
});
const greenJob = (id = 11) =>
  job(id, 'success', [step('checkout', 'success'), step('merge-test', 'success')]);
const redJob = (id = 12) => job(id, 'failure', [step('checkout', 'success'), step('merge-test', 'failure')]);

interface Setup {
  executor: FullTestExecutor;
  local: FullTestExecutor;
  actions: { [K in keyof GithubActionsClient]: Mock };
  branches: { [K in keyof CheckBranchGit]: Mock };
  logger: { warn: Mock };
  clock: { now(): number; sleeps: number[] };
}

function setup(
  actionsOver: Partial<Setup['actions']> = {},
  branchesOver: Partial<Setup['branches']> = {},
  onSleep?: (ms: number) => void,
): Setup {
  let time = T0;
  const clock = { now: () => time, sleeps: [] as number[] };
  const actions = {
    dispatchWorkflow: vi.fn(async () => {}),
    findDispatchedRun: vi.fn(async () => run()),
    getRun: vi.fn(async () => completed('success')),
    listJobs: vi.fn(async () => [greenJob()]),
    jobLog: vi.fn(async () => ''),
    cancelRun: vi.fn(async () => {}),
    ...actionsOver,
  };
  const branches = {
    upstreamRepo: vi.fn(async () => 'acme/widgets'),
    push: vi.fn(async () => ({ ok: true }) as const),
    remove: vi.fn(async () => {}),
    list: vi.fn(async () => [] as string[]),
    ...branchesOver,
  };
  const local: FullTestExecutor = {
    available: vi.fn(async () => ({ ok: true }) as const),
    run: vi.fn(async (): Promise<FullTestResult> => ({
      outcome: 'passed',
      exitCode: 0,
      durationMs: 1,
      failedFiles: [],
      outputTail: 'local',
    })),
  };
  const logger = { warn: vi.fn() };
  const executor = withGithubActions(local, {
    actions: actions as unknown as GithubActionsClient,
    branches: branches as unknown as CheckBranchGit,
    logger: logger as unknown as FastifyBaseLogger,
    now: clock.now,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      time += ms;
      onSleep?.(ms);
    },
  });
  return { executor, local, actions, branches, logger, clock };
}

const runIt = (
  s: Setup,
  over: { spec?: FullTestSpec; signal?: AbortSignal; onStarted?: () => void } = {},
): Promise<FullTestResult> =>
  s.executor.run(over.spec ?? spec(), over.signal ?? new AbortController().signal, over.onStarted);

const branchOf = (s: Setup): string => (s.branches.push.mock.calls[0]?.[1] as { branch: string }).branch;

describe('withGithubActions', () => {
  it('hands a request without a GitHub check to the local executor, and asks it whether it is available', async () => {
    const s = setup();
    const request = spec({}, null);
    await runIt(s, { spec: request });
    expect(s.local.run).toHaveBeenCalledWith(request, expect.anything(), undefined, undefined);
    await s.executor.available();
    expect(s.local.available).toHaveBeenCalledOnce();
    expect(s.branches.push).not.toHaveBeenCalled();
  });

  it('pushes the commit to a check branch, dispatches the workflow on it and removes the branch', async () => {
    const s = setup({}, {}, undefined);
    const started = vi.fn();
    const result = await runIt(s, { onStarted: started, spec: spec({}, check({ files: ['a.test.ts'] })) });

    expect(result).toMatchObject({ outcome: 'passed', exitCode: 0, externalUrl: RUN_URL });
    expect(s.local.run).not.toHaveBeenCalled();
    const branch = branchOf(s);
    expect(branch).toBe(`pm-check/${T0.toString(36)}/run-1`);
    expect(s.branches.push).toHaveBeenCalledWith(REF, { base: 'main', commit: COMMIT, branch });
    expect(s.actions.dispatchWorkflow).toHaveBeenCalledWith(
      'acme/widgets',
      MERGE_CHECK_WORKFLOW,
      { ref: branch, inputs: { check_id: 'run-1', files: JSON.stringify(['a.test.ts']) } },
      expect.anything(),
    );
    expect(s.branches.remove).toHaveBeenLastCalledWith(REF, { base: 'main', branch });
    expect(started).toHaveBeenCalledOnce();
  });

  it('keeps the run page as the first line and the flaky markers of every shard in a passed result', async () => {
    const logs: Record<number, string> = {
      11: '2026-10-20T10:00:00.123Z merge-test flaky: src/a.test.ts\n2026-10-20T10:00:01Z ok\n',
      12: '﻿2026-10-20T10:00:00Z merge-test flaky: src/a.test.ts\nmerge-test flaky: src/b.test.ts\n',
    };
    const s = setup({
      listJobs: vi.fn(async () => [greenJob(11), greenJob(12)]),
      jobLog: vi.fn(async (_repo: string, id: number) => logs[id] ?? ''),
    });
    const result = await runIt(s);
    expect(result.outputTail).toBe(
      `GitHub Actions: ${RUN_URL}\nmerge-test flaky: src/a.test.ts\nmerge-test flaky: src/b.test.ts`,
    );
  });

  it('is failed with the marked files and the failure report when the merge-test step failed', async () => {
    const s = setup({
      listJobs: vi.fn(async () => [greenJob(11), redJob(12)]),
      jobLog: vi.fn(async (_repo: string, id: number) =>
        id === 12
          ? '2026-10-20T10:00:00Z merge-test failed: src/a.test.ts\n2026-10-20T10:00:01Z  FAIL  src/a.test.ts > adds\nAssertionError: boom\n'
          : '',
      ),
    });
    const result = await runIt(s);
    expect(result).toMatchObject({
      outcome: 'failed',
      exitCode: 1,
      failedFiles: ['src/a.test.ts'],
      externalUrl: RUN_URL,
    });
    expect(result.outputTail.split('\n')[0]).toBe(`GitHub Actions: ${RUN_URL}`);
    expect(result.outputTail).toContain('--- shard 12 ---');
    expect(result.outputTail).toContain('AssertionError: boom');
    expect(result.outputTail).not.toContain('T10:00:01Z');
    expect(result.outputTail.length).toBeLessThanOrEqual(GITHUB_OUTPUT_TAIL_CHARS);
  });

  it.each([
    [
      'a job failed before the test step',
      completed('failure'),
      [job(11, 'failure', [step('checkout', 'failure'), step('merge-test', 'skipped')])],
    ],
    ['a job was skipped', completed('success'), [greenJob(11), job(12, 'skipped', [])]],
    [
      'a job has no merge-test step',
      completed('success'),
      [job(11, 'success', [step('checkout', 'success')])],
    ],
    ['the run has no jobs', completed('success'), []],
    ['the run checked another commit', completed('success', { headSha: 'd'.repeat(40) }), [greenJob()]],
    [
      'the run was cancelled',
      completed('cancelled'),
      [job(11, 'cancelled', [step('merge-test', 'cancelled')])],
    ],
  ])('is a run error when %s', async (_name, finished, jobs) => {
    const s = setup({ getRun: vi.fn(async () => finished), listJobs: vi.fn(async () => jobs) });
    const result = await runIt(s);
    expect(result).toMatchObject({ outcome: 'error', reason: 'github_run_error', externalUrl: RUN_URL });
    expect(s.branches.remove).toHaveBeenCalled();
  });

  it('is a timeout when a job timed out on GitHub', async () => {
    const s = setup({
      getRun: vi.fn(async () => completed('failure')),
      listJobs: vi.fn(async () => [job(11, 'timed_out', [step('merge-test', 'cancelled')])]),
    });
    await expect(runIt(s)).resolves.toMatchObject({ outcome: 'error', reason: 'timeout' });
  });

  it('cancels the run and ends as a timeout when it does not finish within the limit', async () => {
    const s = setup({ getRun: vi.fn(async () => run()) });
    const result = await runIt(s, { spec: spec({ timeoutMs: 60_000 }) });
    expect(result).toMatchObject({ outcome: 'error', reason: 'timeout', externalUrl: RUN_URL });
    expect(s.actions.cancelRun).toHaveBeenCalledWith('acme/widgets', 7, expect.anything());
    expect(s.clock.now() - T0).toBeLessThanOrEqual(60_000 + 10_000);
    expect(s.branches.remove).toHaveBeenCalled();
  });

  it('cancels the run and ends as killed when the signal aborts, and still removes the branch', async () => {
    const controller = new AbortController();
    const s = setup({ getRun: vi.fn(async () => run()) }, {}, () => controller.abort());
    const result = await runIt(s, { signal: controller.signal });
    expect(result).toMatchObject({ outcome: 'error', reason: 'killed' });
    expect(s.actions.cancelRun).toHaveBeenCalledOnce();
    expect(s.branches.remove).toHaveBeenCalledWith(REF, { base: 'main', branch: branchOf(s) });
  });

  it('gives up cancelling after a while and never lets the cancel fail the result', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const s = setup(
        {
          getRun: vi.fn(async () => run()),
          cancelRun: vi.fn(
            (_repo: string, _id: number, signal?: AbortSignal) =>
              new Promise<void>((_resolve, reject) =>
                signal?.addEventListener('abort', () => reject(new GithubError('aborted', 'aborted'))),
              ),
          ),
        },
        {},
        () => controller.abort(),
      );
      const pending = runIt(s, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(CANCEL_WAIT_MS + 1);
      await expect(pending).resolves.toMatchObject({ reason: 'killed' });
      expect(s.logger.warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is unavailable when the dispatched run never appears, and cancels nothing', async () => {
    const s = setup({ findDispatchedRun: vi.fn(async () => null) });
    const result = await runIt(s);
    expect(result).toMatchObject({ outcome: 'error', reason: 'github_unavailable' });
    expect(result.externalUrl).toBeUndefined();
    expect(s.clock.now() - T0).toBeGreaterThanOrEqual(RUN_APPEAR_MAX_MS);
    expect(s.actions.cancelRun).not.toHaveBeenCalled();
    expect(s.branches.remove).toHaveBeenCalled();
  });

  it.each([
    ['another repository', vi.fn(async () => 'other/repo')],
    ['not a github.com repository', vi.fn(async () => null)],
  ])('pushes nothing when the upstream remote is %s', async (_name, upstreamRepo) => {
    const s = setup({}, { upstreamRepo });
    await expect(runIt(s)).resolves.toMatchObject({ outcome: 'error', reason: 'github_unavailable' });
    expect(s.branches.push).not.toHaveBeenCalled();
    expect(s.actions.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('is unavailable when the push is refused, and dispatches nothing', async () => {
    const s = setup(
      {},
      { push: vi.fn(async () => ({ ok: false, reason: 'rejected', message: 'denied' }) as const) },
    );
    const result = await runIt(s);
    expect(result).toMatchObject({ outcome: 'error', reason: 'github_unavailable' });
    expect(result.outputTail).toContain('denied');
    expect(s.actions.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('tries a temporary dispatch failure again, but not a permanent one', async () => {
    const temporary = new GithubError('rate_limited', 'slow down');
    const flaky = setup({
      dispatchWorkflow: vi
        .fn()
        .mockRejectedValueOnce(temporary)
        .mockRejectedValueOnce(temporary)
        .mockResolvedValue(undefined),
    });
    await expect(runIt(flaky)).resolves.toMatchObject({ outcome: 'passed' });
    expect(flaky.actions.dispatchWorkflow).toHaveBeenCalledTimes(3);

    const denied = setup({
      dispatchWorkflow: vi.fn().mockRejectedValue(new GithubError('not_authenticated', 'log in')),
    });
    await expect(runIt(denied)).resolves.toMatchObject({ reason: 'github_unavailable' });
    expect(denied.actions.dispatchWorkflow).toHaveBeenCalledTimes(1);

    const always = setup({ dispatchWorkflow: vi.fn().mockRejectedValue(temporary) });
    await expect(runIt(always)).resolves.toMatchObject({ reason: 'github_unavailable' });
    expect(always.actions.dispatchWorkflow).toHaveBeenCalledTimes(DISPATCH_RETRIES + 1);
    expect(always.branches.remove).toHaveBeenCalled();
  });

  it('waits for the logs of a finished run that GitHub does not have yet', async () => {
    const s = setup({
      jobLog: vi
        .fn()
        .mockRejectedValueOnce(new GithubError('not_found', 'no log yet'))
        .mockResolvedValue('merge-test flaky: src/a.test.ts\n'),
    });
    const result = await runIt(s);
    expect(result.outcome).toBe('passed');
    expect(result.outputTail).toContain('merge-test flaky: src/a.test.ts');
  });

  it('keeps following the run through a failed read', async () => {
    const s = setup({
      findDispatchedRun: vi.fn(async () => run()),
      getRun: vi
        .fn()
        .mockRejectedValueOnce(new GithubError('unreachable', 'offline'))
        .mockResolvedValue(completed('success')),
    });
    await expect(runIt(s)).resolves.toMatchObject({ outcome: 'passed' });
    expect(s.logger.warn).toHaveBeenCalled();
  });

  it('refuses a request that cannot be a check before it calls anything', async () => {
    const s = setup();
    const result = await runIt(s, { spec: spec({}, check({ workflow: 'other.yml' })) });
    expect(result).toMatchObject({ outcome: 'error', reason: 'github_run_error' });
    const unsafe = await runIt(s, { spec: spec({ runId: '../x' }) });
    expect(unsafe).toMatchObject({ outcome: 'error', reason: 'github_run_error' });
    expect(s.branches.upstreamRepo).not.toHaveBeenCalled();
  });

  it('survives a branch that cannot be removed', async () => {
    const s = setup({}, { remove: vi.fn(async () => Promise.reject(new Error('offline'))) });
    await expect(runIt(s)).resolves.toMatchObject({ outcome: 'passed' });
    expect(s.logger.warn).toHaveBeenCalled();
  });

  it('removes only the stale check branches of other runs, a few at a time', async () => {
    const stamp = (ageMs: number) => (T0 - ageMs).toString(36);
    const stale = Array.from(
      { length: STALE_BRANCHES_PER_SWEEP + 2 },
      (_, i) => `pm-check/${stamp(STALE_BRANCH_MS + 60_000 * (i + 1))}/old-${i}`,
    );
    const fresh = `pm-check/${stamp(60_000)}/fresh`;
    const s = setup({}, { list: vi.fn(async () => [fresh, ...stale, 'pm-check/!!/bad']) });
    await runIt(s);
    const removed = s.branches.remove.mock.calls.map(([, input]) => (input as { branch: string }).branch);
    expect(removed).toEqual([...stale.slice(0, STALE_BRANCHES_PER_SWEEP), branchOf(s)]);
    expect(removed).not.toContain(fresh);
  });
});
