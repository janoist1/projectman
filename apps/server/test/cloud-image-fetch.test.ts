import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import type { CloudContext } from '../../../scripts/cloud/context';
import type { CloudDeps, RunResult } from '../../../scripts/cloud/deps';
import { CloudError } from '../../../scripts/cloud/errors';
import {
  CLOUD_IMAGE_JOB,
  cloudImageLaunchCommand,
  runImageFetch,
  type ImageFetchContext,
} from '../../../scripts/cloud/image-fetch';
import { selectedImage } from '../../../scripts/cloud/images';
import { Report } from '../../../scripts/cloud/report';
import { ComputeJobId, ComputeJobOutputPath } from '@projectman/shared';

const REF = 'a1b2c3d4'.repeat(5);
const OTHER_REF = 'f'.repeat(40);
const REPO = 'acme/projectman';
const RUN = 4242;
const RUN_ID = 'manual-a1b2c3d4-20261029120000';
const TITLE = `projectman-job cloud-image ${REF} ${RUN_ID}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const IMAGE_CONFIG = JSON.stringify({
  os: 'linux',
  architecture: 'arm64',
  config: {
    Labels: { 'org.opencontainers.image.revision': REF },
    Env: [`PROJECTMAN_VERSION=${REF}`],
  },
});
const IMAGE_ID = `sha256:${sha256(IMAGE_CONFIG)}`;
const ARCHIVE = 'the exported image archive';

function goodManifest() {
  return {
    version: 1,
    sourceSha: REF,
    images: [
      {
        platform: 'linux/arm64',
        archive: 'linux-arm64.tar',
        archiveSha256: sha256(ARCHIVE),
        archiveBytes: ARCHIVE.length,
        imageId: IMAGE_ID,
      },
    ],
  };
}

/** What GitHub and the artifact say; each test damages one thing. */
interface World {
  originUrl: string;
  branch: string;
  listed: { databaseId: number; displayTitle: string; status: string; createdAt: string }[];
  /** The answers for the run, one per read; the last one repeats. */
  runStates: Record<string, unknown>[];
  manifestText: string;
  archiveText: string | null;
  /** The `runInvocationURI` the attestation shows. */
  attestedRun: string;
  attestFails: string | null;
  archiveConfig: string;
}
const completed = (change: Record<string, unknown> = {}) => ({
  id: RUN,
  path: '.github/workflows/projectman-job.yml',
  event: 'workflow_dispatch',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  display_title: TITLE,
  ...change,
});

let directory: string;
let world: World;
let calls: string[][];
let clock: number;
let sleeps: number[];
let lines: string[];

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'image-fetch-')));
  fs.mkdirSync(path.join(directory, 'repo'));
  world = {
    originUrl: `https://github.com/${REPO}.git`,
    branch: 'main',
    listed: [
      { databaseId: RUN, displayTitle: TITLE, status: 'completed', createdAt: '2026-10-29T12:00:00Z' },
    ],
    runStates: [completed()],
    manifestText: `${JSON.stringify(goodManifest())}\n`,
    archiveText: ARCHIVE,
    attestedRun: `https://github.com/${REPO}/actions/runs/${RUN}/attempts/1`,
    attestFails: null,
    archiveConfig: IMAGE_CONFIG,
  };
  calls = [];
  clock = Date.parse('2026-10-29T12:30:00Z');
  sleeps = [];
  lines = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const out = () => path.join(directory, 'out');

