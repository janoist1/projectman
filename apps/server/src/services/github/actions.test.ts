import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GithubActionsClient } from '../../contracts';
import { GithubError, createGithubActionsClient } from './index';
import {
  createFakeGh,
  createTestLogger,
  type FakeGh,
  type FakeGhResponse,
  type FakeGhScenario,
} from './test-fixtures/harness';

/** These tests run the real Actions client against test-fixtures/fake-gh.mjs; GitHub is never contacted. */

const REPO = 'acme/widgets';
const WORKFLOW = 'merge-check.yml';
const SHA = 'a'.repeat(40);

let fake: FakeGh;

beforeEach(async () => {
  fake = await createFakeGh();
});

afterEach(async () => {
  await fake.cleanup();
});

async function client(api: Record<string, FakeGhResponse | FakeGhResponse[]>): Promise<GithubActionsClient> {
  const scenario: FakeGhScenario = { api };
  await fake.setScenario(scenario);
  return createGithubActionsClient({
    ghBin: fake.bin,
    pollIntervalMs: 60_000,
    logger: createTestLogger(),
    env: fake.env,
  });
}

const run = (over: Record<string, unknown> = {}) => ({
  id: 7,
  status: 'completed',
  conclusion: 'success',
  head_sha: SHA,
  head_branch: 'pm-check/abc/r1',
  html_url: `https://github.com/${REPO}/actions/runs/7`,
  created_at: '2026-10-20T10:00:00Z',
  ...over,
});

