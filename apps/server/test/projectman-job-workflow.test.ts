import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GithubJobRunner } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CLOUD_IMAGE_JOB } from '../../../scripts/cloud/image-fetch';
import { ENGINE_APP_JOB } from '../../../scripts/engine-app/job';

/** Rules of the general compute-job workflow (PM-1145) and of every workflow in the public repository. */
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Workflow {
  name: string;
  'run-name': string;
  on: Record<string, { inputs?: Record<string, { type?: string; options?: string[]; default?: string }> }>;
  permissions: Record<string, string>;
  jobs: Record<string, { 'runs-on': string; steps: Step[] }>;
}

const directory = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));
const sources = Object.fromEntries(
  readdirSync(directory)
    .filter((file) => file.endsWith('.yml'))
    .map((file) => [file, readFileSync(`${directory}${file}`, 'utf8')]),
);
const source = sources['projectman-job.yml']!;
const workflow = parse(source) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

describe('the projectman-job workflow', () => {
  it('starts only from a dispatch and names its run after the job, the commit and the run id', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow['run-name']).toBe(
      'projectman-job ${{ inputs.job }} ${{ inputs.commit }} ${{ inputs.run_id }}',
    );
  });

  it('holds exactly the permissions the attestation needs', () => {
    expect(workflow.permissions).toEqual({ contents: 'read', 'id-token': 'write', attestations: 'write' });
  });

  it('offers exactly the runners of GithubJobRunner', () => {
    expect(workflow.on['workflow_dispatch']?.inputs?.['runs_on']).toMatchObject({
      type: 'choice',
      options: GithubJobRunner.options,
    });
    expect(Object.values(workflow.jobs).map((job) => job['runs-on'])).toEqual(['${{ inputs.runs_on }}']);
  });

  it('never puts an input into a command', () => {
    const commands = steps.flatMap((step) => (step.run ? [step.run] : []));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((command) => command.includes('${{ inputs.'))).toEqual([]);
  });

  it('attests the outputs and uploads the staged files for seven days', () => {
    const uses = (prefix: string) => steps.find((step) => step.uses?.startsWith(prefix));
    expect(uses('actions/attest-build-provenance@')).toBeDefined();
    expect(uses('actions/upload-artifact@')?.with).toMatchObject({
      name: 'projectman-job-${{ inputs.run_id }}',
      'compression-level': 0,
      'retention-days': 7,
      'if-no-files-found': 'error',
    });
    expect(uses('actions/checkout@')?.with?.['persist-credentials']).toBe(false);
  });

  describe('default branch step', () => {
    const names = steps.map((step) => step.name ?? step.uses ?? '');
    const check = steps.find((step) => step.name === 'Commit on the default branch')!;

    it('comes after a full checkout and before the command runs', () => {
      const checkout = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
      expect(steps[checkout]?.with?.['fetch-depth']).toBe(0);
      expect(names.indexOf('Commit on the default branch')).toBeGreaterThan(checkout);
      expect(names.indexOf('Commit on the default branch')).toBeLessThan(names.indexOf('Run'));
    });

    describe('in a clone', () => {
      const git = (cwd: string, ...args: string[]) =>
        spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
          cwd,
          encoding: 'utf8',
        });
      const commitOf = (cwd: string) => git(cwd, 'rev-parse', 'HEAD').stdout.trim();
      const runCheck = (cwd: string, commit: string) =>
        spawnSync('bash', ['-e', '-c', check.run!], {
          cwd,
          env: { PATH: process.env['PATH'] ?? '', COMMIT: commit, DEFAULT_BRANCH: 'main' },
          encoding: 'utf8',
        });

      it('lets a commit of the default branch through and refuses one that is not on it', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'projectman-job-'));
        try {
          git(dir, 'init', '-q', '-b', 'main');
          git(dir, 'commit', '-q', '--allow-empty', '-m', 'on main');
          const onMain = commitOf(dir);
          git(dir, 'update-ref', 'refs/remotes/origin/main', onMain);
          git(dir, 'commit', '-q', '--allow-empty', '-m', 'only local');
          const notOnMain = commitOf(dir);
          expect(runCheck(dir, onMain).status).toBe(0);
          expect(runCheck(dir, notOnMain).status).toBe(1);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });

  describe('guard step', () => {
    const guard = steps.find((step) => step.name === 'Guard')!;
    const valid: Record<string, string> = {
      REF_NAME: 'main',
      DEFAULT_BRANCH: 'main',
      JOB: 'cloud-image',
      RUN_ID: 'manual-aaaaaaaa-20261029120000',
      COMMIT: 'a'.repeat(40),
      COMMAND: 'npm ci',
      RUNS_ON: 'ubuntu-24.04-arm',
      OUTPUTS: 'bundle/manifest.json bundle/linux-arm64.tar',
      NODE_VERSION: '22',
      TIMEOUT_MINUTES: '60',
    };
    const run = (change: Record<string, string>) =>
      spawnSync('bash', ['-e', '-c', guard.run!], {
        env: { PATH: process.env['PATH'] ?? '', ...valid, ...change },
        encoding: 'utf8',
      });

    it.each([CLOUD_IMAGE_JOB, ENGINE_APP_JOB])('lets the registered $id job through', (job) => {
      expect(
        run({
          JOB: job.id,
          COMMAND: job.command,
          RUNS_ON: job.runsOn,
          OUTPUTS: job.outputs.join(' '),
          NODE_VERSION: job.node,
          TIMEOUT_MINUTES: String(job.timeoutMinutes),
        }).status,
      ).toBe(0);
    });

    it('lets a valid dispatch through', () => {
      expect(run({}).status).toBe(0);
      expect(run({ NODE_VERSION: '', OUTPUTS: 'a' }).status).toBe(0);
    });

    it.each([
      ['a branch other than the default', { REF_NAME: 'pm-check/x' }],
      ['an uppercase job', { JOB: 'Cloud' }],
      ['a job with a newline', { JOB: 'cloud\nx' }],
      ['a run id starting with a dash', { RUN_ID: '-run' }],
      ['a short commit', { COMMIT: 'a'.repeat(39) }],
      ['an empty command', { COMMAND: '' }],
      ['an unknown runner', { RUNS_ON: 'self-hosted' }],
      ['a node version with text', { NODE_VERSION: '22; id' }],
      ['a zero time limit', { TIMEOUT_MINUTES: '0' }],
      ['a time limit over six hours', { TIMEOUT_MINUTES: '361' }],
      ['eleven outputs', { OUTPUTS: Array.from({ length: 11 }, (_, index) => `f${index}`).join(' ') }],
      ['two spaces between outputs', { OUTPUTS: 'a  b' }],
      ['an output with a newline', { OUTPUTS: 'a\nb' }],
      ['an output with a dot-dot segment', { OUTPUTS: 'a/../b' }],
      ['an absolute output', { OUTPUTS: '/etc/passwd' }],
      ['a glob output', { OUTPUTS: 'a/*' }],
    ])('refuses %s', (_name, change) => {
      expect(run(change).status).toBe(1);
    });
  });
});