/** A `run` that plays git, gh and tar from `world`; anything else is unknown. */
async function fakeRun(command: string, args: string[]): Promise<RunResult> {
  calls.push([command, ...args]);
  if (command === 'git') return ok(`${world.originUrl}\n`);
  if (command === 'tar')
    return ok(
      args.at(-1) === 'manifest.json'
        ? JSON.stringify([{ Config: `${IMAGE_ID.slice(7)}.json`, RepoTags: [`projectman-cloud:${REF}`] }])
        : world.archiveConfig,
    );
  if (command !== 'gh') return { code: 127, stdout: '', stderr: 'unknown' };
  if (args[0] === 'api' && args[1] === `repos/${REPO}`)
    return ok(JSON.stringify({ default_branch: world.branch }));
  if (args[0] === 'api' && args[1]?.startsWith(`repos/${REPO}/actions/runs/`)) {
    const read = calls.filter((call) => call[1] === 'api' && call[2]?.includes('/actions/runs/')).length;
    return ok(JSON.stringify(world.runStates[Math.min(read, world.runStates.length) - 1]));
  }
  if (args[0] === 'run' && args[1] === 'list') return ok(JSON.stringify(world.listed));
  if (args[0] === 'run' && args[1] === 'download') {
    const bundle = path.join(args[args.indexOf('--dir') + 1]!, 'bundle');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'manifest.json'), world.manifestText);
    if (world.archiveText !== null) fs.writeFileSync(path.join(bundle, 'linux-arm64.tar'), world.archiveText);
    return ok();
  }
  if (args[0] === 'attestation' && args[1] === 'verify') {
    if (world.attestFails && args[2]!.endsWith(world.attestFails))
      return { code: 1, stdout: '', stderr: 'no matching attestation' };
    return ok(
      JSON.stringify([
        { verificationResult: { signature: { certificate: { runInvocationURI: world.attestedRun } } } },
      ]),
    );
  }
  return { code: 1, stdout: '', stderr: 'unexpected gh call' };
}

function context(): ImageFetchContext {
  return {
    deps: {
      run: fakeRun,
      pipe: async () => ok(),
      now: () => new Date(clock),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      repoRoot: path.join(directory, 'repo'),
    },
    report: new Report((line) => lines.push(line)),
  };
}
const fetchImage = (change: { run?: string; dryRun?: boolean; output?: string; ref?: string } = {}) =>
  runImageFetch(context(), {
    ref: change.ref ?? REF,
    output: change.output ?? out(),
    run: change.run,
    dryRun: change.dryRun ?? false,
  });
const ghCalls = (name: string) => calls.filter((call) => call[0] === 'gh' && call[1] === name);

