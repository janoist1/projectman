import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullTestSpec } from '../contracts';
import { silentLogger } from '../runner/test-helpers';
import * as worktree from '../worktree';
import { createFullTestExecutor } from './index';
import { readHeavyQueue } from './heavy-lock';
import { runSandboxed } from './run-sandboxed';
import type { SandboxedEnd, SandboxedRun } from './run-sandboxed';

vi.mock('./run-sandboxed', () => ({ runSandboxed: vi.fn(), srtCli: vi.fn() }));
vi.mock('./sandbox', async (original) => {
  const actual = await original<typeof import('./sandbox')>();
  return {
    ...actual,
    // No real sandbox sockets here: keep fixture runs inside the test's own temporary root.
    runDirOf: (root: string, _shortRoot: string, runId: string) => path.join(root, runId),
  };
});

const REF = { projectKey: 'PM', repo: 'projectman' };
const logger = silentLogger();
const end = (overrides: Partial<SandboxedEnd> = {}): SandboxedEnd => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  output: '',
  ...overrides,
});
const write = (root: string, relative: string, content = '{}') => {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};
const localPackages = ['app', 'apps/server'];
let root: string;
let worktreesRoot: string;
let heavyLockDir: string;
let sequence: number;
let install: (cwd: string) => Promise<SandboxedEnd>;
let calls: SandboxedRun[];
let settings: Map<string, unknown>;
let npmVersion: string;
let nodeVersion: string;
let tracked: string;

function fixture(): FullTestSpec {
  sequence += 1;
  const mergeId = `mrg_${String(sequence).padStart(8, '0')}`;
  const cwd = path.join(worktreesRoot, '_merge', mergeId);
  write(
    cwd,
    'package-lock.json',
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture' },
        app: {},
        'apps/server': {},
        'node_modules/ordinary': {},
      },
    }),
  );
  write(cwd, 'package.json', '{"name":"fixture","workspaces":["app","apps/server"]}');
  for (const dir of localPackages)
    write(cwd, `${dir}/package.json`, JSON.stringify({ name: dir.replace('/', '-') }));
  return {
    runId: `ftr_${String(sequence).padStart(8, '0')}`,
    cwd,
    command: 'npm run check',
    timeoutMs: 10_000,
    maxWorkers: 2,
    requireHeavyLock: true,
    npmCi: { ref: REF, mergeId },
    sandbox: { denyRead: [path.join(root, 'private')], allowRead: [cwd] },
  };
}
function packageTrees(cwd: string) {
  write(cwd, 'node_modules/.package-lock.json');
  for (const parent of ['', ...localPackages]) {
    write(cwd, path.posix.join(parent, 'node_modules/pkg/index.js'), 'installed');
    for (const cache of ['.vite', '.vite-temp', '.cache'])
      write(cwd, path.posix.join(parent, 'node_modules', cache, 'cached'), 'stale');
  }
  symlinkSync('../app', path.join(cwd, 'node_modules/workspace'));
}
const current = () =>
  path.join(
    worktreesRoot,
    '_merge-deps',
    createHash('sha256')
      .update(JSON.stringify([REF.projectKey, REF.repo]))
      .digest('hex'),
    'current',
  );
const run = (spec: FullTestSpec, signal = new AbortController().signal, onStarted = vi.fn()) =>
  createFullTestExecutor({ logger, tmpDir: root, worktreesRoot, heavyLockDir }).run(spec, signal, onStarted);
