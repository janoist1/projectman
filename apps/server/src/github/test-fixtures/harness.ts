import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { vi } from 'vitest';
import type { PullRequestInfo } from '../../contracts';

/** Test helpers for the github module. Nothing here talks to GitHub. */

export const FAKE_GH_BIN = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));

export interface FakeGhResponse {
  json?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
}

export interface FakeGhScenario {
  auth?: FakeGhResponse;
  /** Keyed by "owner/name#<number>". */
  pullRequests?: Record<string, FakeGhResponse | FakeGhResponse[]>;
  /** Keyed by "owner/name@<branch>". */
  branches?: Record<string, FakeGhResponse | FakeGhResponse[]>;
}

export interface FakeGhCall {
  pid: number;
  key: string;
  argv: string[];
  env: Record<string, string | null>;
  start: number;
  end: number | null;
}

export interface FakeGh {
  bin: string;
  /** Pass as GithubServiceOptions.env. */
  env: Record<string, string>;
  setScenario(scenario: FakeGhScenario): Promise<void>;
  calls(): Promise<FakeGhCall[]>;
  cleanup(): Promise<void>;
}

export async function createFakeGh(scenario: FakeGhScenario = {}): Promise<FakeGh> {
  const dir = await mkdtemp(join(tmpdir(), 'projectman-fake-gh-'));
  const scenarioPath = join(dir, 'scenario.json');
  const callLog = join(dir, 'calls.jsonl');
  const setScenario = (next: FakeGhScenario) => writeFile(scenarioPath, JSON.stringify(next));
  await setScenario(scenario);

  return {
    bin: FAKE_GH_BIN,
    env: { FAKE_GH_SCENARIO: scenarioPath, FAKE_GH_CALL_LOG: callLog },
    setScenario,
    async calls() {
      if (!existsSync(callLog)) return [];
      const lines = (await readFile(callLog, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const calls: FakeGhCall[] = [];
      for (const line of lines) {
        if (line.event === 'start') {
          calls.push({
            pid: line.pid as number,
            key: line.key as string,
            argv: line.argv as string[],
            env: line.env as Record<string, string | null>,
            start: line.at as number,
            end: null,
          });
        } else {
          const call = calls.find((candidate) => candidate.pid === line.pid && candidate.end === null);
          if (call) call.end = line.at as number;
        }
      }
      return calls;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** A pull request as `gh pr view --json …` prints it (all fields the module requests). */
export function ghPullRequestJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: 'AR-21 Add room search',
    url: 'https://github.com/acme/app/pull/12',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'AR-21-room-search',
    baseRefName: 'main',
    statusCheckRollup: [],
    reviewDecision: '',
    additions: 120,
    deletions: 8,
    changedFiles: 5,
    updatedAt: '2026-09-29T10:00:00Z',
    mergedAt: null,
    ...overrides,
  };
}

export function checkRun(
  name: string,
  status: string,
  conclusion: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    __typename: 'CheckRun',
    name,
    workflowName: 'CI',
    status,
    conclusion,
    startedAt: '2026-09-29T10:00:00Z',
    completedAt: status === 'COMPLETED' ? '2026-09-29T10:05:00Z' : '0001-01-01T00:00:00Z',
    detailsUrl: `https://github.com/acme/app/actions/runs/1/job/${name}`,
    ...extra,
  };
}

export function statusContext(
  context: string,
  state: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    __typename: 'StatusContext',
    context,
    state,
    startedAt: '2026-09-29T10:00:00Z',
    targetUrl: `https://ci.example.com/${context}`,
    ...extra,
  };
}

/** A mapped pull request, for tests that bypass gh. */
export function pullRequestInfo(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    repo: 'acme/app',
    number: 12,
    title: 'AR-21 Add room search',
    url: 'https://github.com/acme/app/pull/12',
    state: 'open',
    draft: false,
    headRef: 'AR-21-room-search',
    baseRef: 'main',
    checks: 'pending',
    reviewDecision: null,
    additions: 120,
    deletions: 8,
    changedFiles: 5,
    updatedAt: '2026-09-29T10:00:00Z',
    ...overrides,
  };
}

export type TestLogger = FastifyBaseLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
};

/** A silent logger whose methods are spies. */
export function createTestLogger(): TestLogger {
  const logger: Record<string, unknown> = {
    level: 'silent',
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
  };
  logger.child = () => logger;
  return logger as unknown as TestLogger;
}