describe('image-fetch', () => {
  it('finds the run, verifies both files and writes a bundle that deploy accepts', async () => {
    await fetchImage();
    const download = ghCalls('run').find((call) => call[2] === 'download')!;
    expect(download).toEqual(
      expect.arrayContaining([String(RUN), '--repo', REPO, '--name', `projectman-job-${RUN_ID}`]),
    );
    const attestations = ghCalls('attestation');
    expect(attestations.map((call) => path.basename(call[3]!))).toEqual(['manifest.json', 'linux-arm64.tar']);
    for (const call of attestations)
      expect(call).toEqual(
        expect.arrayContaining([
          '--cert-identity',
          `https://github.com/${REPO}/.github/workflows/projectman-job.yml@refs/heads/main`,
          '--deny-self-hosted-runners',
        ]),
      );
    expect(fs.readdirSync(out()).sort()).toEqual(['linux-arm64.tar', 'manifest.json']);
    const image = selectedImage(
      {
        config: { deployment: { imageBundle: out() } },
        report: new Report(() => {}),
      } as unknown as CloudContext,
      REF,
    );
    expect(image).toMatchObject({ sourceSha: REF, platform: 'linux/arm64', imageId: IMAGE_ID });
    expect(lines.join('\n')).toContain(
      `imageId=${IMAGE_ID} run=https://github.com/${REPO}/actions/runs/${RUN}`,
    );
  });

  it('never starts a run', async () => {
    await fetchImage();
    expect(calls.filter((call) => call.includes('workflow'))).toEqual([]);
  });

  it('writes the manifest last, after the archive is in place', async () => {
    const renamed: string[] = [];
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      renamed.push(path.basename(String(to)));
      rename(from, to);
    });
    await fetchImage();
    expect(renamed).toEqual(['linux-arm64.tar', 'manifest.json']);
  });

  it('follows a run in progress every 15 seconds', async () => {
    world.runStates = [
      completed({ status: 'queued', conclusion: null }),
      completed({ status: 'in_progress', conclusion: null }),
      completed(),
    ];
    await fetchImage();
    expect(sleeps).toEqual([15_000, 15_000]);
    expect(fs.existsSync(path.join(out(), 'manifest.json'))).toBe(true);
  });

  it('gives up on a run still going after 60 minutes', async () => {
    world.runStates = [completed({ status: 'in_progress', conclusion: null })];
    await expect(fetchImage()).rejects.toThrow('did not finish within 60 minutes');
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(60 * 60 * 1000);
    expect(fs.existsSync(out())).toBe(false);
  });

  it('takes the newest run of the job at this commit and ignores the others', async () => {
    world.listed = [
      { databaseId: 1, displayTitle: TITLE, status: 'completed', createdAt: '2026-10-28T12:00:00Z' },
      { databaseId: RUN, displayTitle: TITLE, status: 'completed', createdAt: '2026-10-29T12:00:00Z' },
      {
        databaseId: 3,
        displayTitle: `projectman-job cloud-image ${OTHER_REF} ${RUN_ID}`,
        status: 'completed',
        createdAt: '2026-10-30T12:00:00Z',
      },
      { databaseId: 4, displayTitle: 'merge-check', status: 'completed', createdAt: '2026-10-31T12:00:00Z' },
    ];
    await fetchImage();
    expect(calls.some((call) => call.includes(`repos/${REPO}/actions/runs/${RUN}`))).toBe(true);
  });

  it('uses the run it is given without searching', async () => {
    await fetchImage({ run: String(RUN) });
    expect(ghCalls('run').some((call) => call[2] === 'list')).toBe(false);
    expect(fs.existsSync(path.join(out(), 'manifest.json'))).toBe(true);
  });

  it('refuses when there is no run and names the command that starts one', async () => {
    world.listed = [];
    const error = await fetchImage().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ exitCode: 2 });
    const message = (error as Error).message;
    expect(message).toContain(cloudImageLaunchCommand(REPO, 'main', REF, new Date(clock)));
    expect(message).toContain(`-f commit=${REF} -f runs_on=${CLOUD_IMAGE_JOB.runsOn}`);
    // Without --bootstrap the builder does not know linux/arm64 yet (the first run, 40971861471, failed so).
    expect(CLOUD_IMAGE_JOB.command).toContain(
      'docker buildx create --name projectman --driver docker-container --bootstrap',
    );
    expect(ghCalls('workflow')).toEqual([]);
    expect(fs.existsSync(out())).toBe(false);
  });

  it.each([
    ['another workflow', { path: '.github/workflows/merge-check.yml' }],
    ['a run not started by hand', { event: 'push' }],
    ['another branch', { head_branch: 'pm-check/PM-1' }],
    ['a failed run', { conclusion: 'failure' }],
    ['another job', { display_title: `projectman-job other ${REF} ${RUN_ID}` }],
    ['another commit', { display_title: `projectman-job cloud-image ${OTHER_REF} ${RUN_ID}` }],
    ['a title that is no job title', { display_title: 'merge-check' }],
  ])('refuses %s, naming the run, and leaves no output', async (_name, change) => {
    world.runStates = [completed(change)];
    await expect(fetchImage()).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(`actions/runs/${RUN}`),
    });
    expect(ghCalls('run').some((call) => call[2] === 'download')).toBe(false);
    expect(fs.existsSync(out())).toBe(false);
  });

  it.each(['manifest.json', 'linux-arm64.tar'])('refuses when the attestation of %s fails', async (file) => {
    world.attestFails = file;
    await expect(fetchImage()).rejects.toMatchObject({ exitCode: 2 });
    expect(fs.existsSync(out())).toBe(false);
  });

  it('refuses an attestation that belongs to another run', async () => {
    world.attestedRun = `https://github.com/${REPO}/actions/runs/${RUN + 1}/attempts/1`;
    await expect(fetchImage()).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('not from run'),
    });
    expect(fs.existsSync(out())).toBe(false);
  });

  it.each([
    [
      'a manifest of another commit',
      () => (world.manifestText = JSON.stringify({ ...goodManifest(), sourceSha: OTHER_REF })),
    ],
    ['an archive that differs from the manifest', () => (world.archiveText = `${ARCHIVE} tampered`)],
    ['a manifest that is not valid', () => (world.manifestText = '{"version":2}')],
    ['a missing archive', () => (world.archiveText = null)],
    ['an archive of another image', () => (world.archiveConfig = IMAGE_CONFIG.replace('arm64', 'amd64'))],
  ])('refuses %s and leaves no output', async (_name, damage) => {
    damage();
    await expect(fetchImage()).rejects.toBeInstanceOf(CloudError);
    expect(fs.existsSync(out())).toBe(false);
  });

  it('only checks the run and its origin in a dry run', async () => {
    await fetchImage({ dryRun: true });
    expect(ghCalls('run').some((call) => call[2] === 'download')).toBe(false);
    expect(ghCalls('attestation')).toEqual([]);
    expect(fs.existsSync(out())).toBe(false);
    expect(lines.join('\n')).toContain('dry-run');
  });

  it('refuses an origin that is not on GitHub before asking GitHub', async () => {
    world.originUrl = 'https://gitlab.com/acme/projectman.git';
    await expect(fetchImage()).rejects.toMatchObject({ exitCode: 2 });
    expect(calls.filter((call) => call[0] === 'gh')).toEqual([]);
  });

  it('refuses an existing output before any call', async () => {
    fs.mkdirSync(out());
    await expect(fetchImage()).rejects.toMatchObject({ exitCode: 2 });
    expect(calls).toEqual([]);
  });

  it.each([
    ['a bad ref', { ref: 'main' }],
    ['a run that is no number', { run: 'latest' }],
  ])('rejects %s as bad usage', async (_name, change) => {
    await expect(fetchImage(change)).rejects.toMatchObject({ exitCode: 64 });
    expect(calls).toEqual([]);
  });
});

