import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../../scripts/cloud/deps';
import type { ComputeJobContext } from '../../../scripts/cloud/compute-job-run';
import { Report } from '../../../scripts/cloud/report';
import { runEngineAppCli } from '../../../scripts/engine-app/commands';
import { fetchEngineApp } from '../../../scripts/engine-app/fetch';
import type { EngineAppFetchRequest } from '../../../scripts/engine-app/fetch';

const COMMIT = 'a1b2c3d4'.repeat(5);
const OTHER_COMMIT = 'f'.repeat(40);
const REPO = 'acme/projectman';
const RUN = 4242;
const RUN_ID = 'manual-a1b2c3d4-20261029120000';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ZIP = 'the zipped app';
const DMG = 'the disk image of the app';
const APP = 'projectman motor.app';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const failed: RunResult = { code: 1, stdout: '', stderr: 'no' };

/** What GitHub, the artifact and the unpacked app say; each test damages one thing. */
interface World {
  listed: { databaseId: number; displayTitle: string; status: string; createdAt: string }[];
  run: Record<string, unknown>;
  artifacts: Record<string, unknown>[];
  manifest: Record<string, unknown>;
  zipText: string;
  /** The `version` of the `engine-package.json` inside the app; null when it has none. */
  packageVersion: string | null;
  attestFails: string | null;
  codesignFails: boolean;
  openFails: boolean;
}

const title = `projectman-job engine-app ${COMMIT} ${RUN_ID}`;
const goodManifest = () => ({
  schemaVersion: 1,
  tag: null,
  version: COMMIT,
  bundleVersion: '0',
  minimumMacOS: '13.0',
  arch: 'arm64',
  teamId: '',
  zip: { name: 'projectman-motor.zip', sha256: sha256(ZIP), size: ZIP.length },
  dmg: { name: 'projectman-motor.dmg', sha256: sha256(DMG), size: DMG.length },
});

let directory: string;
let world: World;
let calls: string[][];
let lines: string[];

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-app-fetch-')));
  fs.mkdirSync(path.join(directory, 'repo'));
  world = {
    listed: [
      { databaseId: RUN, displayTitle: title, status: 'completed', createdAt: '2026-10-29T12:00:00Z' },
    ],
    run: {
      id: RUN,
      path: '.github/workflows/projectman-job.yml',
      event: 'workflow_dispatch',
      head_branch: 'main',
      status: 'completed',
      conclusion: 'success',
      display_title: title,
    },
    artifacts: [{ id: 77, name: `projectman-job-${RUN_ID}`, size_in_bytes: 1000, expired: false }],
    manifest: goodManifest(),
    zipText: ZIP,
    packageVersion: COMMIT,
    attestFails: null,
    codesignFails: false,
    openFails: false,
  };
  calls = [];
  lines = [];
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

const out = () => path.join(directory, 'out');
const called = (command: string, first?: string) =>
  calls.filter((call) => call[0] === command && (first === undefined || call[1] === first));

