import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { COMPUTE_JOB_WORKFLOW, computeJobRunTitle } from '@projectman/shared';
import type {
  CheckBranchGit,
  FullTestExecutor,
  FullTestResult,
  FullTestSpec,
  GithubActionsClient,
  GithubJobRun,
  WorkflowJobInfo,
  WorkflowRunInfo,
} from '../contracts';
import { RUN_APPEAR_MAX_MS } from './github-actions';
import { parseJobOutputs, withGithubJob } from './github-job';

/** The job executor against a fake client and a fake branch git; the clock moves only when it sleeps. */

const COMMIT = 'c'.repeat(40);
const SHA = 'a'.repeat(64);
const REF = { projectKey: 'PM', repo: 'projectman' };
const T0 = 1_800_000_000_000;
const RUN_URL = 'https://github.com/acme/widgets/actions/runs/9';
const TITLE = computeJobRunTitle('cloud-image', COMMIT, 'job-1');

const jobRun = (over: Partial<GithubJobRun> = {}): GithubJobRun => ({
  ref: REF,
  repo: 'acme/widgets',
  base: 'main',
  workflow: COMPUTE_JOB_WORKFLOW,
  job: 'cloud-image',
  commit: COMMIT,
  command: 'npm run build',
  runsOn: 'ubuntu-24.04-arm',
  outputs: ['image.tar', 'sub/meta.json'],
  node: '24',
  timeoutMinutes: 30,
  ...over,
});

const spec = (githubJob: GithubJobRun = jobRun(), over: Partial<FullTestSpec> = {}): FullTestSpec => ({
  runId: 'job-1',
  cwd: 'github-job:acme/widgets',
  command: githubJob.command,
  maxWorkers: 1,
  timeoutMs: 3_600_000,
  sandbox: { denyRead: [], allowRead: [] },
  githubJob,
  ...over,
});

const run = (over: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo => ({
  id: 9,
  status: 'in_progress',
  conclusion: null,
  headSha: 'd'.repeat(40),
  headBranch: 'main',
  htmlUrl: RUN_URL,
  createdAt: '2026-10-30T10:00:00Z',
  runStartedAt: '2026-10-30T10:00:42Z',
  ...over,
});
const completed = (conclusion: string) => run({ status: 'completed', conclusion });

const jobInfo = (conclusion: string): WorkflowJobInfo => ({
  id: 21,
  name: 'cloud-image (ubuntu-24.04-arm)',
  status: 'completed',
  conclusion,
  startedAt: null,
  completedAt: null,
  steps: [],
});

const OUTPUT_LOG = [
  '2026-10-30T10:05:00.0000000Z building',
  `2026-10-30T10:05:01.0000000Z projectman-job output image.tar ${SHA} 1048576`,
  `2026-10-30T10:05:01.0000000Z projectman-job output sub/meta.json ${'b'.repeat(64)} 120`,
].join('\n');

interface Setup {
  executor: FullTestExecutor;
  inner: FullTestExecutor;
  actions: { [K in keyof GithubActionsClient]: Mock };
  branches: { [K in keyof CheckBranchGit]: Mock };
}

function setup(actionsOver: Partial<Setup['actions']> = {}, onSleep?: (ms: number) => void): Setup {
  let time = T0;
  const actions = {
    dispatchWorkflow: vi.fn(async () => {}),
    findDispatchedRun: vi.fn(async () => null),
    // The first look finds no earlier run of the id; then the dispatched one.
    findRunByTitle: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(run()),
    getRun: vi.fn(async () => completed('success')),
    listArtifacts: vi.fn(async () => [
      { name: 'projectman-job-job-1', expired: false, expiresAt: '2026-11-06T10:00:00Z', sizeBytes: 5 },
    ]),
    runTiming: vi.fn(async () => ({ runDurationMs: 300_000, billableMs: 600_000 })),
    listJobs: vi.fn(async () => [jobInfo('success')]),
    jobLog: vi.fn(async () => OUTPUT_LOG),
    cancelRun: vi.fn(async () => {}),
    ...actionsOver,
  };
  const branches = {
    upstreamRepo: vi.fn(async () => 'acme/widgets'),
    push: vi.fn(async () => ({ ok: true }) as const),
    remove: vi.fn(async () => {}),
    list: vi.fn(async () => [] as string[]),
  };
  const inner: FullTestExecutor = {
    available: vi.fn(async () => ({ ok: true }) as const),
    run: vi.fn(async (): Promise<FullTestResult> => ({
      outcome: 'passed',
      exitCode: 0,
      durationMs: 1,
      failedFiles: [],
      outputTail: 'inner',
    })),
  };
  const executor = withGithubJob(inner, {
    actions: actions as unknown as GithubActionsClient,
    branches: branches as unknown as CheckBranchGit,
    logger: { warn: vi.fn() } as unknown as FastifyBaseLogger,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
      onSleep?.(ms);
    },
  });
  return { executor, inner, actions, branches };
}

const runIt = (executor: FullTestExecutor, request: FullTestSpec, signal = new AbortController().signal) =>
  executor.run(request, signal);

