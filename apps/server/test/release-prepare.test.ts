import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../scripts/cloud/config';
import type { CloudContext } from '../../../scripts/cloud/context';
import type { RunOptions, RunResult } from '../../../scripts/cloud/deps';
import { Report } from '../../../scripts/cloud/report';
import { prepareHybridRelease } from '../../../scripts/release/prepare';
import type { PrepareOptions, PreparedHybridRelease } from '../../../scripts/release/prepare';
import { candidateMarkerFile, preparedHybridReleaseSchema } from '../../../scripts/release/receipt';
import { defaultSessionTmpRoot, sharedClaudeTmpRoots } from '../src/engine-host';
import type { SandboxedEnd, SandboxedRun } from '../src/full-test';
import { CloudWorld } from './helpers/fake-aws';

vi.mock('../src/full-test/sandbox', async (original) => ({
  ...(await original<typeof import('../src/full-test/sandbox')>()),
  // No real sandbox sockets here: keep the fixture runs inside the test's own temporary root, which is
  // too deep for the socket frame of the real `runDirOf`.
  runDirOf: (root: string, _shortRoot: string, runId: string) =>
    path.join(root, `pmft-${runId.replace(/[^A-Za-z0-9]/g, '').slice(-8)}`),
}));

const execFileAsync = promisify(execFile);
const FAKE_URL = 'https://example.invalid/projectman.git';
const RELEASE_ID = 'rel_abc123';
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const FORBIDDEN_COMMANDS = [
  'launchctl',
  'aws',
  'ssh',
  'scp',
  'gh',
  'cloudflared',
  'curl',
  'npm',
  'node',
  'sh',
  'bash',
];

type Scenario =
  | 'ok'
  | 'single-platform'
  | 'wrong-arch'
  | 'fake-revision'
  | 'native-broken'
  | 'helper-broken'
  | 'smoke-timeout'
  | 'archive-changes'
  | 'manifest-changes'
  | 'sandbox-missing'
  | 'sandbox-timeout'
  | 'engine-native-broken'
  | 'engine-entry-broken'
  | 'lockfile-changes'
  | 'abort-in-smoke';