/** A `run` that plays git, gh, ditto, codesign and open from `world`. */
async function fakeRun(command: string, args: string[]): Promise<RunResult> {
  calls.push([command, ...args]);
  if (command === 'git') return ok(`https://github.com/${REPO}.git\n`);
  if (command === 'ditto') {
    const engine = path.join(args[3]!, APP, 'Contents/Resources/engine');
    fs.mkdirSync(engine, { recursive: true });
    if (world.packageVersion !== null)
      fs.writeFileSync(
        path.join(engine, 'engine-package.json'),
        JSON.stringify({
          schemaVersion: 1,
          version: world.packageVersion,
          tag: null,
          node: '22.23.4',
          arch: 'arm64',
          builtAt: '2026-10-29T12:00:00.000Z',
        }),
      );
    return ok();
  }
  if (command === 'codesign') return world.codesignFails ? failed : ok();
  if (command === 'open') return world.openFails ? failed : ok();
  if (command !== 'gh') return { code: 127, stdout: '', stderr: 'unknown' };
  if (args[0] === 'api' && args[1] === `repos/${REPO}`) return ok(JSON.stringify({ default_branch: 'main' }));
  if (args[0] === 'api' && args[1]?.startsWith(`repos/${REPO}/actions/runs/${RUN}/artifacts`))
    return ok(JSON.stringify({ artifacts: world.artifacts }));
  if (args[0] === 'api' && args[1] === `repos/${REPO}/actions/runs/${RUN}`)
    return ok(JSON.stringify(world.run));
  if (args[0] === 'run' && args[1] === 'list') return ok(JSON.stringify(world.listed));
  if (args[0] === 'run' && args[1] === 'download') {
    const app = path.join(args[args.indexOf('--dir') + 1]!, 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'projectman-motor.json'), `${JSON.stringify(world.manifest)}\n`);
    fs.writeFileSync(path.join(app, 'projectman-motor.zip'), world.zipText);
    return ok();
  }
  if (args[0] === 'attestation' && args[1] === 'verify') {
    if (world.attestFails && args[2]!.endsWith(world.attestFails)) return failed;
    return ok(
      JSON.stringify([
        {
          verificationResult: {
            signature: {
              certificate: {
                runInvocationURI: `https://github.com/${REPO}/actions/runs/${RUN}/attempts/1`,
              },
            },
          },
        },
      ]),
    );
  }
  return { code: 1, stdout: '', stderr: 'unexpected gh call' };
}

function context(): ComputeJobContext {
  return {
    deps: {
      run: fakeRun,
      pipe: async () => ok(),
      now: () => new Date('2026-10-29T12:30:00Z'),
      sleep: async () => {},
      repoRoot: path.join(directory, 'repo'),
    },
    report: new Report((line) => lines.push(line)),
  };
}
const fetchApp = (change: Partial<EngineAppFetchRequest> = {}) =>
  fetchEngineApp(context(), { commit: COMMIT, out: out(), dryRun: false, open: false, ...change });