describe('withGithubJob', () => {
  it('dispatches the workflow from the base and gives the outputs, the artifact and the cost', async () => {
    const { executor, actions } = setup();
    const result = await runIt(executor, spec());

    expect(actions.dispatchWorkflow).toHaveBeenCalledWith(
      'acme/widgets',
      COMPUTE_JOB_WORKFLOW,
      {
        ref: 'main',
        inputs: {
          job: 'cloud-image',
          run_id: 'job-1',
          commit: COMMIT,
          command: 'npm run build',
          runs_on: 'ubuntu-24.04-arm',
          outputs: 'image.tar sub/meta.json',
          timeout_minutes: '30',
          node: '24',
        },
      },
      expect.anything(),
    );
    expect(actions.findRunByTitle).toHaveBeenLastCalledWith(
      'acme/widgets',
      COMPUTE_JOB_WORKFLOW,
      { branch: 'main', displayTitle: TITLE },
      expect.anything(),
    );
    expect(result).toMatchObject({
      outcome: 'passed',
      exitCode: 0,
      externalUrl: RUN_URL,
      outputs: [
        { path: 'image.tar', sha256: SHA, bytes: 1_048_576 },
        { path: 'sub/meta.json', sha256: 'b'.repeat(64), bytes: 120 },
      ],
      artifact: { name: 'projectman-job-job-1', expiresAt: '2026-11-06T10:00:00Z' },
      cost: { queuedMs: 42_000, billableMs: 600_000 },
    });
  });

  it('ends a failed job as failed, with the end of its log', async () => {
    const { executor } = setup({
      getRun: vi.fn(async () => completed('failure')),
      jobLog: vi.fn(async () => '2026-10-30T10:05:00.0000000Z compile error in main.c'),
      listJobs: vi.fn(async () => [jobInfo('failure')]),
    });
    const result = await runIt(executor, spec());

    expect(result).toMatchObject({ outcome: 'failed', exitCode: 1, externalUrl: RUN_URL });
    expect(result.outputTail).toContain('compile error in main.c');
    expect(result.outputs).toBeUndefined();
    expect(result.cost).toBeDefined();
  });

  it('cancels the run when the request is stopped', async () => {
    const controller = new AbortController();
    const { executor, actions } = setup({ getRun: vi.fn(async () => run()) }, () => controller.abort());
    const result = await runIt(executor, spec(), controller.signal);

    expect(actions.cancelRun).toHaveBeenCalledWith('acme/widgets', 9, expect.anything());
    expect(result).toMatchObject({ outcome: 'error', reason: 'killed' });
  });

  it('is an error when the dispatched run does not appear', async () => {
    const sleeps: number[] = [];
    const { executor, actions } = setup({ findRunByTitle: vi.fn(async () => null) }, (ms) => sleeps.push(ms));
    const result = await runIt(executor, spec());

    expect(result).toMatchObject({ outcome: 'error', reason: 'github_unavailable' });
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(RUN_APPEAR_MAX_MS);
    expect(actions.dispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(actions.cancelRun).not.toHaveBeenCalled();
  });

  it('is an error when GitHub cancelled the run', async () => {
    const { executor } = setup({ getRun: vi.fn(async () => completed('cancelled')) });
    expect(await runIt(executor, spec())).toMatchObject({ outcome: 'error', reason: 'killed' });
  });

  it('is an error when the run reports no digest for a declared output', async () => {
    const { executor } = setup({ jobLog: vi.fn(async () => 'nothing printed') });
    expect(await runIt(executor, spec())).toMatchObject({ outcome: 'error', reason: 'github_run_error' });
  });

  it('refuses a run id that already has a run, without dispatching', async () => {
    const { executor, actions } = setup({ findRunByTitle: vi.fn(async () => completed('success')) });
    const result = await runIt(executor, spec());

    expect(result).toMatchObject({ outcome: 'error', reason: 'github_run_error' });
    expect(actions.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an invalid descriptor without dispatching', async () => {
    const { executor, actions, branches } = setup();
    const result = await runIt(executor, spec(jobRun({ workflow: 'merge-check.yml' })));

    expect(result).toMatchObject({ outcome: 'error', reason: 'github_run_error' });
    expect(actions.findRunByTitle).not.toHaveBeenCalled();
    expect(actions.dispatchWorkflow).not.toHaveBeenCalled();
    expect(branches.upstreamRepo).not.toHaveBeenCalled();
  });

  it('dispatches a dedicated workflow like the general one (PM-1196)', async () => {
    const { executor, actions } = setup();
    const result = await runIt(executor, spec(jobRun({ workflow: 'projectman-deploy.yml' })));

    expect(result).toMatchObject({ outcome: 'passed', artifact: { name: 'projectman-job-job-1' } });
    expect(actions.dispatchWorkflow).toHaveBeenCalledWith(
      'acme/widgets',
      'projectman-deploy.yml',
      expect.anything(),
      expect.anything(),
    );
    expect(actions.findRunByTitle).toHaveBeenLastCalledWith(
      'acme/widgets',
      'projectman-deploy.yml',
      { branch: 'main', displayTitle: TITLE },
      expect.anything(),
    );
  });

  it('refuses a repository whose upstream is another one, without dispatching', async () => {
    const { executor, actions, branches } = setup();
    branches.upstreamRepo.mockResolvedValue('other/place');
    const result = await runIt(executor, spec());

    expect(result).toMatchObject({ outcome: 'error', reason: 'github_unavailable' });
    expect(actions.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it('leaves a request without a job to the inner executor', async () => {
    const { executor, inner } = setup();
    const plain = spec();
    delete plain.githubJob;
    await runIt(executor, plain);
    expect(inner.run).toHaveBeenCalledTimes(1);
  });
});

describe('parseJobOutputs', () => {
  it('takes the last line of a path: the command could print one of its own', () => {
    const log = [
      `projectman-job output a.bin ${'1'.repeat(64)} 5`,
      `projectman-job output a.bin ${'2'.repeat(64)} 7`,
    ].join('\n');
    expect(parseJobOutputs(log, ['a.bin'])).toEqual({
      outputs: [{ path: 'a.bin', sha256: '2'.repeat(64), bytes: 7 }],
    });
  });
});
