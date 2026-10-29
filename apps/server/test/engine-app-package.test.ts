import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../../scripts/cloud/deps';
import { engineStartCommand } from '../../../scripts/engine/start-command';
import { runEngineAppCli } from '../../../scripts/engine-app/commands';
import { assertSatisfiesEngines, readNodePin } from '../../../scripts/engine-app/node-pin';
import { buildEnginePackage } from '../../../scripts/engine-app/package';
import type { EnginePackageDeps } from '../../../scripts/engine-app/package';
import { EnginePackageManifest } from '../src/contracts';
import type { SandboxedEnd, SandboxedRun } from '../src/full-test';

vi.mock('../src/full-test/sandbox', async (original) => ({
  ...(await original<typeof import('../src/full-test/sandbox')>()),
  // The fixture runs stay inside the test's own temporary root, too deep for the real sandbox socket frame.
  runDirOf: (root: string, _shortRoot: string, runId: string) =>
    path.join(root, `pmft-${runId.replace(/[^A-Za-z0-9]/g, '').slice(-8)}`),
}));

const COMMIT = 'a'.repeat(40);
const NODE_VERSION = '22.23.4';
const ARCHIVE = Buffer.from('fake node archive');
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const OK: RunResult = { code: 0, stdout: '', stderr: '' };

/** What the commit's checkout holds (the parts the builder reads or copies). */
function writeCheckout(directory: string, archiveSha256: string): void {
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), text);
  };
  write('package.json', JSON.stringify({ name: 'root', private: true, engines: { node: '>=22.12' } }));
  write(
    'package-lock.json',
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'root' }, 'apps/server': {}, 'packages/shared': {} },
    }),
  );
  write('apps/server/package.json', JSON.stringify({ name: '@projectman/server' }));
  write('packages/shared/package.json', JSON.stringify({ name: '@projectman/shared' }));
  write('packages/shared/src/index.ts', 'export {};');
  write('deploy/mac/com.projectman.engine.plist', '<plist/>');
  write('deploy/mac/com.projectman.engine-menubar.plist', '<plist/>');
  write('deploy/mac/com.projectman.administration.plist', '<plist/>');
  write(
    'deploy/mac/app/node.json',
    JSON.stringify({
      version: NODE_VERSION,
      darwinArm64: {
        url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
        sha256: archiveSha256,
      },
    }),
  );
}

class World {
  readonly root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pm-engine-app-test-'));
  readonly out = path.join(this.root, 'out');
  readonly sandboxTmp = path.join(this.root, 'sandbox-tmp');
  readonly commands: string[] = [];
  readonly sandboxRuns: SandboxedRun[] = [];
  /** Commands (substring) the fake sandbox fails. */
  failing: string[] = [];
  tag = '';
  archive = ARCHIVE;

  constructor() {
    for (const directory of [
      this.out,
      this.sandboxTmp,
      path.join(this.root, 'user'),
      path.join(this.root, 'home'),
    ])
      fs.mkdirSync(directory, { recursive: true });
  }

