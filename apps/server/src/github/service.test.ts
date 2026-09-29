import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubService, PullRequestInfo } from '../contracts';
import { GithubError, createGithubService, type GithubServiceOptions } from './index';
import { PULL_REQUEST_JSON_FIELDS } from './pull-request';
import {
  checkRun,
  createFakeGh,
  createTestLogger,
  ghPullRequestJson,
  statusContext,
  type FakeGh,
  type FakeGhScenario,
} from './test-fixtures/harness';

/** These tests run the real service against test-fixtures/fake-gh.mjs; GitHub is never contacted. */

const JSON_FLAG = `--json=${PULL_REQUEST_JSON_FIELDS.join(',')}`;

let fake: FakeGh;

beforeEach(async () => {
  fake = await createFakeGh();
});

afterEach(async () => {
  await fake.cleanup();
});

function service(
  scenario: FakeGhScenario,
  options: Partial<GithubServiceOptions> = {},
): Promise<GithubService> {
  return fake.setScenario(scenario).then(() =>
    createGithubService({
      ghBin: fake.bin,
      pollIntervalMs: 60_000,
      logger: createTestLogger(),
      env: fake.env,
      ...options,
    }),
  );
}

async function githubError(promise: Promise<unknown>): Promise<GithubError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(GithubError);
  return error as GithubError;
}

describe('createGithubService', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects pollIntervalMs %s', (pollIntervalMs) => {
    expect(() =>
      createGithubService({ ghBin: fake.bin, pollIntervalMs, logger: createTestLogger() }),
    ).toThrowError(RangeError);
  });
});

describe('isAvailable', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is true when gh auth status succeeds for the active github.com account', async () => {
    vi.stubEnv('GH_HOST', '');
    const github = await service({ auth: { stdout: 'Logged in to github.com' } });
    await expect(github.isAvailable()).resolves.toBe(true);
    const [call] = await fake.calls();
    expect(call?.argv).toEqual(['auth', 'status', '--active', '--hostname=github.com']);
  });

  it('checks the host gh is configured for', async () => {
    const github = await service({}, { env: { ...fake.env, GH_HOST: 'github.example.com' } });
    await expect(github.isAvailable()).resolves.toBe(true);
    const [call] = await fake.calls();
    expect(call?.argv).toContain('--hostname=github.example.com');
  });

  it('is false when gh is not logged in', async () => {
    const github = await service({
      auth: {
        stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
        exitCode: 1,
      },
    });
    await expect(github.isAvailable()).resolves.toBe(false);
  });

  it('is false when gh is not installed', async () => {
    const github = await service({}, { ghBin: '/nonexistent/projectman-test/gh' });
    await expect(github.isAvailable()).resolves.toBe(false);
  });
});

describe('getPullRequest', () => {
  it('runs gh pr view and maps the result', async () => {
    const github = await service({
      pullRequests: {
        'acme/app#12': {
          json: ghPullRequestJson({
            reviewDecision: 'APPROVED',
            statusCheckRollup: [
              checkRun('build', 'COMPLETED', 'SUCCESS'),
              statusContext('ci/legacy', 'PENDING'),
            ],
          }),
        },
      },
    });

    const pr = await github.getPullRequest('acme/app', 12);

    expect(pr).toMatchObject({
      repo: 'acme/app',
      number: 12,
      state: 'open',
      checks: 'pending',
      reviewDecision: 'approved',
      headRef: 'AR-21-room-search',
    });
    const [call] = await fake.calls();
    expect(call?.argv).toEqual(['pr', 'view', '12', '--repo=acme/app', JSON_FLAG]);
    expect(call?.env).toEqual({
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      CLICOLOR_FORCE: '0',
      GH_FORCE_TTY: null,
    });
  });

  it('never lets gh think it runs in a terminal', async () => {
    vi.stubEnv('GH_FORCE_TTY', '1');
    vi.stubEnv('CLICOLOR_FORCE', '1');
    try {
      const github = await service({ pullRequests: { 'acme/app#12': { json: ghPullRequestJson() } } });
      await github.getPullRequest('acme/app', 12);
    } finally {
      vi.unstubAllEnvs();
    }
    const [call] = await fake.calls();
    expect(call?.env).toMatchObject({ GH_FORCE_TTY: null, CLICOLOR_FORCE: '0' });
  });

  it.each<[string, FakeGhScenario, GithubError['code']]>([
    ['an unknown pull request', {}, 'not_found'],
    [
      'rate limiting',
      {
        pullRequests: {
          'acme/app#12': { stderr: 'GraphQL: API rate limit exceeded for user ID 1.', exitCode: 1 },
        },
      },
      'rate_limited',
    ],
    [
      'a logged-out gh',
      {
        pullRequests: {
          'acme/app#12': {
            stderr: 'To get started with GitHub CLI, please run:  gh auth login',
            exitCode: 4,
          },
        },
      },
      'not_authenticated',
    ],
    ['output that is not JSON', { pullRequests: { 'acme/app#12': { stdout: 'oops' } } }, 'invalid_response'],
    [
      'JSON of the wrong shape',
      { pullRequests: { 'acme/app#12': { json: { number: 'twelve' } } } },
      'invalid_response',
    ],
  ])('reports %s', async (_label, scenario, code) => {
    const github = await service(scenario);
    const error = await githubError(github.getPullRequest('acme/app', 12));
    expect(error.code).toBe(code);
  });

  it('kills gh after the timeout', async () => {
    const github = await service(
      { pullRequests: { 'acme/app#12': { delayMs: 10_000, json: ghPullRequestJson() } } },
      { commandTimeoutMs: 300 },
    );
    const error = await githubError(github.getPullRequest('acme/app', 12));
    expect(error.code).toBe('timeout');
  });

  it('reports a missing gh binary', async () => {
    const github = await service({}, { ghBin: '/nonexistent/projectman-test/gh' });
    const error = await githubError(github.getPullRequest('acme/app', 12));
    expect(error.code).toBe('not_installed');
  });

  it.each<[string, number]>([
    ['acme', 12],
    ['--repo=evil/x', 12],
    ['acme/app', 0],
    ['acme/app', 1.5],
  ])('rejects repo %j with number %j without running gh', async (repo, number) => {
    const github = await service({});
    const error = await githubError(github.getPullRequest(repo, number));
    expect(error.code).toBe('invalid_argument');
    expect(await fake.calls()).toEqual([]);
  });
});