/** The tests set the repositories up synchronously; the preparation itself runs git through its own deps. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

interface Recorded {
  command: string;
  settings: {
    network: { allowedDomains: string[]; allowLocalBinding: boolean };
    filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
  };
  settingsFile: string;
  env: Record<string, string>;
  cwd: string;
}

class ReleaseWorld {
  readonly cloud = new CloudWorld();
  readonly home = this.cloud.home;
  readonly remote = path.join(this.home, 'remote');
  readonly source = path.join(this.home, 'source');
  readonly userHome = path.join(this.home, 'user');
  readonly engineHome = path.join(this.home, 'engine-home');
  readonly outParent = path.join(this.home, 'out');
  readonly output = path.join(this.outParent, 'release');
  readonly engineReleases = path.join(this.home, 'engine-releases');
  readonly sandboxTmp = path.join(this.home, 't');
  readonly lines: string[] = [];
  readonly calls: string[][] = [];
  readonly sandboxRuns: Recorded[] = [];
  readonly events: string[] = [];
  readonly dockerRuns: string[][] = [];
  readonly removed: string[] = [];
  readonly interrupts = new Set<() => void>();
  readonly abort = new AbortController();
  scenario: Scenario = 'ok';
  commit = '';
  newer = '';
  private readonly images = new Map<string, 'amd64' | 'arm64'>();

  constructor() {
    for (const directory of [this.source, this.userHome, this.engineHome, this.outParent, this.sandboxTmp])
      fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(this.engineHome, 'db.sqlite'), 'live data');
    fs.writeFileSync(path.join(this.engineHome, 'machine.key'), 'machine key');
    this.makeRemote();
    this.cloud.writeConfig({ repository: { url: FAKE_URL } });
  }

  private makeRemote(): void {
    fs.mkdirSync(this.remote, { recursive: true });
    git(this.remote, 'init', '--quiet', '-b', 'main');
    git(this.remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(this.remote, file)), { recursive: true });
      fs.writeFileSync(path.join(this.remote, file), text);
    };
    write('.gitignore', 'node_modules/\napps/server/dist/\n');
    write('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*'] }));
    write(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { name: 'root' }, 'apps/server': { name: '@projectman/server' } },
      }),
    );
    write(
      'apps/server/package.json',
      JSON.stringify({ name: '@projectman/server', scripts: { build: 'true' } }),
    );
    write('deploy/cloud/Dockerfile', 'FROM scratch\n');
    git(this.remote, 'add', '-A');
    git(this.remote, 'commit', '--quiet', '-m', 'release commit');
    this.commit = git(this.remote, 'rev-parse', 'HEAD').trim();
    write('later.txt', 'main moved ahead\n');
    git(this.remote, 'add', '-A');
    git(this.remote, 'commit', '--quiet', '-m', 'main moved ahead');
    this.newer = git(this.remote, 'rev-parse', 'HEAD').trim();
  }

  cleanup(): void {
    this.cloud.cleanup();
  }

  get candidate(): string {
    return path.join(this.engineReleases, `${RELEASE_ID}-${this.commit}`);
  }

  get receiptFile(): string {
    return path.join(this.output, 'preparation.json');
  }

  input(overrides: Record<string, string> = {}) {
    return {
      releaseId: RELEASE_ID,
      commit: this.commit,
      outputDir: this.output,
      engineReleasesDir: this.engineReleases,
      ...overrides,
    };
  }

  context(): CloudContext {
    return {
      deps: {
        ...this.cloud.deps(),
        run: (command, args, options) => this.run(command, args, options),
        pipe: async () => ({ code: 0, stdout: '', stderr: '' }),
        onInterrupt: (handler) => {
          this.interrupts.add(handler);
          return () => this.interrupts.delete(handler);
        },
        repoRoot: this.source,
      },
      config: loadConfig(this.cloud.configFile, this.home),
      report: new Report((line) => this.lines.push(line)),
      secretsDir: this.cloud.secretsDir,
      envFile: this.cloud.envFile,
    };
  }

  options(overrides: PrepareOptions = {}): PrepareOptions {
    return {
      engineHome: this.engineHome,
      userHome: this.userHome,
      tmpDir: this.sandboxTmp,
      baseEnv: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        CLOUDFLARE_API_TOKEN: 'cf-secret',
        GH_TOKEN: 'gh-secret',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        PROJECTMAN_HOME: this.engineHome,
        PROJECTMAN_SKIP_PTY_TESTS: '1',
      },
      sandbox: (run) => this.sandbox(run),
      heavyLock: async () => {
        this.events.push('lock');
        return {
          release: async () => {
            this.events.push('unlock');
          },
        };
      },
      ...overrides,
    };
  }

  prepare(overrides: PrepareOptions = {}, input = this.input()): Promise<PreparedHybridRelease> {
    return prepareHybridRelease(this.context(), input, this.options(overrides));
  }

  /** What the live engine's home holds: nothing may change there. */
  engineHomeState(): string {
    return fs
      .readdirSync(this.engineHome)
      .sort()
      .map((name) => `${name}:${sha256(fs.readFileSync(path.join(this.engineHome, name)))}`)
      .join('\n');
  }

  private config(arch: 'amd64' | 'arm64'): string {
    return JSON.stringify({
      os: 'linux',
      architecture: arch,
      config: {
        Labels: { 'org.opencontainers.image.revision': this.commit },
        Env: [`PROJECTMAN_VERSION=${this.commit}`],
      },
    });
  }

  private imageId(arch: 'amd64' | 'arm64'): string {
    return `sha256:${sha256(this.config(arch))}`;
  }

  private async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push([command, ...args]);
    this.events.push('run');
    if (options.signal?.aborted) return { code: 130, stdout: '', stderr: '' };
    if (command === 'git') return this.git(args, options);
    if (command === 'tar') return this.tar(args);
    if (command === 'docker') return this.docker(args);
    return { code: 127, stdout: '', stderr: `fake: no ${command}` };
  }

  private async git(args: string[], options: RunOptions): Promise<RunResult> {
    const real = args.map((arg) => (arg === FAKE_URL ? this.remote : arg));
    try {
      const { stdout, stderr } = await execFileAsync('git', real, {
        env: { ...GIT_ENV, ...options.env },
        maxBuffer: 10_000_000,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  }

  private tar(args: string[]): RunResult {
    const file = args[1]!;
    const arch = fs.readFileSync(file, 'utf8').trim().split('/').at(-1) as 'amd64' | 'arm64';
    const config = this.config(arch);
    const stdout =
      args[2] === 'manifest.json'
        ? JSON.stringify([
            { Config: `${sha256(config)}.json`, RepoTags: [`projectman-cloud:${this.commit}`] },
          ])
        : config;
    return { code: 0, stdout, stderr: '' };
  }

  private docker(args: string[]): RunResult {
    const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'buildx' && args[1] === 'inspect')
      return ok(
        `Driver: docker-container\nPlatforms: ${this.scenario === 'single-platform' ? 'linux/amd64' : 'linux/amd64, linux/arm64'}\n`,
      );
    if (args[0] === 'buildx' && args[1] === 'build') {
      const platform = args[args.indexOf('--platform') + 1]!;
      const arch = platform.split('/')[1] as 'amd64' | 'arm64';
      fs.writeFileSync(args[args.indexOf('--output') + 1]!.replace('type=docker,dest=', ''), platform);
      fs.writeFileSync(
        args[args.indexOf('--metadata-file') + 1]!,
        JSON.stringify({ 'containerimage.config.digest': this.imageId(arch) }),
      );
      this.images.set(this.imageId(arch), arch);
      return ok();
    }
    if (args[0] === 'load') return ok();
    if (args[0] === 'image' && args[1] === 'inspect') {
      const arch = this.images.get(args[2]!);
      if (!arch) return { code: 1, stdout: '', stderr: 'No such image' };
      const parsed = JSON.parse(this.config(arch));
      return ok(JSON.stringify([{ Id: args[2], Os: 'linux', Architecture: arch, Config: parsed.config }]));
    }
    if (args[0] === 'rm') {
      this.removed.push(args.at(-1)!);
      return ok();
    }
    if (args[0] === 'run') return this.smoke(args);
    return { code: 1, stdout: '', stderr: `fake docker: unexpected ${args.join(' ')}` };
  }

  private smoke(args: string[]): RunResult {
    this.dockerRuns.push(args);
    const platform = args[args.indexOf('--platform') + 1] as 'linux/amd64' | 'linux/arm64';
    const arch = platform === 'linux/amd64' ? 'x64' : 'arm64';
    const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });
    switch (this.scenario) {
      case 'native-broken':
        return fail('Error: Cannot find module better_sqlite3.node');
      case 'helper-broken':
        return fail('litestream: exec format error');
      case 'smoke-timeout':
        return { code: 124, stdout: '', stderr: '' };
      case 'archive-changes':
        fs.appendFileSync(path.join(this.output, 'images', 'linux-amd64.tar'), 'tamper');
        break;
      case 'manifest-changes':
        fs.appendFileSync(path.join(this.output, 'images', 'manifest.json'), ' ');
        break;
      case 'abort-in-smoke':
        this.abort.abort();
        return { code: 130, stdout: '', stderr: '' };
      default:
        break;
    }
    const proof = {
      native: {
        arch: this.scenario === 'wrong-arch' && platform === 'linux/arm64' ? 'x64' : arch,
        node: 'v22.0.0',
        sqlite: '3.46.0',
        rows: 1,
      },
      helpers: { cloudflared: '2024.9.1', litestream: 'v0.3.13', restic: 'restic 0.17.1' },
      setup: { needsSetup: true },
      revision: this.scenario === 'fake-revision' ? 'f'.repeat(40) : this.commit,
    };
    return { code: 0, stdout: `noise\nSMOKE_RESULT ${JSON.stringify(proof)}\n`, stderr: '' };
  }

  private async sandbox(run: SandboxedRun): Promise<SandboxedEnd> {
    this.events.push('sandbox');
    this.sandboxRuns.push({
      command: run.command,
      settings: JSON.parse(fs.readFileSync(run.settings, 'utf8')),
      settingsFile: run.settings,
      env: run.env,
      cwd: run.cwd,
    });
    const end = (overrides: Partial<SandboxedEnd> = {}): SandboxedEnd => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      output: '',
      ...overrides,
    });
    if (this.scenario === 'sandbox-missing')
      return end({ exitCode: null, spawnError: new Error('srt not found') });
    if (this.scenario === 'sandbox-timeout') return end({ exitCode: null, timedOut: true });
    if (run.command.includes('npm ci')) {
      for (const directory of ['node_modules', 'apps/server/node_modules'])
        fs.mkdirSync(path.join(run.cwd, directory), { recursive: true });
      fs.writeFileSync(path.join(run.cwd, 'node_modules', '.package-lock.json'), '{"packages":{}}');
    } else if (run.command.includes('npm run build')) {
      fs.mkdirSync(path.join(run.cwd, 'apps/server/dist'), { recursive: true });
      fs.writeFileSync(path.join(run.cwd, 'apps/server/dist/index.js'), 'console.log("server")');
      if (this.scenario === 'lockfile-changes')
        fs.appendFileSync(path.join(run.cwd, 'package-lock.json'), '\n');
    } else if (this.scenario === 'engine-native-broken' && run.command.includes('better-sqlite3')) {
      return end({ exitCode: 1, output: 'Error: Could not locate the bindings file' });
    } else if (this.scenario === 'engine-entry-broken' && run.command.includes('PROJECTMAN_MODE=engine')) {
      return end({ exitCode: 1, output: 'Error [ERR_MODULE_NOT_FOUND]' });
    }
    return end();
  }
}