describe('configless commands', () => {
  function cliDeps(run: CloudDeps['run']): CloudDeps {
    const home = path.join(directory, 'home-without-configuration');
    fs.mkdirSync(home);
    return {
      ...context().deps,
      run,
      homeDir: home,
      out: (line: string) => lines.push(line),
      err: (line: string) => lines.push(line),
    } as unknown as CloudDeps;
  }

  it('runs image-fetch without a cloud configuration file', async () => {
    const code = await runCloud(['image-fetch', '--ref', REF, '--out', out(), '--dry-run'], cliDeps(fakeRun));
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('dry-run');
  });

  it('runs image-build without a cloud configuration file', async () => {
    const run: CloudDeps['run'] = async (command, args) => {
      if (command === 'git') return ok(args.includes('rev-parse') ? `${REF}\n` : '');
      return ok('Driver: docker-container\nPlatforms: linux/arm64\n');
    };
    expect(await runCloud(['image-build', '--ref', REF, '--out', out(), '--dry-run'], cliDeps(run))).toBe(0);
    expect(fs.existsSync(out())).toBe(false);
  });

  it('still needs the configuration for a command that is not configless', async () => {
    expect(await runCloud(['status'], cliDeps(fakeRun))).toBe(2);
  });
});

it('keeps the cloud image job inside the shared patterns', () => {
  expect(ComputeJobId.safeParse(CLOUD_IMAGE_JOB.job).success).toBe(true);
  for (const output of CLOUD_IMAGE_JOB.outputs)
    expect(ComputeJobOutputPath.safeParse(output).success).toBe(true);
});