  readonly deps: EnginePackageDeps = {
    run: async (command, args) => {
      this.commands.push([command, ...args].join(' '));
      if (command === 'tar') {
        const nodeDir = args[args.indexOf('-C') + 1]!;
        fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(nodeDir, 'bin/node'), 'node binary');
        return OK;
      }
      if (args.includes('checkout')) writeCheckout(args[1]!, sha256(ARCHIVE));
      if (args.includes('rev-parse') || args.includes('tag')) {
        return { ...OK, stdout: args.includes('tag') ? `${this.tag}\n` : `${COMMIT}\n` };
      }
      return OK;
    },
    fetch: async (url) => {
      this.commands.push(`fetch ${String(url)}`);
      return new Response(this.archive);
    },
    now: () => new Date('2026-10-29T12:00:00.000Z'),
    homeDir: path.join(this.root, 'user'),
    platform: 'darwin',
    arch: 'arm64',
    sandbox: async (run) => this.sandbox(run),
    heavyLock: async () => ({
      release: async () => {
        this.commands.push('unlock');
      },
    }),
    out: () => {},
  };

  async sandbox(run: SandboxedRun): Promise<SandboxedEnd> {
    this.sandboxRuns.push(run);
    this.commands.push(`sandbox ${run.command}`);
    const done = (exitCode: number, output = ''): SandboxedEnd => ({
      exitCode,
      signal: null,
      timedOut: false,
      aborted: false,
      output,
    });
    if (this.failing.some((part) => run.command.includes(part))) return done(1, 'boom');
    const write = (file: string) => {
      fs.mkdirSync(path.dirname(path.join(run.cwd, file)), { recursive: true });
      fs.writeFileSync(path.join(run.cwd, file), 'built');
    };
    if (run.command.includes('npm ci')) write('node_modules/.package-lock.json');
    if (run.command.includes('npm run build')) write('apps/server/dist/index.js');
    if (run.command.includes('bundle-cli.mjs')) write('scripts/engine/cli.js');
    return done(0, run.command.includes('node --version') ? `v${NODE_VERSION}\n` : '');
  }

  build(overrides: Partial<EnginePackageDeps> = {}) {
    return buildEnginePackage(
      { ...this.deps, ...overrides },
      {
        commit: COMMIT,
        outDir: this.out,
        repositoryUrl: 'https://example.invalid/p.git',
        sourceRepo: '/source',
      },
      {
        engineHome: path.join(this.root, 'home'),
        userHome: path.join(this.root, 'user'),
        tmpDir: this.sandboxTmp,
        baseEnv: { PATH: '/usr/bin:/bin' },
      },
    );
  }

  indexOf(part: string): number {
    return this.commands.findIndex((command) => command.includes(part));
  }
}

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(() => {
  fs.rmSync(world.root, { recursive: true, force: true });
});

describe('engine package build', () => {
  it('builds the package layout from the pinned node, in order, in the sandbox', async () => {
    world.tag = 'v2026.10.29';
    const { root, manifest } = await world.build();

    expect(root).toBe(path.join(world.out, COMMIT));
    for (const entry of [
      'engine-package.json',
      'bin/node',
      'package.json',
      'package-lock.json',
      'node_modules/.package-lock.json',
      'packages/shared/src/index.ts',
      'apps/server/package.json',
      'apps/server/dist/index.js',
      'scripts/engine/cli.js',
      'deploy/mac/com.projectman.engine.plist',
      'deploy/mac/com.projectman.engine-menubar.plist',
    ])
      expect(fs.existsSync(path.join(root, entry)), entry).toBe(true);
    expect(fs.existsSync(path.join(root, 'deploy/mac/com.projectman.administration.plist'))).toBe(false);
    expect(fs.statSync(path.join(root, 'bin/node')).mode & 0o111).not.toBe(0);
    const written = EnginePackageManifest.parse(
      JSON.parse(fs.readFileSync(path.join(root, 'engine-package.json'), 'utf8')),
    );
    expect(written).toEqual({
      schemaVersion: 1,
      version: COMMIT,
      tag: 'v2026.10.29',
      node: NODE_VERSION,
      arch: 'arm64',
      builtAt: '2026-10-29T12:00:00.000Z',
    });
    expect(manifest).toEqual(written);

    const order = [
      'depth 1 origin',
      'fetch https://nodejs.org',
      'tar ',
      'npm ci',
      'npm run build',
      'bundle-cli.mjs',
      'npm prune',
      'dist/index.js',
      'sqlite-vec',
      'unlock',
    ];
    const indexes = order.map((part) => world.indexOf(part));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    // The pinned node runs first in every sandboxed step, which is where the native modules get their ABI.
    for (const run of world.sandboxRuns) expect(run.env.PATH).toMatch(/\/pm-engine-app-[^/]+\/node\/bin:/);
    expect(fs.readdirSync(world.out)).toEqual([COMMIT]);
    expect(fs.readdirSync(world.sandboxTmp)).toEqual([]);
  });

  it('records no tag for a commit without a release tag', async () => {
    const { manifest } = await world.build();
    expect(manifest.tag).toBeNull();
  });

  it('refuses a download that differs from its pinned sha256, before anything is installed', async () => {
    world.archive = Buffer.from('another archive');
    await expect(world.build()).rejects.toMatchObject({ exitCode: 2 });
    expect(world.sandboxRuns).toEqual([]);
    expect(fs.readdirSync(world.out)).toEqual([]);
    expect(world.commands.at(-1)).toBe('unlock');
  });

  it('refuses an existing non-empty target before any work', async () => {
    fs.mkdirSync(path.join(world.out, COMMIT));
    fs.writeFileSync(path.join(world.out, COMMIT, 'keep'), 'mine');
    await expect(world.build()).rejects.toMatchObject({ exitCode: 2 });
    expect(world.commands).toEqual([]);
    expect(fs.readFileSync(path.join(world.out, COMMIT, 'keep'), 'utf8')).toBe('mine');
  });

  it('fills an existing empty target', async () => {
    fs.mkdirSync(path.join(world.out, COMMIT));
    await world.build();
    expect(fs.existsSync(path.join(world.out, COMMIT, 'engine-package.json'))).toBe(true);
  });

  it('leaves no unfinished package behind when a step fails', async () => {
    world.failing = ['npm prune'];
    await expect(world.build()).rejects.toThrow(/step failed/);
    expect(fs.readdirSync(world.out)).toEqual([]);
    expect(world.commands.at(-1)).toBe('unlock');
  });

  it('refuses to build away from macOS arm64', async () => {
    await expect(world.build({ arch: 'x64' })).rejects.toMatchObject({ exitCode: 2 });
    expect(world.commands).toEqual([]);
  });
});