let world: ReleaseWorld;
beforeEach(() => {
  world = new ReleaseWorld();
});
afterEach(() => world.cleanup());

/** Nothing outside the preparation's own directories happened: no deploy, launchctl, cloud or engine-home change. */
function expectNoSideEffects(engineHomeBefore: string) {
  const commands = world.calls.map((call) => call[0]!);
  for (const forbidden of FORBIDDEN_COMMANDS) expect(commands).not.toContain(forbidden);
  const docker = world.calls.filter((call) => call[0] === 'docker').map((call) => call[1]);
  for (const subcommand of docker) expect(['buildx', 'load', 'image', 'run', 'rm']).toContain(subcommand);
  expect(world.engineHomeState()).toBe(engineHomeBefore);
}

describe('prepareHybridRelease', () => {
  it('prepares the exact commit although main moved ahead, and writes an immutable receipt last', async () => {
    const before = world.engineHomeState();
    const receipt = await world.prepare();
    expect(receipt).toMatchObject({ version: 1, releaseId: RELEASE_ID, commit: world.commit });
    expect(world.commit).not.toBe(world.newer);
    expect(fs.existsSync(path.join(world.candidate, 'later.txt'))).toBe(false);
    expect(git(world.candidate, 'rev-parse', 'HEAD').trim()).toBe(world.commit);
    expect(git(world.candidate, 'status', '--porcelain', '--untracked-files=all').trim()).toBe('');
    expect(fs.existsSync(path.join(world.candidate, 'node_modules', '.package-lock.json'))).toBe(true);
    expect(fs.existsSync(path.join(world.candidate, 'apps/server/dist/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(world.output, 'build-source'))).toBe(false);

    const manifestFile = path.join(world.output, 'images', 'manifest.json');
    expect(receipt.manifestPath).toBe(manifestFile);
    expect(receipt.manifestSha256).toBe(sha256(fs.readFileSync(manifestFile)));
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
      sourceSha: string;
      images: { platform: string; imageId: string }[];
    };
    expect(manifest.sourceSha).toBe(world.commit);
    expect(receipt.smoke.map((entry) => [entry.platform, entry.imageId]).sort()).toEqual(
      manifest.images.map((image) => [image.platform, image.imageId]).sort(),
    );
    expect(new Set(receipt.smoke.map((entry) => entry.platform))).toEqual(
      new Set(['linux/amd64', 'linux/arm64']),
    );
    for (const entry of receipt.smoke)
      expect(entry).toMatchObject({ nativeModules: true, helpers: true, cloudServer: true });
    expect(receipt.engine).toEqual({
      root: world.candidate,
      lockfileSha256: sha256(fs.readFileSync(path.join(world.candidate, 'package-lock.json'))),
    });

    expect(preparedHybridReleaseSchema.parse(JSON.parse(fs.readFileSync(world.receiptFile, 'utf8')))).toEqual(
      receipt,
    );
    expect(fs.statSync(world.receiptFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(world.output).mode & 0o777).toBe(0o700);
    expect(world.events[0]).toBe('lock');
    expect(world.events.at(-1)).toBe('unlock');
    expectNoSideEffects(before);
  });

  it('builds and smokes each image by its ID in a disposable, closed container', async () => {
    await world.prepare();
    expect(world.dockerRuns).toHaveLength(2);
    for (const args of world.dockerRuns) {
      const joined = args.slice(0, args.indexOf('-c'));
      expect(joined).toEqual(
        expect.arrayContaining(['--network', 'none', '--pull', 'never', '--read-only', '--rm']),
      );
      expect(joined).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--user', '10001:10001']));
      expect(joined).toEqual(expect.arrayContaining(['--entrypoint', '/bin/bash']));
      for (const forbidden of [
        '-v',
        '--volume',
        '--mount',
        '-p',
        '--publish',
        '-e',
        '--env',
        '--env-file',
        '--privileged',
      ])
        expect(joined).not.toContain(forbidden);
      expect(joined).not.toContain('--network=host');
      expect(joined.at(-1)).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(args.at(-1)).toContain('/api/setup');
      expect(args.at(-1)).not.toMatch(/claude|codex|gemini/);
    }
    // Every throwaway container is removed by name, success or not.
    const names = world.dockerRuns.map((args) => args[args.indexOf('--name') + 1]);
    expect(world.removed.sort()).toEqual(names.sort());
  });

  it('never fetches or uses anything but the exact commit for the builder and the candidate', async () => {
    await world.prepare();
    const fetches = world.calls.filter((call) => call[0] === 'git' && call.includes('fetch'));
    expect(fetches).toHaveLength(2);
    for (const call of fetches) expect(call.at(-1)).toBe(world.commit);
    for (const call of world.calls.filter((entry) => entry[0] === 'git'))
      expect(call).not.toContain('--force');
  });

  describe('refuses before doing anything', () => {
    it.each([
      ['a relative output', (w: ReleaseWorld) => w.input({ outputDir: 'out/release' })],
      ['an output with a trailing separator', (w: ReleaseWorld) => w.input({ outputDir: `${w.output}/` })],
      ['an output containing a comma', (w: ReleaseWorld) => w.input({ outputDir: `${w.output},x` })],
      ['an uppercase commit', (w: ReleaseWorld) => w.input({ commit: w.commit.toUpperCase() })],
      ['a branch name', (w: ReleaseWorld) => w.input({ commit: 'main' })],
      ['an invalid release id', (w: ReleaseWorld) => w.input({ releaseId: '../rel_x' })],
    ])('%s (usage error)', async (_label, make) => {
      await expect(world.prepare({}, make(world))).rejects.toMatchObject({ exitCode: 64 });
      expect(world.calls).toEqual([]);
      expect(world.events).toEqual([]);
      expect(fs.existsSync(world.output)).toBe(false);
    });

    it.each([
      ['an existing output directory', (w: ReleaseWorld) => (fs.mkdirSync(w.output), w.input())],
      [
        'an output inside the source checkout',
        (w: ReleaseWorld) => w.input({ outputDir: path.join(w.source, 'release') }),
      ],
      [
        'an output inside the engine home',
        (w: ReleaseWorld) => w.input({ outputDir: path.join(w.engineHome, 'release') }),
      ],
      [
        'the source checkout as the engine releases directory',
        (w: ReleaseWorld) => w.input({ engineReleasesDir: w.source }),
      ],
      [
        'the engine home as the engine releases directory',
        (w: ReleaseWorld) => w.input({ engineReleasesDir: w.engineHome }),
      ],
      [
        'engine releases inside the output directory',
        (w: ReleaseWorld) => w.input({ engineReleasesDir: path.join(w.output, 'engines') }),
      ],
      [
        'a symlinked output parent',
        (w: ReleaseWorld) => {
          const link = path.join(w.home, 'linked');
          fs.symlinkSync(w.outParent, link);
          return w.input({ outputDir: path.join(link, 'release') });
        },
      ],
      [
        'a symlinked engine releases directory',
        (w: ReleaseWorld) => {
          const link = path.join(w.home, 'linked-engines');
          fs.mkdirSync(path.join(w.home, 'real-engines'), { mode: 0o700 });
          fs.symlinkSync(path.join(w.home, 'real-engines'), link);
          return w.input({ engineReleasesDir: link });
        },
      ],
      [
        'a group-writable output parent',
        (w: ReleaseWorld) => {
          fs.chmodSync(w.outParent, 0o770);
          return w.input();
        },
      ],
    ])('%s (refusal)', async (_label, make) => {
      const input = make(world);
      await expect(world.prepare({}, input)).rejects.toMatchObject({ exitCode: 2 });
      expect(world.calls).toEqual([]);
      expect(world.events).toEqual([]);
      expect(fs.existsSync(world.receiptFile)).toBe(false);
    });

    it('does not run without the machine heavy-run queue', async () => {
      const heavyLock = async () => {
        throw new Error('heavy_lock_unavailable');
      };
      await expect(world.prepare({ heavyLock })).rejects.toMatchObject({ exitCode: 2 });
      expect(world.calls).toEqual([]);
      expect(fs.existsSync(world.output)).toBe(false);
    });
  });

  describe('fails without a receipt', () => {
    const before = () => world.engineHomeState();

    it.each([
      ['single-platform', /does not support linux\/arm64/],
      ['wrong-arch', /not really run/],
      ['fake-revision', /reports revision/],
      ['native-broken', /smoke of linux\/\w+ sha256:\w+ failed.*better_sqlite3/],
      ['helper-broken', /litestream/],
      ['smoke-timeout', /did not finish in time/],
    ] as const)('on a failing image smoke: %s', async (scenario, message) => {
      const engineHome = before();
      world.scenario = scenario;
      await expect(world.prepare()).rejects.toThrow(message);
      expect(fs.existsSync(world.receiptFile)).toBe(false);
      // The engine candidate starts only after both images are proven.
      expect(fs.existsSync(world.engineReleases)).toBe(false);
      expect(world.sandboxRuns).toEqual([]);
      expectNoSideEffects(engineHome);
      expect(world.events.at(-1)).toBe('unlock');
      expect(world.removed.sort()).toEqual(
        world.dockerRuns.map((args) => args[args.indexOf('--name') + 1]).sort(),
      );
    });

    it.each([
      ['archive-changes', /archive differs from the manifest/],
      ['manifest-changes', /manifest changed/],
      ['lockfile-changes', /dirty|lockfile/],
    ] as const)('when an input changes before the receipt: %s', async (scenario, message) => {
      const engineHome = before();
      world.scenario = scenario;
      await expect(world.prepare()).rejects.toThrow(message);
      expect(fs.existsSync(world.receiptFile)).toBe(false);
      expectNoSideEffects(engineHome);
    });

    it.each([
      ['engine-native-broken', /check step failed/],
      ['engine-entry-broken', /check step failed/],
    ] as const)('on a broken engine candidate: %s', async (scenario, message) => {
      const engineHome = before();
      world.scenario = scenario;
      await expect(world.prepare()).rejects.toThrow(message);
      expect(fs.existsSync(world.receiptFile)).toBe(false);
      // The candidate is incomplete: no marker, so no later run reuses it.
      expect(fs.existsSync(candidateMarkerFile(world.candidate))).toBe(false);
      expectNoSideEffects(engineHome);
    });

    it('on interrupt through the process handler, removing its own container', async () => {
      const engineHome = before();
      const context = world.context();
      const run = context.deps.run;
      context.deps.run = async (command, args, options) => {
        if (command === 'docker' && args[0] === 'run') for (const handler of world.interrupts) handler();
        return run(command, args, options);
      };
      await expect(prepareHybridRelease(context, world.input(), world.options())).rejects.toThrow(
        /interrupted/,
      );
      expect(fs.existsSync(world.receiptFile)).toBe(false);
      expect(world.removed).toHaveLength(1);
      expect(world.interrupts.size).toBe(0);
      expectNoSideEffects(engineHome);
    });

    it('on abort of the caller signal', async () => {
      const engineHome = before();
      world.scenario = 'abort-in-smoke';
      const caller = world.abort;
      await expect(world.prepare({ signal: caller.signal })).rejects.toThrow(/interrupted/);
      expect(fs.existsSync(world.receiptFile)).toBe(false);
      expect(world.sandboxRuns).toEqual([]);
      expect(world.removed).toHaveLength(1);
      expect(world.events.at(-1)).toBe('unlock');
      expectNoSideEffects(engineHome);
    });

    it('when the signal is already aborted, before any process starts', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(world.prepare({ signal: controller.signal })).rejects.toThrow();
      expect(world.calls.filter((call) => call[0] === 'docker')).toEqual([]);
      expect(fs.existsSync(world.receiptFile)).toBe(false);
    });
  });

  describe('the engine candidate directory', () => {
    it('is reused only when a finished, identical, clean candidate stands there', async () => {
      const first = await world.prepare();
      fs.rmSync(world.output, { recursive: true });
      world.sandboxRuns.length = 0;
      const second = await world.prepare();
      expect(second.engine).toEqual(first.engine);
      // Re-verified (sandbox probe and import checks), but neither installed nor built again.
      expect(world.sandboxRuns.some((entry) => entry.command.includes('npm ci'))).toBe(false);
      expect(world.sandboxRuns.some((entry) => entry.command.includes('npm run build'))).toBe(false);
      expect(world.sandboxRuns.length).toBeGreaterThan(0);
    });

    it.each([
      ['a dirty checkout', () => fs.writeFileSync(path.join(world.candidate, 'stray.txt'), 'x')],
      [
        'a changed server bundle',
        () => fs.appendFileSync(path.join(world.candidate, 'apps/server/dist/index.js'), ';'),
      ],
      ['a changed lockfile', () => fs.appendFileSync(path.join(world.candidate, 'package-lock.json'), '\n')],
      ['a missing marker', () => fs.rmSync(candidateMarkerFile(world.candidate))],
    ])('is refused and left alone with %s', async (_label, damage) => {
      await world.prepare();
      damage();
      const listing = () => fs.readdirSync(world.candidate).sort().join(',');
      const snapshot = listing();
      fs.rmSync(world.output, { recursive: true });
      await expect(world.prepare()).rejects.toMatchObject({ exitCode: 2 });
      expect(listing()).toBe(snapshot);
      expect(fs.existsSync(world.receiptFile)).toBe(false);
    });

    it('refuses a partial directory without a marker and never overwrites it', async () => {
      fs.mkdirSync(path.join(world.engineReleases), { mode: 0o700 });
      fs.mkdirSync(world.candidate);
      fs.writeFileSync(path.join(world.candidate, 'partial.txt'), 'half done');
      await expect(world.prepare()).rejects.toMatchObject({ exitCode: 2 });
      expect(fs.readFileSync(path.join(world.candidate, 'partial.txt'), 'utf8')).toBe('half done');
      expect(fs.readdirSync(world.candidate)).toEqual(['partial.txt']);
      expect(fs.existsSync(world.receiptFile)).toBe(false);
      expect(world.sandboxRuns).toEqual([]);
    });

    it('refuses a candidate that is a symlink', async () => {
      fs.mkdirSync(world.engineReleases, { mode: 0o700 });
      fs.mkdirSync(path.join(world.home, 'elsewhere'));
      fs.symlinkSync(path.join(world.home, 'elsewhere'), world.candidate);
      await expect(world.prepare()).rejects.toMatchObject({ exitCode: 2 });
      expect(fs.readdirSync(path.join(world.home, 'elsewhere'))).toEqual([]);
    });

    it('refuses a marker that belongs to another release or commit', async () => {
      await world.prepare();
      const markerFile = candidateMarkerFile(world.candidate);
      const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      fs.chmodSync(markerFile, 0o600);
      fs.writeFileSync(markerFile, JSON.stringify({ ...marker, releaseId: 'rel_other' }));
      fs.rmSync(world.output, { recursive: true });
      await expect(world.prepare()).rejects.toMatchObject({ exitCode: 2 });
    });

    it('cannot overwrite a finished receipt', async () => {
      await world.prepare();
      const text = fs.readFileSync(world.receiptFile, 'utf8');
      await expect(world.prepare()).rejects.toMatchObject({ exitCode: 2 });
      expect(fs.readFileSync(world.receiptFile, 'utf8')).toBe(text);
    });
  });
});

describe('the preparer sandbox', () => {
  it('limits reads, writes, network and environment of every step that runs checkout code', async () => {
    await world.prepare();
    const runs = world.sandboxRuns;
    const install = runs.find((entry) => entry.command.includes('npm ci'))!;
    const build = runs.find((entry) => entry.command.includes('npm run build'))!;
    const others = runs.filter((entry) => entry !== install);
    expect(install.cwd).toBe(world.candidate);
    expect(runs.every((entry) => entry.cwd === world.candidate)).toBe(true);

    // The install alone reaches the network, and only the two hosts of the lockfile's registry and Node headers.
    expect(install.settings.network.allowedDomains).toEqual(['registry.npmjs.org', 'nodejs.org']);
    expect(install.command).toContain('--registry=https://registry.npmjs.org');
    for (const entry of others) expect(entry.settings.network.allowedDomains).toEqual([]);
    for (const entry of runs) expect(entry.settings.network.allowLocalBinding).toBe(false);
    // No Unix socket either: the candidate's steps have nothing to serve (PM-847).
    for (const entry of runs) {
      expect(entry.settings.network).not.toHaveProperty('allowUnixSockets');
      expect(entry.settings.network).not.toHaveProperty('allowAllUnixSockets');
    }

    // Writable: the throwaway directory plus the package trees (install) or the server bundle (build) only.
    const runDirOf = (entry: Recorded) => path.dirname(entry.settingsFile);
    expect(install.settings.filesystem.allowWrite).toEqual([
      path.join(runDirOf(install), 'sandbox'),
      path.join(world.candidate, 'node_modules'),
      path.join(world.candidate, 'apps/server', 'node_modules'),
    ]);
    expect(build.settings.filesystem.allowWrite).toEqual([
      path.join(runDirOf(build), 'sandbox'),
      path.join(world.candidate, 'apps/server/dist'),
    ]);
    for (const entry of others.filter((other) => other !== build))
      expect(entry.settings.filesystem.allowWrite).toEqual([path.join(runDirOf(entry), 'sandbox')]);
    for (const entry of runs) {
      for (const writable of entry.settings.filesystem.allowWrite) {
        for (const closed of [world.home, world.engineHome, world.source, world.output, world.engineReleases])
          if (writable === closed) throw new Error(`${writable} must not be writable`);
        // The sandbox settings and npm configs are outside every writable directory.
        expect(path.relative(writable, entry.settingsFile).startsWith('..')).toBe(true);
      }
      expect(entry.settings.filesystem.allowRead).toContain(world.candidate);
    }

    // Unreadable: the user's home, the engine home and the credential stores, whatever else is allowed.
    for (const entry of runs) {
      const denied = entry.settings.filesystem.denyRead;
      for (const closed of [
        world.userHome,
        world.engineHome,
        path.join(world.userHome, '.ssh'),
        path.join(world.userHome, '.aws'),
        path.join(world.userHome, '.cloudflared'),
        path.join(world.userHome, '.config', 'projectman'),
        path.join(world.engineHome, 'db.sqlite*'),
        path.join(world.engineHome, 'secrets'),
      ])
        expect(denied).toContain(closed);
      expect(entry.settings.filesystem.allowRead).not.toContain(world.userHome);
      expect(entry.settings.filesystem.allowRead).not.toContain(world.engineHome);
    }
  });

  it('closes the temporary roots the machine shares, in every sandboxed run', async () => {
    const claudeBase = path.join(world.home, 'claude-base');
    await world.prepare({
      baseEnv: { ...world.options().baseEnv, CLAUDE_CODE_TMPDIR: claudeBase },
    });
    const shared = [
      ...sharedClaudeTmpRoots({ claudeTmpBase: claudeBase }),
      defaultSessionTmpRoot(),
      path.join(fs.realpathSync(os.tmpdir()), 'projectman-sessions'),
    ];
    expect(shared).toContain(path.join(claudeBase, `claude-${process.getuid?.()}`));
    expect(world.sandboxRuns.length).toBeGreaterThan(0);
    for (const entry of world.sandboxRuns) {
      expect(entry.settings.filesystem.denyRead).toEqual(expect.arrayContaining(shared));
      // The run's own directory is readable although it may stand below a closed root.
      expect(entry.settings.filesystem.allowRead).toContain(
        path.join(path.dirname(entry.settingsFile), 'sandbox'),
      );
    }
  });

  it('runs with an allow-listed environment, a throwaway home and empty npm configs', async () => {
    await world.prepare();
    for (const entry of world.sandboxRuns) {
      const runDir = path.dirname(entry.settingsFile);
      expect(Object.keys(entry.env).sort()).toEqual(
        [
          'CLAUDE_CODE_TMPDIR',
          'FORCE_COLOR',
          'GIT_CONFIG_GLOBAL',
          'GIT_CONFIG_NOSYSTEM',
          'HOME',
          'LANG',
          'NO_COLOR',
          'PATH',
          'PROJECTMAN_FULL_TEST_SANDBOX',
          'PROJECTMAN_HEAVY_LOCK_HELD',
          'TMPDIR',
          'VITEST_MAX_FORKS',
          'VITEST_MAX_THREADS',
          'npm_config_cache',
          'npm_config_update_notifier',
        ].sort(),
      );
      expect(entry.env.HOME).toBe(path.join(runDir, 'sandbox', 'home'));
      expect(entry.env.TMPDIR).toBe(path.join(runDir, 'sandbox', 'tmp'));
      const text = JSON.stringify(entry.env);
      for (const secret of [
        'sk-ant-secret',
        'aws-secret',
        'cf-secret',
        'gh-secret',
        '/tmp/agent.sock',
        world.engineHome,
      ])
        expect(text).not.toContain(secret);
    }
    const install = world.sandboxRuns.find((entry) => entry.command.includes('npm ci'))!;
    expect(install.command).toMatch(
      /--userconfig='[^']*npm-user\.conf' --globalconfig='[^']*npm-global\.conf'/,
    );
  });

  it('removes its throwaway run directory and settings after each step', async () => {
    await world.prepare();
    for (const entry of world.sandboxRuns)
      expect(fs.existsSync(path.dirname(entry.settingsFile))).toBe(false);
    expect(fs.readdirSync(world.sandboxTmp)).toEqual([]);
  });

  it('proves the sandbox works before the checkout code runs, and loads the native and entry points after', async () => {
    await world.prepare();
    const commands = world.sandboxRuns.map((entry) => entry.command);
    expect(commands[0]).toContain('node --version');
    expect(commands[1]).toContain('npm ci');
    expect(commands[2]).toContain('npm run build');
    expect(commands.slice(3).join('\n')).toContain('better-sqlite3');
    expect(commands.slice(3).join('\n')).toContain('--import tsx apps/server/src/index.ts');
    expect(commands.slice(3).join('\n')).toContain('apps/server/dist/index.js');
    expect(commands.slice(3).join('\n')).toContain('PROJECTMAN_MODE=engine');
  });

  it.each([
    ['sandbox-missing', /sandbox is unavailable/],
    ['sandbox-timeout', /preparer sandbox is unavailable.*timeout|timeout/],
  ] as const)('never falls back to the host when %s', async (scenario, message) => {
    const engineHome = world.engineHomeState();
    world.scenario = scenario;
    await expect(world.prepare()).rejects.toThrow(message);
    // Only the fake sandbox saw the command: the host never ran npm, node or a shell.
    const commands = world.calls.map((call) => call[0]!);
    for (const forbidden of ['npm', 'node', 'sh', 'bash', 'npx']) expect(commands).not.toContain(forbidden);
    expect(world.sandboxRuns).toHaveLength(1);
    expect(fs.existsSync(world.receiptFile)).toBe(false);
    expectNoSideEffects(engineHome);
  });

  it('never falls back to the host when the caller aborts a running sandbox step', async () => {
    const controller = new AbortController();
    await expect(
      world.prepare({
        signal: controller.signal,
        sandbox: async (run) => {
          controller.abort();
          return {
            exitCode: null,
            signal: 'SIGTERM',
            timedOut: false,
            aborted: true,
            output: `${run.command}`,
          };
        },
      }),
    ).rejects.toThrow(/interrupted/);
    for (const forbidden of ['npm', 'node', 'sh', 'bash'])
      expect(world.calls.map((call) => call[0])).not.toContain(forbidden);
    expect(fs.existsSync(world.receiptFile)).toBe(false);
  });

  it('refuses an install that could change the dependency inputs', async () => {
    // A repository whose lockfile workspace carries an install hook is refused before any step runs.
    git(world.remote, 'checkout', '--quiet', world.commit);
    fs.writeFileSync(
      path.join(world.remote, 'apps/server/package.json'),
      JSON.stringify({ name: '@projectman/server', scripts: { postinstall: 'touch x' } }),
    );
    git(world.remote, 'add', '-A');
    git(world.remote, 'commit', '--quiet', '-m', 'hook');
    world.commit = git(world.remote, 'rev-parse', 'HEAD').trim();
    await expect(world.prepare()).rejects.toThrow(/postinstall/);
    expect(world.sandboxRuns).toEqual([]);
    expect(fs.existsSync(world.receiptFile)).toBe(false);
  });
});