describe('createGithubActionsClient', () => {
  it('dispatches the workflow with the ref and every input as its own argument', async () => {
    const actions = await client({
      [`POST repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`]: { stdout: '' },
    });
    await actions.dispatchWorkflow(
      REPO,
      WORKFLOW,
      { ref: 'pm-check/abc/r1', inputs: { check_id: 'r1', files: 'a.ts b.ts' } },
      new AbortController().signal,
    );
    const [call] = await fake.calls();
    expect(call?.argv).toEqual([
      'api',
      '--method=POST',
      `repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      '--raw-field',
      'ref=pm-check/abc/r1',
      '--raw-field',
      'inputs[check_id]=r1',
      '--raw-field',
      'inputs[files]=a.ts b.ts',
    ]);
  });

  it('finds the newest run of the commit among the branch runs', async () => {
    const actions = await client({
      [`GET repos/${REPO}/actions/workflows/${WORKFLOW}/runs`]: {
        json: {
          workflow_runs: [
            run({ id: 5, head_sha: 'b'.repeat(40) }),
            run({ id: 6, created_at: '2026-10-20T09:00:00Z' }),
            run({ id: 8, head_sha: SHA.toUpperCase(), created_at: '2026-10-20T11:00:00Z' }),
          ],
        },
      },
    });
    const found = await actions.findDispatchedRun(
      REPO,
      WORKFLOW,
      { branch: 'pm-check/abc/r1', headSha: SHA },
      new AbortController().signal,
    );
    expect(found?.id).toBe(8);
    const [call] = await fake.calls();
    expect(call?.argv[1]).toContain('branch=pm-check%2Fabc%2Fr1&event=workflow_dispatch');
  });

  it('gives null when no run belongs to the commit yet', async () => {
    const actions = await client({
      [`GET repos/${REPO}/actions/workflows/${WORKFLOW}/runs`]: {
        json: { workflow_runs: [run({ head_sha: 'b'.repeat(40) })] },
      },
    });
    await expect(
      actions.findDispatchedRun(
        REPO,
        WORKFLOW,
        { branch: 'pm-check/abc/r1', headSha: SHA },
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
  });

  it('maps a run and its jobs, null status and conclusion included', async () => {
    const actions = await client({
      [`GET repos/${REPO}/actions/runs/7`]: { json: run({ status: 'in_progress', conclusion: null }) },
      [`GET repos/${REPO}/actions/runs/7/jobs`]: {
        json: {
          jobs: [
            {
              id: 11,
              name: 'shard 1',
              status: 'completed',
              conclusion: 'failure',
              started_at: '2026-10-20T10:00:00Z',
              completed_at: '2026-10-20T10:05:00Z',
              steps: [
                { name: 'merge-test', status: 'completed', conclusion: 'failure', started_at: null },
                { name: 'later', status: 'completed', conclusion: 'skipped' },
              ],
            },
          ],
        },
      },
    });
    const signal = new AbortController().signal;
    await expect(actions.getRun(REPO, 7, signal)).resolves.toMatchObject({
      id: 7,
      status: 'in_progress',
      conclusion: null,
      headSha: SHA,
    });
    const [job] = await actions.listJobs(REPO, 7, signal);
    expect(job).toMatchObject({ id: 11, name: 'shard 1', conclusion: 'failure' });
    expect(job?.steps[0]).toEqual({
      name: 'merge-test',
      status: 'completed',
      conclusion: 'failure',
      startedAt: null,
      completedAt: null,
    });
  });

  it('returns the job log as it is', async () => {
    const actions = await client({
      [`GET repos/${REPO}/actions/jobs/11/logs`]: { stdout: '2026-10-20T10:00:00Z hello\n' },
    });
    await expect(actions.jobLog(REPO, 11, new AbortController().signal)).resolves.toBe(
      '2026-10-20T10:00:00Z hello\n',
    );
    const [call] = await fake.calls();
    expect(call?.argv).toContain('--allow-escape-sequences');
  });

  it('asks for the job log again without the escape flag when an older gh does not know it', async () => {
    const actions = await client({
      [`GET repos/${REPO}/actions/jobs/11/logs`]: [
        { stderr: 'unknown flag: --allow-escape-sequences', exitCode: 1 },
        { stdout: 'plain log\n' },
      ],
    });
    await expect(actions.jobLog(REPO, 11, new AbortController().signal)).resolves.toBe('plain log\n');
    const calls = await fake.calls();
    expect(calls.map((call) => call.argv.includes('--allow-escape-sequences'))).toEqual([true, false]);
  });

  it('refuses an answer that is not the documented JSON', async () => {
    const actions = await client({
      [`GET repos/${REPO}/actions/runs/7`]: { stdout: 'not json\n' },
      [`GET repos/${REPO}/actions/runs/8`]: { json: { id: 8 } },
    });
    const signal = new AbortController().signal;
    await expect(actions.getRun(REPO, 7, signal)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(actions.getRun(REPO, 8, signal)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('swallows the 409 of cancelling a finished run but not another failure', async () => {
    const actions = await client({
      [`POST repos/${REPO}/actions/runs/7/cancel`]: {
        stderr: 'gh: Cannot cancel a workflow run that is completed. (HTTP 409)',
        exitCode: 1,
      },
      [`POST repos/${REPO}/actions/runs/8/cancel`]: {
        stderr: 'gh: Resource not accessible by integration (HTTP 403)',
        exitCode: 1,
      },
    });
    const signal = new AbortController().signal;
    await expect(actions.cancelRun(REPO, 7, signal)).resolves.toBeUndefined();
    await expect(actions.cancelRun(REPO, 8, signal)).rejects.toBeInstanceOf(GithubError);
  });

  it.each([
    [
      'a repository that is not owner/name',
      (a: GithubActionsClient, s: AbortSignal) => a.getRun('../x', 7, s),
    ],
    [
      'a workflow that is a path',
      (a: GithubActionsClient, s: AbortSignal) =>
        a.dispatchWorkflow(REPO, '../x.yml', { ref: 'main', inputs: {} }, s),
    ],
    ['a run id that is not positive', (a: GithubActionsClient, s: AbortSignal) => a.getRun(REPO, 0, s)],
    [
      'a ref that starts with a dash',
      (a: GithubActionsClient, s: AbortSignal) =>
        a.dispatchWorkflow(REPO, WORKFLOW, { ref: '--evil', inputs: {} }, s),
    ],
  ])('refuses %s before it calls gh', async (_name, call) => {
    const actions = await client({});
    await expect(call(actions, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    expect(await fake.calls()).toEqual([]);
  });
});