describe('findPullRequestsForBranch', () => {
  it('runs gh pr list for the head branch, all states', async () => {
    const github = await service({
      branches: {
        'acme/app@AR-21-room-search': {
          json: [ghPullRequestJson({ number: 14 }), ghPullRequestJson({ number: 9, state: 'CLOSED' })],
        },
      },
    });

    const prs = await github.findPullRequestsForBranch('acme/app', 'AR-21-room-search');

    expect(prs.map((pr) => [pr.number, pr.state])).toEqual([
      [14, 'open'],
      [9, 'closed'],
    ]);
    const [call] = await fake.calls();
    expect(call?.argv).toEqual([
      'pr',
      'list',
      '--repo=acme/app',
      '--head=AR-21-room-search',
      '--state=all',
      '--limit=30',
      JSON_FLAG,
    ]);
  });

  it('returns an empty list when the branch has no PR', async () => {
    const github = await service({});
    await expect(github.findPullRequestsForBranch('acme/app', 'AR-99-nothing')).resolves.toEqual([]);
  });

  it('rejects an invalid branch without running gh', async () => {
    const github = await service({});
    const error = await githubError(github.findPullRequestsForBranch('acme/app', '--state=open'));
    expect(error.code).toBe('invalid_argument');
    expect(await fake.calls()).toEqual([]);
  });
});

describe('parsePullRequestUrl', () => {
  it('is exposed on the service', async () => {
    const github = await service({});
    expect(github.parsePullRequestUrl('https://github.com/acme/app/pull/12')).toEqual({
      repo: 'acme/app',
      number: 12,
    });
  });
});

describe('watch', () => {
  it('reports each change once, polling with one gh call at a time', async () => {
    const open = ghPullRequestJson({ statusCheckRollup: [checkRun('build', 'IN_PROGRESS', '')] });
    const green = ghPullRequestJson({ statusCheckRollup: [checkRun('build', 'COMPLETED', 'SUCCESS')] });
    const merged = ghPullRequestJson({
      state: 'MERGED',
      mergedAt: '2026-09-29T12:00:00Z',
      statusCheckRollup: [checkRun('build', 'COMPLETED', 'SUCCESS')],
    });
    const github = await service(
      {
        pullRequests: {
          'acme/app#12': [{ json: open }, { json: open }, { json: green }, { json: merged }],
          'acme/app#13': { json: ghPullRequestJson({ number: 13 }) },
        },
      },
      { pollIntervalMs: 25 },
    );
    const seen: PullRequestInfo[] = [];

    const unsubscribe = github.watch(
      [
        { repo: 'acme/app', number: 12 },
        { repo: 'acme/app', number: 13 },
      ],
      (pr) => seen.push(pr),
    );
    try {
      await vi.waitFor(() => expect(seen.filter((pr) => pr.number === 12).at(-1)?.state).toBe('merged'), {
        timeout: 4000,
        interval: 20,
      });
    } finally {
      unsubscribe();
    }

    expect(seen.filter((pr) => pr.number === 12).map((pr) => [pr.state, pr.checks])).toEqual([
      ['open', 'pending'],
      ['open', 'success'],
      ['merged', 'success'],
    ]);
    expect(seen.filter((pr) => pr.number === 13)).toHaveLength(1);

    const calls = await fake.calls();
    const sorted = [...calls].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]!;
      expect(previous.end).not.toBeNull();
      expect(sorted[i]!.start).toBeGreaterThanOrEqual(previous.end!);
    }
  });
});