describe('engine app command', () => {
  const deps = (build: ReturnType<typeof vi.fn>) => ({
    originUrl: async () => 'https://example.invalid/origin.git',
    sourceRepo: '/source',
    cwd: '/work',
    build,
    out: vi.fn(),
    err: vi.fn(),
  });

  it('builds the package of the commit into the directory and prints where', async () => {
    const build = vi.fn(async () => ({ root: '/out/x' }));
    const io = deps(build);
    expect(await runEngineAppCli(['package', '--commit', COMMIT, '--out', 'pkg'], io)).toBe(0);
    expect(build).toHaveBeenCalledWith({
      commit: COMMIT,
      outDir: '/work/pkg',
      repositoryUrl: 'https://example.invalid/origin.git',
      sourceRepo: '/source',
    });
    expect(io.out).toHaveBeenCalledWith('/out/x');
  });

  it('answers a missing option with the usage and the usage status', async () => {
    const build = vi.fn();
    const io = deps(build);
    expect(await runEngineAppCli(['package', '--commit', COMMIT], io)).toBe(64);
    expect(build).not.toHaveBeenCalled();
    expect(io.err).toHaveBeenCalled();
  });
});

describe('engine start command', () => {
  it('runs the built server under the bundled node in a package and the CLI node in a checkout', () => {
    const dir = fs.mkdtempSync(path.join(world.root, 'start-'));
    expect(engineStartCommand(dir, '/usr/bin/node')).toEqual({
      command: '/usr/bin/node',
      args: [path.join(dir, 'apps/server/dist/index.js')],
    });
    fs.writeFileSync(path.join(dir, 'engine-package.json'), '{}');
    expect(engineStartCommand(dir, '/usr/bin/node')).toEqual({
      command: path.join(dir, 'bin/node'),
      args: [path.join(dir, 'apps/server/dist/index.js')],
    });
  });
});

describe('node pin', () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const pinFile = path.join(repoRoot, 'deploy/mac/app/node.json');

  it('is the nodejs.org archive of a version that satisfies engines.node', () => {
    const engines = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines.node;
    expect(() => assertSatisfiesEngines(readNodePin(pinFile), engines)).not.toThrow();
  });

  it('refuses a version below engines.node', () => {
    expect(() => assertSatisfiesEngines({ ...readNodePin(pinFile), version: '22.11.0' }, '>=22.12')).toThrow(
      /engines/,
    );
  });
});
