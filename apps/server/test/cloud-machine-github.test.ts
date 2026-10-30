import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import type { CloudDeps, RunResult } from '../../../scripts/cloud/deps';
import { SHA_NEWEST } from './helpers/fake-host';
import { Ec2HostWorld } from './helpers/fake-ec2-host';

/** `npm run cloud -- deploy` with `deployment.imageSource: "github"`: the machine downloads the image (PM-1154). */

const REPO = 'acme/projectman';
const RUN = 4242;
const RUN_ID = `manual-${SHA_NEWEST.slice(0, 8)}-20261029120000`;
const LINK = 'https://pipelines.example.test/artifact.zip?sig=SECRETSIGNATURE';
const TOKEN = 'gho_secrettoken';
const ARTIFACT_BYTES = 460_000_000;

interface GithubState {
  attestationFails: boolean;
  attestedRun: number;
  artifacts: { id: number; name: string; size_in_bytes: number; expired: boolean }[];
  linkStatus: number;
  runListed: boolean;
  calls: string[][];
}

let world: Ec2HostWorld;
let github: GithubState;

beforeEach(() => {
  world = Ec2HostWorld.configured();
  world.writeConfig({ route53: { profile: 'i' }, deployment: { imageSource: 'github' } });
  // No bundle is needed on this computer; the manifest the machine returns is the one this builds.
  const bundle = world.writeBundle(SHA_NEWEST);
  world.machine.stageManifest = readFileSync(path.join(bundle, 'manifest.json'), 'utf8');
  github = {
    attestationFails: false,
    attestedRun: RUN,
    artifacts: [{ id: 77, name: `projectman-job-${RUN_ID}`, size_in_bytes: ARTIFACT_BYTES, expired: false }],
    linkStatus: 302,
    runListed: true,
    calls: [],
  };
});
afterEach(() => world.cleanup());

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

