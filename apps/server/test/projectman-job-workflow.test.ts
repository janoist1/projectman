import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GithubJobRunner } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
