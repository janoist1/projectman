import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** The guards of the dedicated engine release workflow (PM-1198); the general rules are in projectman-job-workflow.test.ts. */
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  'run-name': string;
  on: Record<string, { inputs?: Record<string, unknown> }>;
  concurrency: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { 'runs-on': string; steps: Step[] }>;
}

const file = fileURLToPath(
  new URL('../../../.github/workflows/projectman-engine-release.yml', import.meta.url),
);
const workflow = parse(readFileSync(file, 'utf8')) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const stepNamed = (name: string) => steps.find((step) => step.name === name)!;
const generalInputs = ['job', 'run_id', 'commit', 'command', 'runs_on', 'outputs', 'node', 'timeout_minutes'];

it('keeps the contract of the general compute job and holds the right to write a release', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(Object.keys(workflow.on['workflow_dispatch']!.inputs!)).toEqual(generalInputs);
  expect(workflow['run-name']).toBe(
    'projectman-job ${{ inputs.job }} ${{ inputs.commit }} ${{ inputs.run_id }}',
  );
  expect(workflow.concurrency).toEqual({ group: 'projectman-engine-release', 'cancel-in-progress': false });
  expect(workflow.permissions).toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write' });
  expect(Object.values(workflow.jobs).map((job) => job['runs-on'])).toEqual(['macos-15']);
});

it('attests the three release files before it uploads them', () => {
  const names = steps.map((step) => step.name ?? step.uses ?? '');
  const attest = names.findIndex((name) => name.startsWith('actions/attest-build-provenance@'));
  expect(attest).toBeGreaterThan(-1);
  expect(attest).toBeLessThan(names.indexOf('Upload to the release'));
  const subjects = stepNamed('Outputs').run!;
  for (const asset of ['zip', 'dmg', 'json']) expect(subjects).toContain(`projectman-motor.${asset}`);
});

describe('guard step', () => {
  const guard = stepNamed('Guard');
  const valid: Record<string, string> = {
    REF_NAME: 'main',
    DEFAULT_BRANCH: 'main',
    JOB: 'engine-release',
    RUN_ID: 'manual-aaaaaaaa-20261029120000',
    COMMIT: 'a'.repeat(40),
    COMMAND: 'engine-release',
    RUNS_ON: 'macos-15',
    OUTPUTS: 'app/projectman-motor.json',
    NODE_VERSION: '22',
    TIMEOUT_MINUTES: '60',
  };
  const run = (change: Record<string, string>) =>
    spawnSync('bash', ['-e', '-c', guard.run!], {
      env: { PATH: process.env['PATH'] ?? '', ...valid, ...change },
      encoding: 'utf8',
    });

  it('lets the registered job through', () => {
    expect(run({}).status).toBe(0);
  });

  it.each([
    ['a branch other than the default', { REF_NAME: 'pm-check/x' }],
    ['a short commit', { COMMIT: 'a'.repeat(39) }],
    ['another command', { COMMAND: 'npm ci' }],
    ['another runner', { RUNS_ON: 'ubuntu-24.04' }],
    ['another output', { OUTPUTS: 'app/projectman-motor.json other' }],
    ['a node version with text', { NODE_VERSION: '22; id' }],
    ['a time limit over six hours', { TIMEOUT_MINUTES: '361' }],
  ])('refuses %s', (_name, change) => {
    expect(run(change).status).toBe(1);
  });
});

describe('release tag step', () => {
  const step = stepNamed('Release tag');
  let dir: string;
  let bin: string;
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  const run = (releaseExists: boolean) => {
    writeFileSync(
      path.join(bin, 'gh'),
      releaseExists ? '#!/bin/sh\nexit 0\n' : '#!/bin/sh\necho "release not found" >&2\nexit 1\n',
    );
    chmodSync(path.join(bin, 'gh'), 0o755);
    const output = path.join(bin, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-e', '-c', step.run!], {
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        COMMIT: git('rev-parse', 'HEAD').stdout.trim(),
        DEFAULT_BRANCH: 'main',
        GH_TOKEN: 'x',
        REPO: 'example/projectman',
        GITHUB_OUTPUT: output,
      },
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, 'utf8') };
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'engine-release-'));
    bin = mkdtempSync(path.join(tmpdir(), 'engine-release-bin-'));
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'release');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it('hands over the one release tag of the commit', () => {
    git('tag', 'v2026.10.29.2');
    git('tag', 'not-a-release');
    expect(run(true)).toMatchObject({ status: 0, output: 'tag=v2026.10.29.2\n' });
  });

  it('fails without a release tag, with two, or without a GitHub release', () => {
    expect(run(true).status).toBe(1);
    git('tag', 'v2026.10.29.2');
    git('tag', 'v2026.10.29.3');
    expect(run(true).status).toBe(1);
    git('tag', '-d', 'v2026.10.29.3');
    const missing = run(false);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('app_release_missing');
  });

  it('fails for a commit that is not on the default branch', () => {
    git('tag', 'v2026.10.29.2');
    git('commit', '-q', '--allow-empty', '-m', 'only local');
    git('tag', 'v2026.10.30');
    expect(run(true).status).toBe(1);
  });
});
