import { describe, expect, it } from 'vitest';
import {
  COMPUTE_JOB_COMMAND_MAX,
  COMPUTE_JOB_TIMEOUT_MINUTES_MAX,
  ComputeJobDefinition,
  ComputeJobDefinitions,
  ComputeJobId,
  ComputeJobOutputPath,
  ComputeJobRunId,
  computeJobRunTitle,
  parseComputeJobRunTitle,
} from './compute-job';

const COMMIT = 'a'.repeat(40);

describe('compute job run title', () => {
  it('round-trips through build and parse', () => {
    const title = computeJobRunTitle('cloud-image', COMMIT, 'manual-aaaaaaaa-20261029');
    expect(title).toBe(`projectman-job cloud-image ${COMMIT} manual-aaaaaaaa-20261029`);
    expect(parseComputeJobRunTitle(title)).toEqual({
      job: 'cloud-image',
      commit: COMMIT,
      runId: 'manual-aaaaaaaa-20261029',
    });
  });

  it.each([
    'merge-check',
    'projectman-job cloud-image',
    `projectman-job cloud-image ${COMMIT}`,
    `projectman-job Cloud ${COMMIT} run1`,
    `projectman-job cloud-image ${COMMIT.slice(1)} run1`,
    `projectman-job cloud-image ${COMMIT.toUpperCase()} run1`,
    `projectman-job cloud-image ${COMMIT} -run`,
    `projectman-job cloud-image ${COMMIT} run1 extra`,
    ` projectman-job cloud-image ${COMMIT} run1`,
  ])('does not parse %j', (title) => {
    expect(parseComputeJobRunTitle(title)).toBeNull();
  });
});

describe('compute job patterns', () => {
  it.each([
    [
      ComputeJobId,
      ['a', 'cloud-image', `a${'b'.repeat(39)}`],
      ['', '1a', 'A', '-a', 'a_b', `a${'b'.repeat(40)}`],
    ],
    [
      ComputeJobRunId,
      ['0', 'a-b_c', `a${'b'.repeat(63)}`],
      ['', '-a', '_a', 'A', 'a b', `a${'b'.repeat(64)}`],
    ],
    [
      ComputeJobOutputPath,
      ['a', 'bundle/manifest.json', 'a/.hidden', 'a..b', 'x'.repeat(200)],
      ['', '/a', 'a/', 'a//b', '.', '..', 'a/./b', 'a/../b', '../a', 'a b', 'a\\b', 'x'.repeat(201)],
    ],
  ])('accepts and refuses the edge cases', (schema, good, bad) => {
    for (const value of good) expect(schema.safeParse(value).success, value).toBe(true);
    for (const value of bad) expect(schema.safeParse(value).success, value).toBe(false);
  });
});

describe('compute job definitions', () => {
  const job = (over: object = {}) => ({
    id: 'cloud-image',
    command: 'npm run build',
    runsOn: 'ubuntu-24.04-arm',
    outputs: ['image.tar'],
    ...over,
  });

  it('defaults the time limit and refuses duplicate ids', () => {
    expect(ComputeJobDefinitions.parse([job()])[0]?.timeoutMinutes).toBe(60);
    expect(ComputeJobDefinitions.safeParse([job(), job()]).success).toBe(false);
    expect(ComputeJobDefinitions.safeParse([job(), job({ id: 'other' })]).success).toBe(true);
  });

  it.each([
    ['a command over the limit', { command: 'x'.repeat(COMPUTE_JOB_COMMAND_MAX + 1) }],
    ['a three-digit node version', { node: '100' }],
    ['a time limit over six hours', { timeoutMinutes: COMPUTE_JOB_TIMEOUT_MINUTES_MAX + 1 }],
    ['an unknown runner', { runsOn: 'self-hosted' }],
    ['no outputs', { outputs: [] }],
    ['an unknown key', { extra: 1 }],
  ])('refuses %s', (_name, change) => {
    expect(ComputeJobDefinition.safeParse(job(change)).success).toBe(false);
  });
});