/** The dedicated cloud-deploy workflow (PM-1197): the contract of a compute job, a narrow OIDC role, no AWS key. */
describe('the projectman-deploy workflow', () => {
  interface DeployWorkflow extends Workflow {
    concurrency: { group: string; 'cancel-in-progress': boolean };
    jobs: Record<
      string,
      {
        'runs-on': string;
        environment: string;
        permissions: Record<string, string>;
        steps: Step[];
      }
    >;
  }
  const deploySource = sources['projectman-deploy.yml']!;
  const deploy = parse(deploySource) as DeployWorkflow;
  const job = deploy.jobs['deploy']!;
  const guard = job.steps.find((step) => step.name === 'Guard')!;

  it('takes the inputs of projectman-job.yml and keeps its run title', () => {
    expect(Object.keys(deploy.on)).toEqual(['workflow_dispatch']);
    expect(deploy['run-name']).toBe(workflow['run-name']);
    expect(Object.keys(deploy.on['workflow_dispatch']!.inputs!)).toEqual(
      Object.keys(workflow.on['workflow_dispatch']!.inputs!),
    );
  });

  it('runs one deploy at a time, in the cloud-production environment, with only the OIDC and attestation rights', () => {
    expect(deploy.concurrency).toEqual({ group: 'projectman-deploy', 'cancel-in-progress': false });
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job.environment).toBe('cloud-production');
    expect(job.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      'id-token': 'write',
      attestations: 'write',
    });
  });

  it('refuses anything but the fixed command, runner and output, and a commit off the default branch', () => {
    expect(guard.run).toContain('"$COMMAND" == "cloud-deploy"');
    expect(guard.run).toContain('"$RUNS_ON" == "ubuntu-24.04"');
    expect(guard.run).toContain('"$OUTPUTS" == "deploy/report.json"');
    expect(guard.run).toContain('"$REF_NAME" == "$DEFAULT_BRANCH"');
    const ancestor = job.steps.find((step) => step.run?.includes('merge-base --is-ancestor'));
    expect(ancestor?.run).toContain('"origin/$DEFAULT_BRANCH"');
  });

  it('assumes the role from the environment variables, for an hour at most, and holds no AWS key', () => {
    const credentials = job.steps.find((step) =>
      step.uses?.startsWith('aws-actions/configure-aws-credentials@'),
    );
    expect(credentials?.with).toMatchObject({
      'role-to-assume': '${{ vars.PROJECTMAN_DEPLOY_ROLE_ARN }}',
      'aws-region': '${{ vars.PROJECTMAN_AWS_REGION }}',
      'role-duration-seconds': 3600,
    });
    expect(deploySource).not.toMatch(
      /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|aws-access-key/i,
    );
  });

  it('never puts an input into a command', () => {
    for (const step of job.steps) expect(step.run ?? '').not.toContain('${{');
  });
});

describe('every workflow of the repository', () => {
  it.each(Object.keys(sources))('%s has no privileged trigger and no secret', (file) => {
    expect(sources[file]).not.toContain('pull_request_target');
    expect(sources[file]).not.toContain('secrets.');
  });

  it.each(Object.keys(sources))('%s pins every action to a commit', (file) => {
    const actions = Object.values((parse(sources[file]!) as Workflow).jobs).flatMap((job) =>
      job.steps.flatMap((step) => (step.uses ? [step.uses] : [])),
    );
    for (const action of actions) expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });
});