const installs = () => calls.filter((call) => call.command.startsWith('npm ci '));
const tests = () => calls.filter((call) => call.command === 'npm run check');
const marker = () =>
  JSON.parse(readFileSync(path.join(current(), 'ready.json'), 'utf8')) as {
    key: string;
    nodeModules: string[];
  };

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-npm-ci-')));
  worktreesRoot = path.join(root, 'worktrees');
  heavyLockDir = path.join(root, 'heavy');
  sequence = 0;
  calls = [];
  settings = new Map();
  npmVersion = '11.0.0';
  nodeVersion = 'v24.0.0';
  tracked = '';
  install = async (cwd) => {
    packageTrees(cwd);
    return end();
  };
  vi.mocked(runSandboxed).mockImplementation(async (request) => {
    calls.push(request);
    settings.set(request.settings, JSON.parse(readFileSync(request.settings, 'utf8')));
    if (request.command.includes('node --version')) return end({ output: nodeVersion });
    if (request.command.startsWith('npm --version')) return end({ output: npmVersion });
    if (request.command.startsWith('git ')) return end({ output: tracked });
    if (request.command.startsWith('npm ci ')) return install(request.cwd);
    return end();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('sandboxed dependency preparation under the full-test lock', () => {
  it('installs once, publishes all workspace trees and reuses the same generation in another check', async () => {
    const first = fixture();
    const started = vi.fn();
    expect(await run(first, undefined, started)).toMatchObject({ outcome: 'passed' });
    expect(started).toHaveBeenCalledTimes(1);
    expect(marker().nodeModules.sort()).toEqual([
      'app/node_modules',
      'apps/server/node_modules',
      'node_modules',
    ]);
    expect(lstatSync(current()).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(current(), 'ready.json')).mode & 0o777).toBe(0o600);
    const next = fixture();
    expect(await run(next)).toMatchObject({ outcome: 'passed' });
    expect(installs()).toHaveLength(1);
    expect(tests()).toHaveLength(2);
    expect(readFileSync(path.join(next.cwd, 'apps/server/node_modules/pkg/index.js'), 'utf8')).toBe(
      'installed',
    );
    expect(readlinkSync(path.join(next.cwd, 'node_modules/workspace'))).toBe('../app');
    for (const parent of ['', ...localPackages])
      for (const cache of ['.vite', '.vite-temp', '.cache'])
        expect(existsSync(path.join(next.cwd, parent, 'node_modules', cache))).toBe(false);
    expect(readdirSync(path.dirname(current()))).toEqual(['current']);
    expect((await readHeavyQueue(heavyLockDir)).holder).toBeNull();
  });

  it('uses separate installer settings, empty npm configs and an isolated environment', async () => {
    const spec = fixture();
    const executor = createFullTestExecutor({
      logger,
      tmpDir: root,
      worktreesRoot,
      heavyLockDir,
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: '--require=secret',
        npm_config_userconfig: '/private/auth',
        NPM_TOKEN: 'secret',
        HTTPS_PROXY: 'private-proxy',
        OPENAI_API_KEY: 'secret',
        CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'private',
      },
    });
    install = async (cwd) => {
      const request = installs()[0]!;
      const runDir = path.dirname(request.settings);
      expect(readFileSync(path.join(runDir, 'npm-user.conf'), 'utf8')).toBe('');
      expect(readFileSync(path.join(runDir, 'npm-global.conf'), 'utf8')).toBe('');
      expect(request.command).toContain(
        'npm ci --include=dev --include=optional --no-audit --no-fund --registry=https://registry.npmjs.org',
      );
      expect(request.command).toContain(
        `--userconfig='${runDir}/npm-user.conf' --globalconfig='${runDir}/npm-global.conf'`,
      );
      expect(request.command).not.toContain('ignore-scripts');
      packageTrees(cwd);
      return end();
    };
    expect(await executor.run(spec, new AbortController().signal)).toMatchObject({ outcome: 'passed' });
    const request = installs()[0]!;
    expect(settings.get(request.settings)).toMatchObject({
      network: { allowedDomains: ['registry.npmjs.org', 'nodejs.org'], allowLocalBinding: false },
      filesystem: {
        allowWrite: [
          expect.stringContaining('/sandbox'),
          ...['', ...localPackages].map((dir) => path.join(spec.cwd, dir, 'node_modules')),
        ],
        denyRead: spec.sandbox.denyRead,
        denyWrite: ['/tmp/claude', '/private/tmp/claude'],
      },
    });
    expect(settings.get(tests()[0]!.settings)).toMatchObject({
      network: { allowedDomains: [] },
      filesystem: { allowWrite: [expect.stringContaining('/sandbox')] },
    });
    for (const name of [
      'NODE_OPTIONS',
      'npm_config_userconfig',
      'NPM_TOKEN',
      'HTTPS_PROXY',
      'OPENAI_API_KEY',
      'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
    ])
      expect(request.env).not.toHaveProperty(name);
    expect(request.env.VITEST_MAX_FORKS).toBe('2');
  });

  it.each(['lock', 'root manifest', 'workspace manifest', 'Node', 'npm'])(
    'replaces its single generation when %s changes',
    async (change) => {
      expect(await run(fixture())).toMatchObject({ outcome: 'passed' });
      const previous = marker().key;
      const next = fixture();
      if (change === 'lock')
        writeFileSync(
          path.join(next.cwd, 'package-lock.json'),
          readFileSync(path.join(next.cwd, 'package-lock.json'), 'utf8') + '\n',
        );
      if (change === 'root manifest') write(next.cwd, 'package.json', '{"name":"changed"}');
      if (change === 'workspace manifest') write(next.cwd, 'apps/server/package.json', '{"name":"changed"}');
      if (change === 'Node') nodeVersion = 'v25.0.0';
      if (change === 'npm') npmVersion = '12.0.0';
      expect(await run(next)).toMatchObject({ outcome: 'passed' });
      expect(installs()).toHaveLength(2);
      expect(marker().key).not.toBe(previous);
      expect(readdirSync(path.dirname(current()))).toEqual(['current']);
    },
  );

  it.each([
    'missing',
    'malformed',
    'wrong key',
    'unsafe tree',
    'duplicate tree',
    'missing tree',
    'linked lock',
  ])('treats a %s marker or tree as a cache miss', async (kind) => {
    await run(fixture());
    const file = path.join(current(), 'ready.json');
    const ready = marker();
    if (kind === 'missing') rmSync(file);
    if (kind === 'malformed') writeFileSync(file, '{');
    if (kind === 'wrong key') writeFileSync(file, JSON.stringify({ ...ready, key: 'a'.repeat(64) }));
    if (kind === 'unsafe tree')
      writeFileSync(file, JSON.stringify({ ...ready, nodeModules: ['node_modules', '../node_modules'] }));
    if (kind === 'duplicate tree')
      writeFileSync(file, JSON.stringify({ ...ready, nodeModules: ['node_modules', 'node_modules'] }));
    if (kind === 'missing tree') rmSync(path.join(current(), 'app/node_modules'), { recursive: true });
    if (kind === 'linked lock') {
      rmSync(path.join(current(), 'node_modules/.package-lock.json'));
      symlinkSync(path.join(root, 'elsewhere'), path.join(current(), 'node_modules/.package-lock.json'));
    }
    expect(await run(fixture())).toMatchObject({ outcome: 'passed' });
    expect(installs()).toHaveLength(2);
  });

  it.each([
    ['nonzero npm', { exitCode: 17, output: 'install failed' }, 'dependency_install_failed', 17],
    ['npm timeout', { timedOut: true, signal: 'SIGTERM' }, 'timeout', null],
    ['npm abort', { aborted: true }, 'killed', null],
    ['npm spawn error', { spawnError: new Error('spawn') }, 'spawn_failed', null],
  ] as const)('never tests or publishes after %s', async (_name, ended, reason, exitCode) => {
    install = async () => end(ended);
    const result = await run(fixture());
    expect(result).toMatchObject({ outcome: 'error', reason, exitCode, failedFiles: [] });
    expect(tests()).toHaveLength(0);
    expect(existsSync(path.join(current(), 'ready.json'))).toBe(false);
    expect((await readHeavyQueue(heavyLockDir)).holder).toBeNull();
  });

  it.each(['lock', 'manifest'])('refuses a changed %s after the installer ends', async (kind) => {
    install = async (cwd) => {
      packageTrees(cwd);
      write(cwd, kind === 'lock' ? 'package-lock.json' : 'apps/server/package.json', '{}');
      return end();
    };
    expect(await run(fixture())).toMatchObject({
      outcome: 'error',
      reason: 'dependency_install_failed',
      exitCode: null,
    });
    expect(tests()).toHaveLength(0);
    expect(existsSync(path.join(current(), 'ready.json'))).toBe(false);
  });

  it('does not publish or test after copying fails', async () => {
    vi.spyOn(worktree, 'copyDependencyTrees').mockRejectedValue(new Error('filesystem failure'));
    expect(await run(fixture())).toMatchObject({
      outcome: 'error',
      reason: 'dependency_install_failed',
      exitCode: null,
    });
    expect(tests()).toHaveLength(0);
    expect(readdirSync(path.dirname(current()))).toEqual([]);
  });

  describe.each(['.npmrc', 'npm-shrinkwrap.json'])('unkeyed npm input %s', (name) => {
    it.each(['file', 'directory', 'symlink', 'dangling symlink'])(
      'rejects an existing %s before installation',
      async (kind) => {
        const spec = fixture();
        const file = path.join(spec.cwd, name);
        if (kind === 'file') writeFileSync(file, '');
        if (kind === 'directory') mkdirSync(file);
        if (kind === 'symlink') symlinkSync(path.join(spec.cwd, 'package.json'), file);
        if (kind === 'dangling symlink') symlinkSync(path.join(root, 'absent'), file);
        expect(await run(spec)).toMatchObject({
          outcome: 'error',
          reason: 'dependency_install_failed',
          exitCode: null,
          outputTail: expect.stringContaining(name),
        });
        expect(installs()).toHaveLength(0);
        expect(tests()).toHaveLength(0);
        expect(existsSync(path.join(current(), 'ready.json'))).toBe(false);
      },
    );

    it('cannot reuse a valid shared generation', async () => {
      expect(await run(fixture())).toMatchObject({ outcome: 'passed' });
      const previous = marker();
      const spec = fixture();
      write(spec.cwd, name, '');
      expect(await run(spec)).toMatchObject({ outcome: 'error', reason: 'dependency_install_failed' });
      expect(installs()).toHaveLength(1);
      expect(tests()).toHaveLength(1);
      expect(marker()).toEqual(previous);
      expect(existsSync(path.join(spec.cwd, 'node_modules'))).toBe(false);
    });

    it('rejects a file introduced during installation without publishing', async () => {
      install = async (cwd) => {
        packageTrees(cwd);
        write(cwd, name, '');
        return end();
      };
      expect(await run(fixture())).toMatchObject({
        outcome: 'error',
        reason: 'dependency_install_failed',
        exitCode: null,
      });
      expect(installs()).toHaveLength(1);
      expect(tests()).toHaveLength(0);
      expect(existsSync(path.join(current(), 'ready.json'))).toBe(false);
    });

    it('rejects a file introduced during the staging copy without publishing', async () => {
      const spec = fixture();
      const copy = worktree.copyDependencyTrees;
      vi.spyOn(worktree, 'copyDependencyTrees').mockImplementation(async (input) => {
        const copied = await copy(input);
        write(spec.cwd, name, '');
        return copied;
      });
      expect(await run(spec)).toMatchObject({
        outcome: 'error',
        reason: 'dependency_install_failed',
        exitCode: null,
      });
      expect(tests()).toHaveLength(0);
      expect(readdirSync(path.dirname(current()))).toEqual([]);
    });
  });

  it('preserves the last successful generation when replacement copying fails', async () => {
    await run(fixture());
    const previous = marker();
    const next = fixture();
    write(next.cwd, 'package.json', '{"name":"new"}');
    vi.spyOn(worktree, 'copyDependencyTrees').mockRejectedValue(new Error('filesystem failure'));
    expect(await run(next)).toMatchObject({ outcome: 'error', reason: 'dependency_install_failed' });
    expect(marker()).toEqual(previous);
    expect(readdirSync(path.dirname(current()))).toEqual(['current']);
    expect(tests()).toHaveLength(1);
  });

  it('cleans abandoned generations before publishing another one', async () => {
    const spec = fixture();
    write(path.dirname(current()), 'staging-0123456789abcdef/partial', 'abandoned');
    write(path.dirname(current()), 'previous/ready.json', '{}');
    expect(await run(spec)).toMatchObject({ outcome: 'passed' });
    expect(readdirSync(path.dirname(current()))).toEqual(['current']);
  });

  it('keeps the lock until an aborted copying step has settled, then removes its staging directory', async () => {
    const spec = fixture();
    const controller = new AbortController();
    let settled = false;
    vi.spyOn(worktree, 'copyDependencyTrees').mockImplementation(async ({ signal }) => {
      const stopping = new Promise<void>((resolve) =>
        signal!.addEventListener('abort', () => setTimeout(resolve, 20), { once: true }),
      );
      controller.abort();
      await stopping;
      expect((await readHeavyQueue(heavyLockDir)).holder).not.toBeNull();
      settled = true;
      throw new Error('copy stopped');
    });
    expect(await run(spec, controller.signal)).toMatchObject({ outcome: 'error', reason: 'killed' });
    expect(settled).toBe(true);
    expect(tests()).toHaveLength(0);
    expect(readdirSync(path.dirname(current()))).toEqual([]);
    expect((await readHeavyQueue(heavyLockDir)).holder).toBeNull();
  });

  it('identifies version lines despite runtime diagnostics', async () => {
    nodeVersion = 'runtime warning\nv24.0.0\n';
    npmVersion = '11.0.0\nruntime warning';
    expect(await run(fixture())).toMatchObject({ outcome: 'passed' });
  });

  it.each(['../escape', 'apps/*', 'apps/server/deeper', '.git/workspace'])(
    'refuses unsafe workspace layout %s before npm starts',
    async (workspace) => {
      const spec = fixture();
      write(spec.cwd, 'package-lock.json', JSON.stringify({ packages: { '': {}, [workspace]: {} } }));
      expect(await run(spec)).toMatchObject({ outcome: 'error', reason: 'dependency_install_failed' });
      expect(installs()).toHaveLength(0);
      expect(tests()).toHaveLength(0);
    },
  );

  it.each(['lock', 'manifest', 'workspace parent', 'node_modules', 'store', 'generation'])(
    'refuses a symbolic link in the %s',
    async (kind) => {
      const spec = fixture();
      const outside = path.join(root, 'outside');
      mkdirSync(outside);
      if (kind === 'lock' || kind === 'manifest') {
        const relative = kind === 'lock' ? 'package-lock.json' : 'app/package.json';
        rmSync(path.join(spec.cwd, relative));
        symlinkSync(path.join(outside, 'file'), path.join(spec.cwd, relative));
      }
      if (kind === 'workspace parent') {
        rmSync(path.join(spec.cwd, 'apps'), { recursive: true });
        symlinkSync(outside, path.join(spec.cwd, 'apps'));
      }
      if (kind === 'node_modules') symlinkSync(outside, path.join(spec.cwd, 'node_modules'));
      if (kind === 'store') symlinkSync(outside, path.join(worktreesRoot, '_merge-deps'));
      if (kind === 'generation') {
        mkdirSync(path.dirname(current()), { recursive: true });
        symlinkSync(outside, current());
      }
      expect(await run(spec)).toMatchObject({ outcome: 'error', reason: 'dependency_install_failed' });
      expect(installs()).toHaveLength(0);
      expect(tests()).toHaveLength(0);
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  it('refuses tracked package paths before the installer starts', async () => {
    const spec = fixture();
    await worktree.git(['init', '-q', spec.cwd], { isolatedConfig: true });
    write(spec.cwd, 'apps/server/node_modules/tracked.txt', 'tracked');
    await worktree.git(['-C', spec.cwd, 'add', '-f', 'apps/server/node_modules/tracked.txt'], {
      isolatedConfig: true,
    });
    // Exercise git's real fixed-record output with a warning on the merged capture stream.
    tracked =
      'sandbox warning\n' +
      (await worktree.git(
        [
          '-C',
          spec.cwd,
          '--literal-pathspecs',
          'ls-files',
          '-z',
          '--format=PROJECTMAN_TRACKED_NODE_MODULES',
          '--',
          'node_modules',
          'app/node_modules',
          'apps/server/node_modules',
        ],
        { isolatedConfig: true },
      ));
    expect(await run(spec)).toMatchObject({ outcome: 'error', reason: 'dependency_install_failed' });
    expect(installs()).toHaveLength(0);
    expect(tests()).toHaveLength(0);
  });

  it('does not interpret probe diagnostics as tracked package paths', async () => {
    tracked = 'sandbox warning\ngit warning: node_modules is a package path\n';
    expect(await run(fixture())).toMatchObject({ outcome: 'passed' });
    expect(installs()).toHaveLength(1);
    expect(tests()).toHaveLength(1);
  });

  it.each(['missing root', 'wrong cwd', 'missing lock flag', 'symlink checkout', 'symlink merge parent'])(
    'rejects %s before starting any child',
    async (kind) => {
      const spec = fixture();
      if (kind === 'wrong cwd') spec.cwd = root;
      if (kind === 'missing lock flag') spec.requireHeavyLock = false;
      if (kind === 'symlink checkout') {
        rmSync(spec.cwd, { recursive: true });
        symlinkSync(root, spec.cwd);
      }
      if (kind === 'symlink merge parent') {
        rmSync(path.dirname(spec.cwd), { recursive: true });
        symlinkSync(root, path.dirname(spec.cwd));
      }
      const started = vi.fn();
      const executor = createFullTestExecutor({
        logger,
        tmpDir: root,
        worktreesRoot: kind === 'missing root' ? undefined : worktreesRoot,
        heavyLockDir,
      });
      expect(await executor.run(spec, new AbortController().signal, started)).toMatchObject({
        outcome: 'error',
        reason: 'dependency_install_failed',
      });
      expect(calls).toEqual([]);
      expect(started).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '/tmp/heavy'])(
    'starts nothing if the mandatory queue is unavailable: %s',
    async (dir) => {
      const spec = fixture();
      const started = vi.fn();
      expect(
        await createFullTestExecutor({ logger, tmpDir: root, worktreesRoot, heavyLockDir: dir }).run(
          spec,
          new AbortController().signal,
          started,
        ),
      ).toMatchObject({ reason: 'heavy_lock_unavailable' });
      expect(calls).toEqual([]);
      expect(started).not.toHaveBeenCalled();
    },
  );

  it('serializes parallel checks and installs only once', async () => {
    const first = fixture();
    const second = fixture();
    const started = vi.fn();
    const results = await Promise.all([run(first, undefined, started), run(second, undefined, started)]);
    expect(results.map((result) => result.outcome)).toEqual(['passed', 'passed']);
    expect(installs()).toHaveLength(1);
    expect(started).toHaveBeenCalledTimes(2);
  });

  it('shares one time budget across probes, installation, copying and the test', async () => {
    const spec = fixture();
    spec.timeoutMs = 1000;
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const original = vi.mocked(runSandboxed).getMockImplementation()!;
    vi.mocked(runSandboxed).mockImplementation(async (request) => {
      const result = await original(request);
      now += 100;
      return result;
    });
    expect(await run(spec)).toMatchObject({ outcome: 'passed' });
    expect(calls.map((call) => call.timeoutMs)).toEqual([1000, 900, 800, 700, 600, 500]);
  });

  it('stops before the test if the installation consumed the remaining budget', async () => {
    const spec = fixture();
    spec.timeoutMs = 1000;
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    install = async (cwd) => {
      packageTrees(cwd);
      now += 1001;
      return end();
    };
    expect(await run(spec)).toMatchObject({ outcome: 'error', reason: 'timeout' });
    expect(tests()).toHaveLength(0);
    expect(existsSync(path.join(current(), 'ready.json'))).toBe(false);
  });
});