/** The `git origin`, `gh` and GitHub download-link request, around the world's AWS and machine fakes. */
function deps(): CloudDeps {
  const base = world.deps();
  const title = `projectman-job cloud-image ${SHA_NEWEST} ${RUN_ID}`;
  return {
    ...base,
    run: async (command, args, options) => {
      if (command === 'git' && args.includes('get-url')) return ok(`https://github.com/${REPO}.git\n`);
      if (command !== 'gh') return base.run(command, args, options);
      github.calls.push(args);
      if (args[0] === 'auth') return ok(`${TOKEN}\n`);
      if (args[0] === 'attestation') {
        if (github.attestationFails) return { code: 1, stdout: '', stderr: 'no matching attestation' };
        const uri = `https://github.com/${REPO}/actions/runs/${github.attestedRun}/attempts/1`;
        return ok(
          JSON.stringify([{ verificationResult: { signature: { certificate: { runInvocationURI: uri } } } }]),
        );
      }
      if (args[0] === 'run' && args[1] === 'list')
        return ok(
          JSON.stringify(
            github.runListed
              ? [
                  {
                    databaseId: RUN,
                    displayTitle: title,
                    status: 'completed',
                    createdAt: '2026-10-29T12:00:00Z',
                  },
                ]
              : [],
          ),
        );
      if (args[0] !== 'api') return { code: 1, stdout: '', stderr: 'unexpected gh call' };
      if (args[1]!.endsWith('/artifacts?per_page=100'))
        return ok(JSON.stringify({ artifacts: github.artifacts }));
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
    fetch: async () =>
      new Response(null, {
        status: github.linkStatus,
        headers: github.linkStatus === 302 ? { location: LINK } : {},
      }),
  };
}

const run = (...argv: string[]) => runCloud(argv, deps());
const subcommands = () => world.hostCalls.map((call) => call.subcommand);
const everything = () => `${world.output}\n${world.hostCalls.map((call) => call.remote).join('\n')}`;

describe('deploy from the GitHub artifact', () => {
  it('has the machine download and import the image, and conducts only', async () => {
    expect(await run('deploy')).toBe(0);
    expect(subcommands().slice(0, 5)).toEqual([
      'bootstrap',
      'stage-image',
      'receive-image',
      'receive-env',
      'status',
    ]);
    const stage = world.hostCalls.find((call) => call.subcommand === 'stage-image')!;
    expect(stage.args).toEqual([String(ARTIFACT_BYTES)]);
    expect(stage.input).toBe(`${LINK}\n`);
    const receive = world.hostCalls.find((call) => call.subcommand === 'receive-image')!;
    expect(receive.args.at(-1)).toBe(world.machine.stageId);
    expect(receive.args[0]).toBe(SHA_NEWEST);
    expect(world.machine.staged).toBeNull();
    expect(world.machine.current()?.sha).toBe(SHA_NEWEST);
    expect(world.output).toContain('ok stage-image');
    expect(world.output).toContain(`https://github.com/${REPO}/actions/runs/${RUN}`);
  });

  it('keeps the download link and the token out of every message and every command line', async () => {
    expect(await run('deploy')).toBe(0);
    expect(everything()).not.toMatch(/SECRETSIGNATURE|secrettoken/);
  });

  it('uses the run it is given instead of searching', async () => {
    github.runListed = false;
    expect(await run('deploy', '--run', String(RUN))).toBe(0);
    expect(github.calls.some((call) => call[0] === 'run' && call[1] === 'list')).toBe(false);
  });

  it('only finds the run and its artifact in a dry run, without touching the machine', async () => {
    expect(await run('deploy', '--dry-run')).toBe(0);
    expect(world.hostCalls).toEqual([]);
    expect(world.output).toContain(`actions/runs/${RUN}`);
  });

  it('refuses when there is no run, naming how to start one', async () => {
    github.runListed = false;
    expect(await run('deploy')).toBe(2);
    expect(world.output).toContain('start one with');
    expect(world.hostCalls).toEqual([]);
  });

  it('refuses an expired artifact before the machine is touched', async () => {
    github.artifacts = github.artifacts.map((artifact) => ({ ...artifact, expired: true }));
    expect(await run('deploy')).toBe(2);
    expect(world.output).toContain('expired');
    expect(world.hostCalls).toEqual([]);
  });

  it('never calls receive-image when the returned manifest is not attested', async () => {
    github.attestationFails = true;
    expect(await run('deploy')).toBe(2);
    expect(subcommands()).toContain('stage-image');
    expect(subcommands()).not.toContain('receive-image');
    expect(subcommands()).not.toContain('start');
    expect(everything()).not.toMatch(/SECRETSIGNATURE|secrettoken/);
  });

  it('never calls receive-image when the attestation belongs to another run', async () => {
    github.attestedRun = RUN + 1;
    expect(await run('deploy')).toBe(2);
    expect(subcommands()).not.toContain('receive-image');
  });

  it.each([
    ['another commit', (text: string) => text.replace(SHA_NEWEST, 'd'.repeat(40))],
    ['a broken shape', () => '{"version":2}'],
    ['no JSON', () => 'not json'],
  ])('never calls receive-image for a manifest with %s', async (_name, change) => {
    world.machine.stageManifest = change(world.machine.stageManifest);
    expect(await run('deploy')).toBe(2);
    expect(subcommands()).not.toContain('receive-image');
  });

  it('reports a missing download link without naming one', async () => {
    github.linkStatus = 404;
    expect(await run('deploy')).toBe(1);
    expect(subcommands()).not.toContain('stage-image');
    expect(everything()).not.toMatch(/SECRETSIGNATURE|secrettoken/);
  });

  it('refuses --run when the image comes from a bundle', async () => {
    world.writeConfig({ route53: { profile: 'i' } });
    expect(await run('deploy', '--run', String(RUN))).toBe(2);
    expect(world.output).toContain('imageSource');
    expect(world.hostCalls).toEqual([]);
  });
});
