import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import type { CloudDeps, RunResult } from '../../../scripts/cloud/deps';
import { Ec2HostWorld } from './helpers/fake-ec2-host';
import { SHA_NEW, SHA_NEWEST, SHA_OLD, IMAGE_ID } from './helpers/fake-host';

/** `npm run cloud -- runner-deploy`: the deploy of the `projectman-deploy.yml` job, with the role OIDC gave (PM-1197). */

const REPO = 'acme/projectman';
const RUN = 4242;
const RUN_ID = `manual-${SHA_NEWEST.slice(0, 8)}-20261029120000`;
const ENV_TEXT = [
  'LITESTREAM_BUCKET=acme-projectman-db',
  'LITESTREAM_ACCESS_KEY_ID=AKIAFAKEKEY00000001',
  'RESTIC_REPOSITORY=s3:https://s3.example.test/backup',
  'RESTIC_PASSWORD=fake-restic-password-0123456789',
].join('\n');
const LINK = 'https://pipelines.example.test/artifact.zip?sig=SECRETSIGNATURE';

let world: Ec2HostWorld;

beforeEach(() => {
  // No config.json and no cloud.env on this computer: the job has neither.
  world = new Ec2HostWorld();
  const bundle = world.writeBundle(SHA_NEWEST);
  world.machine.stageManifest = readFileSync(path.join(bundle, 'manifest.json'), 'utf8');
  world.machine.envText = ENV_TEXT;
});
afterEach(() => world.cleanup());

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

function deps(): CloudDeps {
  const base = world.deps();
  const title = `projectman-job cloud-image ${SHA_NEWEST} ${RUN_ID}`;
  return {
    ...base,
    run: async (command, args, options) => {
      if (command === 'git' && args.includes('get-url')) return ok(`https://github.com/${REPO}.git\n`);
      if (command !== 'gh') return base.run(command, args, options);
      if (args[0] === 'auth') return ok('gho_secrettoken\n');
      if (args[0] === 'attestation') {
        const uri = `https://github.com/${REPO}/actions/runs/${RUN}/attempts/1`;
        return ok(
          JSON.stringify([{ verificationResult: { signature: { certificate: { runInvocationURI: uri } } } }]),
        );
      }
      if (args[0] === 'run' && args[1] === 'list')
        return ok(
          JSON.stringify([
            { databaseId: RUN, displayTitle: title, status: 'completed', createdAt: '2026-10-29T12:00:00Z' },
          ]),
        );
      if (args[1]!.endsWith('/artifacts?per_page=100'))
        return ok(
          JSON.stringify({
            artifacts: [{ id: 77, name: `projectman-job-${RUN_ID}`, size_in_bytes: 4_600, expired: false }],
          }),
        );
      if (args[1]!.includes('/actions/runs/'))
        return ok(
          JSON.stringify({
            id: RUN,
            path: '.github/workflows/projectman-job.yml',
            event: 'workflow_dispatch',
            head_branch: 'main',
            status: 'completed',
            conclusion: 'success',
            display_title: title,
          }),
        );
      return ok(JSON.stringify({ default_branch: 'main' }));
    },
    fetch: async () => new Response(null, { status: 302, headers: { location: LINK } }),
  };
}

const reportFile = () => path.join(world.home, 'out', 'deploy', 'report.json');
const run = (ref = SHA_NEWEST, repository = REPO) =>
  runCloud(
    [
      'runner-deploy',
      '--ref',
      ref,
      '--repository',
      repository,
      '--region',
      'eu-west-1',
      '--instance',
      'projectman-cloud',
      '--out',
      reportFile(),
    ],
    deps(),
  );
const subcommands = () => world.hostCalls.map((call) => call.subcommand);
const report = () =>
  JSON.parse(readFileSync(reportFile(), 'utf8')) as {
    healthy: boolean;
    rolledBack: boolean;
    commit: string;
    pruned: string[];
  };

describe('runner-deploy', () => {
  it('uses the ambient AWS credentials: no profile on any aws call, and no cloud.env is read or sent', async () => {
    expect(await run()).toBe(0);
    const aws = world.transportCalls.filter((call) => call.command === 'aws');
    expect(aws.length).toBeGreaterThan(0);
    for (const call of aws) expect(call.args).not.toContain('--profile');
    expect(existsSync(world.envFile)).toBe(false);
    expect(subcommands()).not.toContain('receive-env');
    const sent = world.hostCalls.map((call) => `${call.input ?? ''}${call.args.join(' ')}`).join('\n');
    expect(sent).not.toContain('RESTIC_PASSWORD');
    expect(world.output).not.toMatch(/SECRETSIGNATURE|secrettoken|fake-restic-password/);
  });

  it('checks the machine’s own cloud.env first, then deploys the image of the run', async () => {
    expect(await run()).toBe(0);
    expect(subcommands().slice(0, 5)).toEqual([
      'env-check',
      'bootstrap',
      'stage-image',
      'receive-image',
      'status',
    ]);
    expect(world.machine.current()?.sha).toBe(SHA_NEWEST);
    expect(report()).toMatchObject({ commit: SHA_NEWEST, healthy: true, rolledBack: false });
  });

  it('stops with env_missing before anything starts when the machine has no complete cloud.env', async () => {
    world.machine.envText = null;
    expect(await run()).toBe(2);
    expect(world.output).toContain('env_missing');
    expect(subcommands()).toEqual(['env-check']);
    expect(world.machine.current()).toBeNull();
    expect(report().healthy).toBe(false);
  });

  it('removes the images that are neither the current nor the previous one after a healthy deploy', async () => {
    world.machine.preload(SHA_NEW, 'v-new', { sha: SHA_OLD, ref: 'v-old' });
    for (const sha of [SHA_OLD, SHA_NEW])
      world.machine.imported.set(sha, { imageId: IMAGE_ID, platform: 'linux/arm64' });
    expect(await run()).toBe(0);
    expect(subcommands().at(-1)).toBe('prune-images');
    expect(report().pruned).toEqual([SHA_OLD]);
    expect([...world.machine.imported.keys()].sort()).toEqual([SHA_NEW, SHA_NEWEST]);
  });

  it('rolls back an unhealthy start, reports it and fails the job without pruning', async () => {
    world.machine.preload(SHA_NEW, 'v-new');
    world.machine.unhealthyShas.add(SHA_NEWEST);
    expect(await run()).toBe(1);
    expect(report()).toMatchObject({ healthy: false, rolledBack: true, pruned: [] });
    expect(world.machine.current()?.sha).toBe(SHA_NEW);
    expect(subcommands()).not.toContain('prune-images');
  });

  it('refuses a commit that is not on the default branch before the machine is touched', async () => {
    world.offBranchShas.add(SHA_NEWEST);
    expect(await run()).toBe(2);
    expect(world.output).toContain('default branch');
    expect(world.hostCalls).toEqual([]);
  });

  it('refuses an image run of another repository before the machine is touched', async () => {
    expect(await run(SHA_NEWEST, 'other/projectman')).toBe(2);
    expect(world.hostCalls).toEqual([]);
  });
});