describe('engine-app fetch', () => {
  it('verifies the run, the manifest and the zip and the app, and leaves the app, the manifest and the zip but no dmg', async () => {
    const app = await fetchApp();
    expect(app).toBe(path.join(out(), APP));
    expect(fs.readdirSync(out()).sort()).toEqual([APP, 'projectman-motor.json', 'projectman-motor.zip']);
    const download = called('gh', 'run').find((call) => call[2] === 'download')!;
    expect(download).toEqual(
      expect.arrayContaining([String(RUN), '--repo', REPO, '--name', `projectman-job-${RUN_ID}`]),
    );
    expect(called('gh', 'attestation').map((call) => path.basename(call[3]!))).toEqual([
      'projectman-motor.json',
      'projectman-motor.zip',
    ]);
    expect(called('codesign')).toEqual([['codesign', '--verify', '--deep', '--strict', app]]);
    expect(called('open')).toEqual([]);
    expect(lines.join('\n')).toContain(`run=https://github.com/${REPO}/actions/runs/${RUN}`);
  });

  it('opens the unpacked app with --open', async () => {
    const app = await fetchApp({ open: true });
    expect(called('open')).toEqual([['open', app]]);
  });

  it('keeps the app and says where it is when open fails', async () => {
    world.openFails = true;
    await expect(fetchApp({ open: true })).rejects.toThrow(`the app is at ${path.join(out(), APP)}`);
    expect(fs.existsSync(path.join(out(), APP))).toBe(true);
  });

  it('refuses when there is no run and names the command that starts one', async () => {
    world.listed = [];
    const error = await fetchApp().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ exitCode: 2 });
    expect((error as Error).message).toContain('gh workflow run projectman-job.yml');
    expect((error as Error).message).toContain('-f job=engine-app ');
    expect(called('gh', 'workflow')).toEqual([]);
    expect(fs.existsSync(out())).toBe(false);
  });

  it('stops at the run with --dry-run and downloads nothing', async () => {
    await fetchApp({ dryRun: true });
    expect(called('gh', 'run').some((call) => call[2] === 'download')).toBe(false);
    expect(fs.existsSync(out())).toBe(false);
    expect(lines.join('\n')).toContain('dry-run');
  });

  it('uses the run it is given without searching', async () => {
    await fetchApp({ run: RUN });
    expect(called('gh', 'run').some((call) => call[2] === 'list')).toBe(false);
  });

  it.each([
    ['an attestation that fails', () => (world.attestFails = 'projectman-motor.zip'), 'attestation'],
    [
      'a manifest of another commit',
      () => (world.manifest = { ...goodManifest(), version: OTHER_COMMIT }),
      'another commit',
    ],
    ['a manifest that is no manifest', () => (world.manifest = { version: COMMIT }), 'manifest is invalid'],
    [
      'a zip that differs from the manifest',
      () => (world.zipText = 'a different zip'),
      'projectman-motor.zip hash or size differs',
    ],
    [
      'a zip size that differs from the manifest',
      () => (world.manifest = { ...goodManifest(), zip: { ...goodManifest().zip, size: 1 } }),
      'projectman-motor.zip hash or size differs',
    ],
    ['an app whose signature fails', () => (world.codesignFails = true), 'code signature'],
    [
      'an app with the engine package of another commit',
      () => (world.packageVersion = OTHER_COMMIT),
      'not of this commit',
    ],
    ['an app without an engine package', () => (world.packageVersion = null), 'not of this commit'],
  ])('refuses %s and removes the output', async (_name, damage, message) => {
    damage();
    await expect(fetchApp()).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(message),
    });
    expect(fs.existsSync(out())).toBe(false);
    expect(called('open')).toEqual([]);
  });

  it('refuses a run of another job and downloads nothing', async () => {
    world.run = { ...world.run, display_title: `projectman-job cloud-image ${COMMIT} ${RUN_ID}` };
    await expect(fetchApp({ run: RUN })).rejects.toMatchObject({ exitCode: 2 });
    expect(called('gh', 'run').some((call) => call[2] === 'download')).toBe(false);
    expect(fs.existsSync(out())).toBe(false);
  });
});

describe('engine-app fetch command', () => {
  const io = (fetch: ReturnType<typeof vi.fn>) => ({
    originUrl: async () => 'https://example.invalid/origin.git',
    sourceRepo: '/source',
    cwd: '/work',
    build: vi.fn(),
    fetch,
    out: vi.fn(),
    err: vi.fn(),
  });

  it('passes the options on and prints the path of the app last', async () => {
    const fetch = vi.fn(async () => '/work/app/projectman motor.app');
    const deps = io(fetch);
    const argv = ['fetch', '--commit', COMMIT, '--out', 'app', '--run', '77', '--dry-run', '--open'];
    expect(await runEngineAppCli(argv, deps)).toBe(0);
    expect(fetch).toHaveBeenCalledWith({
      commit: COMMIT,
      out: '/work/app',
      run: 77,
      dryRun: true,
      open: true,
    });
    expect(deps.out).toHaveBeenLastCalledWith('/work/app/projectman motor.app');
  });

  it.each([
    ['no commit', ['fetch', '--out', 'app']],
    ['a commit that is no full sha', ['fetch', '--commit', 'main', '--out', 'app']],
    ['no output directory', ['fetch', '--commit', COMMIT]],
    ['a run that is no number', ['fetch', '--commit', COMMIT, '--out', 'app', '--run', 'latest']],
    ['an unknown option', ['fetch', '--commit', COMMIT, '--out', 'app', '--force']],
    ['a repeated option', ['fetch', '--commit', COMMIT, '--commit', COMMIT, '--out', 'app']],
  ])('answers %s with the usage status', async (_name, argv) => {
    const fetch = vi.fn();
    const deps = io(fetch);
    expect(await runEngineAppCli(argv, deps)).toBe(64);
    expect(fetch).not.toHaveBeenCalled();
    expect(deps.err).toHaveBeenCalled();
  });
});
