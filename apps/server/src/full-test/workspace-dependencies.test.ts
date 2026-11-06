import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { WorkspaceDependencyInstaller, WorkspaceDependencyRequest } from '../contracts';
import { silentLogger } from '../runner/test-helpers';
import { dependencyState } from '../worktree';
import { acquireHeavyLock, HeavyLockError, readHeavyQueue } from './heavy-lock';
import { npmDependencyKey } from './npm-dependency-key';
import type { SandboxedEnd, SandboxedRun } from './run-sandboxed';
import { createWorkspaceDependencyInstaller, WORKSPACE_DEPENDENCY_RETRY_MS } from './workspace-dependencies';

vi.mock('./sandbox', async (original) => ({
  ...(await original<typeof import('./sandbox')>()),
  runDirOf: (root: string, _short: string, id: string) => path.join(root, id),
}));

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
const trees = (root: string) => {
  write(root, 'node_modules/.package-lock.json');
  write(root, 'node_modules/pkg/index.js', 'installed');
  write(root, 'apps/server/node_modules/pkg/index.js', 'installed');
};
const hash = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

describe('engine-owned member dependency preparation', () => {
  let root: string;
  let request: WorkspaceDependencyRequest;
  let installer: WorkspaceDependencyInstaller;
  let calls: SandboxedRun[];
  let install: (run: SandboxedRun) => Promise<SandboxedEnd>;
  let tracked: string;
  const logger = silentLogger();
  const marker = () => path.join(root, 'home/workspace-deps', hash(['PM', 'dev', 'app']), 'ready.json');
  const prepare = (waitMs = 10_000) => installer.prepare(request, { waitMs });
  const installs = () => calls.filter((run) => run.command.startsWith('npm ci '));
  const make = (execute = true, configured: boolean | 'implicit' = true) =>
    createWorkspaceDependencyInstaller({
      home: path.join(root, 'home'),
      heavyLockDir: path.join(root, 'heavy'),
      worktreesRoot: path.join(root, 'worktrees'),
      tmpDir: root,
      denyRead: [
        path.join(root, 'user'),
        path.join(root, 'home'),
        path.join(root, 'secrets'),
        path.join(root, 'workspaces'),
        path.join(root, 'worktrees'),
        path.join(root, 'home/workspace-deps'),
        path.join(root, 'claude-tmp'),
        path.join(root, 'session-tmp'),
        path.join(root, 'session-folders'),
      ],
      setupOf: () =>
        configured ? { kind: 'npm_ci', timeoutMs: 10_000, implicit: configured === 'implicit' } : null,
      repoPathOf: () => request.repoPath,
      logger,
      ...(execute
        ? {
            execute: async (run: SandboxedRun) => {
              calls.push(run);
              if (run.command === 'node --version') return end({ output: 'v24.0.0' });
              if (run.command.startsWith('npm --version')) return end({ output: '11.0.0' });
              if (run.command.startsWith('git ')) return end({ output: tracked });
              return install(run);
            },
          }
        : {}),
    });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-workspace-deps-')));
    request = {
      project: 'PM',
      member: 'dev',
      repo: 'app',
      repoPath: path.join(root, 'workspaces/PM/dev/app/repo'),
    };
    write(
      request.repoPath,
      'package-lock.json',
      JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'apps/server': {} } }),
    );
    write(request.repoPath, 'package.json', '{"name":"fixture","workspaces":["apps/server"]}');
    write(request.repoPath, 'apps/server/package.json', '{"name":"server"}');
    calls = [];
    tracked = '';
    install = async (run) => {
      trees(run.cwd);
      return end();
    };
    installer = make();
  });
  afterEach(async () => {
    await installer.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('installs once, records an engine marker, then reuses it without running a command', async () => {
    const result = await prepare();
    expect(result).toMatchObject({ status: 'ready', changed: true });
    expect(JSON.parse(readFileSync(marker(), 'utf8'))).toMatchObject({
      version: 1,
      key: result.status === 'ready' ? result.key : '',
      nodeModules: ['node_modules', 'apps/server/node_modules'],
      preparedAt: expect.any(String),
    });
    const count = calls.length;
    expect(await prepare()).toEqual({ ...result, changed: false });
    expect(calls).toHaveLength(count);
    expect(installs()).toHaveLength(1);
  });

  it('reinstalls for changed bytes with unchanged mtime, workspace manifests, and missing trees', async () => {
    const lock = path.join(request.repoPath, 'package-lock.json');
    utimesSync(lock, 1, 1);
    const first = await prepare();
    writeFileSync(lock, `${readFileSync(lock, 'utf8')}\n`);
    utimesSync(lock, 1, 1);
    const second = await prepare();
    expect(second).not.toEqual(first);
    write(request.repoPath, 'apps/server/package.json', '{"name":"server","version":"2"}');
    expect(await prepare()).not.toEqual(second);
    rmSync(path.join(request.repoPath, 'apps/server/node_modules'), { recursive: true });
    expect(await prepare()).toMatchObject({ changed: true });
    expect(installs()).toHaveLength(4);
  });

  /** A complete merge-store generation with the key of the fixture's current inputs. */
  const seedMergeStore = () => {
    const source = path.join(root, 'worktrees/_merge-deps', hash(['PM', 'app']), 'current');
    trees(source);
    const key = npmDependencyKey({
      lock: readFileSync(path.join(request.repoPath, 'package-lock.json')),
      manifests: ['package.json', 'apps/server/package.json'].map((file) => ({
        path: file,
        content: readFileSync(path.join(request.repoPath, file)),
      })),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: 'v24.0.0',
      npmVersion: '11.0.0',
    });
    write(
      source,
      'ready.json',
      JSON.stringify({ version: 1, key, nodeModules: ['node_modules', 'apps/server/node_modules'] }),
    );
    return key;
  };

  it('ignores a marker in the clone and replaces an old matching merge-store generation without npm ci', async () => {
    write(request.repoPath, 'ready.json', '{"version":1,"key":"forged"}');
    const key = seedMergeStore();
    write(request.repoPath, 'node_modules/stale.txt', 'old');
    expect(await prepare()).toEqual({ status: 'ready', key, changed: true });
    expect(installs()).toHaveLength(0);
    expect(existsSync(path.join(request.repoPath, 'node_modules/stale.txt'))).toBe(false);
    expect(readFileSync(path.join(request.repoPath, 'node_modules/pkg/index.js'), 'utf8')).toBe('installed');
  });

  it('joins one install, returns pending without cancelling, and lets the next caller join', async () => {
    let release!: () => void;
    install = async (run) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      trees(run.cwd);
      return end();
    };
    const first = prepare();
    await vi.waitFor(() => expect(installs()).toHaveLength(1));
    expect(installer.busy(request.repoPath)).toBe(true);
    await expect(prepare(1)).rejects.toMatchObject({
      code: 'workspace_dependencies_pending',
      details: { startedAt: expect.any(String) },
    });
    expect(installs()[0]!.signal.aborted).toBe(false);
    const joined = prepare();
    release();
    expect(await joined).toEqual(await first);
    expect(installs()).toHaveLength(1);
    expect(installer.busy(request.repoPath)).toBe(false);
  });

  it('prepares another clone independently', async () => {
    await prepare();
    const other = {
      ...request,
      member: 'reviewer',
      repoPath: path.join(root, 'workspaces/PM/reviewer/app/repo'),
    };
    for (const file of ['package.json', 'package-lock.json', 'apps/server/package.json'])
      write(other.repoPath, file, readFileSync(path.join(request.repoPath, file), 'utf8'));
    expect(await installer.prepare(other, { waitMs: 10_000 })).toMatchObject({
      status: 'ready',
      changed: true,
    });
    expect(installs()).toHaveLength(2);
  });

  it.each([
    ['install_failed', { exitCode: 23 }],
    ['timeout', { timedOut: true, exitCode: null, signal: 'SIGTERM' as const }],
  ])(
    'memoizes %s for ten minutes, retries immediately for another key, and leaves no marker',
    async (reason, ended) => {
      install = async () => end(ended);
      const failed = {
        code: 'workspace_dependencies_failed',
        details: { reason, key: expect.any(String), exitCode: ended.exitCode },
      };
      await expect(prepare()).rejects.toMatchObject(failed);
      await expect(prepare()).rejects.toMatchObject(failed);
      expect(installs()).toHaveLength(1);
      const now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now + WORKSPACE_DEPENDENCY_RETRY_MS + 1);
      await expect(prepare()).rejects.toMatchObject(failed);
      expect(installs()).toHaveLength(2);
      write(request.repoPath, 'apps/server/package.json', '{"name":"changed"}');
      await expect(prepare()).rejects.toMatchObject(failed);
      expect(installs()).toHaveLength(3);
      expect(existsSync(marker())).toBe(false);
    },
  );

  it('restarts for a key changed during installation before publishing readiness', async () => {
    install = async (run) => {
      if (installs().length === 1) write(run.cwd, 'apps/server/package.json', '{"name":"new"}');
      trees(run.cwd);
      return end();
    };
    expect(await prepare()).toMatchObject({ status: 'ready', changed: true });
    expect(installs()).toHaveLength(2);
  });

  it.each([
    '.npmrc',
    'npm-shrinkwrap.json',
    'binding.gyp',
    'hook',
    'linked-tree',
    'linked-manifest',
    'linked-parent',
  ])('refuses invalid inputs: %s', async (kind) => {
    if (kind === 'hook') write(request.repoPath, 'apps/server/package.json', '{"scripts":{"install":"bad"}}');
    else if (kind === 'linked-tree') symlinkSync(root, path.join(request.repoPath, 'node_modules'));
    else if (kind === 'linked-manifest') {
      rmSync(path.join(request.repoPath, 'package.json'));
      symlinkSync(
        path.join(request.repoPath, 'apps/server/package.json'),
        path.join(request.repoPath, 'package.json'),
      );
    } else if (kind === 'linked-parent') {
      rmSync(path.join(request.repoPath, 'apps/server'), { recursive: true });
      symlinkSync(root, path.join(request.repoPath, 'apps/server'));
    } else write(request.repoPath, kind);
    await expect(prepare()).rejects.toMatchObject({
      code: 'workspace_dependencies_failed',
      details: { reason: 'invalid_inputs' },
    });
    expect(installs()).toHaveLength(0);
    expect(existsSync(marker())).toBe(false);
  });

  it('refuses tracked package trees before copying or installation', async () => {
    tracked = 'PROJECTMAN_TRACKED_NODE_MODULES\0';
    await expect(prepare()).rejects.toMatchObject({ details: { reason: 'invalid_inputs' } });
    expect(installs()).toHaveLength(0);
  });

  it('does not trust a ready marker whose package directory was replaced by a symlink', async () => {
    await prepare();
    rmSync(path.join(request.repoPath, 'node_modules'), { recursive: true });
    symlinkSync(root, path.join(request.repoPath, 'node_modules'));
    await expect(prepare()).rejects.toMatchObject({ details: { reason: 'invalid_inputs' } });
    expect(installs()).toHaveLength(1);
  });

  it('aborts and awaits the installer on close, without issuing a ready marker', async () => {
    let stopped = false;
    install = async (run) => {
      await new Promise<void>((resolve) =>
        run.signal.addEventListener('abort', () => setTimeout(resolve, 20), { once: true }),
      );
      stopped = true;
      return end({ aborted: true, exitCode: null });
    };
    const pending = expect(prepare()).rejects.toMatchObject({ details: { reason: 'aborted' } });
    await vi.waitFor(() => expect(installs()).toHaveLength(1));
    await installer.close();
    expect(stopped).toBe(true);
    await pending;
    expect(installer.busy(request.repoPath)).toBe(false);
    expect(existsSync(marker())).toBe(false);
  });

  it('waits for the heavy lock and stops a queued preparation on close', async () => {
    const lock = await acquireHeavyLock({ dir: path.join(root, 'heavy'), label: 'fixture' });
    try {
      const pending = expect(prepare()).rejects.toMatchObject({ details: { reason: 'aborted' } });
      await vi.waitFor(async () =>
        expect((await readHeavyQueue(path.join(root, 'heavy'))).waiting).toHaveLength(1),
      );
      expect(installs()).toHaveLength(0);
      await installer.close();
      await pending;
    } finally {
      await lock.release();
    }
  });

  it('fails closed without a heavy queue, and retries queue errors immediately', async () => {
    write(root, 'heavy', 'not a directory');
    await expect(prepare()).rejects.toMatchObject({ details: { reason: 'heavy_lock_unavailable' } });
    rmSync(path.join(root, 'heavy'));
    expect(await prepare()).toMatchObject({ status: 'ready' });
    expect(installs()).toHaveLength(1);
  });

  it('reports a heavy queue timeout without memoizing it', async () => {
    vi.spyOn(await import('./heavy-lock'), 'acquireHeavyLock').mockRejectedValueOnce(
      new HeavyLockError('heavy_lock_timeout', 'fixture queue timeout'),
    );
    await expect(prepare()).rejects.toMatchObject({ details: { reason: 'heavy_lock_timeout' } });
    expect(installs()).toHaveLength(0);
    expect(await prepare()).toMatchObject({ status: 'ready' });
  });

  it('checks inputs again after queueing before installing the current key', async () => {
    const lock = await acquireHeavyLock({ dir: path.join(root, 'heavy'), label: 'fixture' });
    const preparing = prepare();
    try {
      await vi.waitFor(async () =>
        expect((await readHeavyQueue(path.join(root, 'heavy'))).waiting).toHaveLength(1),
      );
      write(request.repoPath, 'apps/server/package.json', '{"name":"changed-in-queue"}');
    } finally {
      await lock.release();
    }
    expect(await preparing).toMatchObject({ status: 'ready', changed: true });
    expect(installs()).toHaveLength(1);
    expect(await prepare()).toMatchObject({ status: 'ready', changed: false });
  });

  it('revokes an older marker before a failed replacement, and logs only the end of the process output', async () => {
    const info = vi.spyOn(logger, 'info');
    await prepare();
    rmSync(path.join(request.repoPath, 'apps/server/node_modules'), { recursive: true });
    const lines = Array.from({ length: 40 }, (_, index) => `fixture-line-${index}`);
    install = async (run) => {
      trees(run.cwd);
      return end({ exitCode: 23, output: lines.join('\n') });
    };
    await expect(prepare()).rejects.toMatchObject({
      details: { reason: 'install_failed', exitCode: 23, outputTail: lines.slice(-10).join('\n') },
    });
    expect(existsSync(marker())).toBe(false);
    await expect(prepare()).rejects.toMatchObject({ details: { reason: 'install_failed' } });
    expect(installs()).toHaveLength(2);
    expect(JSON.stringify(info.mock.calls)).toContain('fixture-line-39');
    expect(JSON.stringify(info.mock.calls)).not.toContain('fixture-line-29');
    expect(info.mock.calls.at(-1)?.[0]).toMatchObject({
      project: 'PM',
      member: 'dev',
      repo: 'app',
      outcome: 'install_failed',
      exitCode: 23,
      waitedMs: expect.any(Number),
    });
  });

  it('uses fixed npm settings and a secret-free environment, with only package-tree writes and registry networking', async () => {
    vi.stubEnv('NPM_TOKEN', 'fixture-token');
    try {
      let settings!: ReturnType<(typeof import('./sandbox'))['installerSettings']>;
      install = async (run) => {
        settings = JSON.parse(readFileSync(run.settings, 'utf8'));
        trees(run.cwd);
        return end();
      };
      await prepare();
      const run = installs()[0]!;
      expect(run.command).toMatch(
        /^npm ci --include=dev --include=optional --no-audit --no-fund --registry=https:\/\/registry.npmjs.org --userconfig='/,
      );
      expect(run.command).toContain('--globalconfig=');
      expect(Object.keys(run.env).some((name) => /TOKEN|API_KEY|SSH_AUTH|^PROJECTMAN_/.test(name))).toBe(
        false,
      );
      expect(settings.network).toEqual({
        allowedDomains: ['registry.npmjs.org', 'nodejs.org'],
        deniedDomains: [],
        allowLocalBinding: false,
      });
      expect(settings.filesystem.allowWrite).toEqual([
        path.dirname(run.env.HOME!),
        path.join(request.repoPath, 'node_modules'),
        path.join(request.repoPath, 'apps/server/node_modules'),
      ]);
      expect(settings.filesystem.denyRead).toContain(path.join(root, 'secrets'));
      expect(settings.filesystem.denyRead).toContain(path.join(root, 'home/workspace-deps'));
      for (const entry of ['user', 'home', 'claude-tmp', 'session-tmp', 'session-folders'])
        expect(settings.filesystem.denyRead).toContain(path.join(root, entry));
      const configFiles = ['npm-user.conf', 'npm-global.conf'].map((file) =>
        path.join(path.dirname(run.settings), file),
      );
      expect(settings.filesystem.allowRead).toEqual([
        request.repoPath,
        path.dirname(run.env.HOME!),
        ...configFiles,
      ]);
      const gitProbe = calls.find((call) => call.command.startsWith('git '))!;
      expect(gitProbe.command).toContain('-c core.fsmonitor=false -c core.hooksPath=/dev/null');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('has no unsandboxed fallback when the sandbox is unavailable', async () => {
    await installer.close();
    vi.spyOn(SandboxManager, 'isSupportedPlatform').mockReturnValue(false);
    installer = make(false);
    await expect(prepare()).rejects.toMatchObject({ details: { reason: 'sandbox_unavailable' } });
    await expect(prepare()).rejects.toMatchObject({ details: { reason: 'sandbox_unavailable' } });
    expect(calls).toHaveLength(0);
  });

  it('skips unconfigured repositories', async () => {
    await installer.close();
    installer = make(true, false);
    // The fixture has a lockfile and no node_modules: the member is told they are missing (PM-1203).
    expect(await prepare()).toEqual({ status: 'skipped', reason: 'not_configured', dependencies: 'missing' });
    expect(calls).toHaveLength(0);
  });

  it('reports an installed clone of an unconfigured repository as nothing to do, a stale one as stale', async () => {
    await installer.close();
    installer = make(true, false);
    trees(request.repoPath);
    const lock = path.join(request.repoPath, 'package-lock.json');
    utimesSync(lock, 1000, 1000);
    expect(await prepare()).toEqual({ status: 'skipped', reason: 'not_configured' });
    utimesSync(path.join(request.repoPath, 'node_modules/.package-lock.json'), 500, 500);
    expect(await prepare()).toMatchObject({ dependencies: 'stale' });
    rmSync(lock);
    expect(await prepare()).toEqual({ status: 'skipped', reason: 'not_configured' });
  });

  describe('the default setting (PM-1203)', () => {
    it('installs a clone with a lockfile like an explicit setting does', async () => {
      await installer.close();
      installer = make(true, 'implicit');
      expect(await prepare()).toMatchObject({ status: 'ready', changed: true });
      expect(installs()).toHaveLength(1);
    });

    it('skips a clone without a root lockfile', async () => {
      await installer.close();
      installer = make(true, 'implicit');
      rmSync(path.join(request.repoPath, 'package-lock.json'));
      expect(await prepare()).toEqual({ status: 'skipped', reason: 'not_configured' });
      expect(calls).toHaveLength(0);
    });

    it('skips instead of failing when no sandbox is available', async () => {
      await installer.close();
      vi.spyOn(SandboxManager, 'isSupportedPlatform').mockReturnValue(false);
      installer = make(false, 'implicit');
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await prepare()).toEqual({
          status: 'skipped',
          reason: 'unavailable',
          dependencies: 'missing',
        });
      expect(calls).toHaveLength(0);
    });

    it('skips instead of failing when the install fails, and keeps the shortfall', async () => {
      await installer.close();
      installer = make(true, 'implicit');
      install = async () => end({ exitCode: 255, output: 'npm error errno -1' });
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await prepare()).toEqual({
          status: 'skipped',
          reason: 'unavailable',
          dependencies: 'missing',
        });
      expect(installs()).toHaveLength(1);
    });
  });

  it('starts srt away from the clone, so its mandatory write denials do not cover node_modules (PM-1213)', async () => {
    await prepare();
    expect(calls.length).toBeGreaterThan(0);
    for (const run of calls) {
      expect(run.cwd).toBe(request.repoPath);
      expect(run.anchorDir).toBeDefined();
      expect(run.anchorDir!.startsWith(`${request.repoPath}${path.sep}`)).toBe(false);
    }
  });

  describe('the engine checkout (PM-1083)', () => {
    const checkoutMarker = () => path.join(root, 'home/workspace-deps', hash(['PM', 'app']), 'ready.json');
    const refresh = (repoPath = request.repoPath) =>
      installer.refreshCheckout({ project: 'PM', repo: 'app', repoPath });
    /** refreshCheckout returns at once; give a refresh that should do nothing time to prove it. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    it('runs nothing for a fresh checkout', async () => {
      trees(request.repoPath);
      refresh();
      await settle();
      expect(calls).toHaveLength(0);
    });

    it('leaves a stale checkout alone under the default setting (PM-1203)', async () => {
      await installer.close();
      installer = make(true, 'implicit');
      refresh();
      await settle();
      expect(calls).toHaveLength(0);
      expect(existsSync(checkoutMarker())).toBe(false);
    });

    it('installs a stale checkout under its own marker, leaving the clone marker alone', async () => {
      refresh();
      await vi.waitFor(() => expect(existsSync(checkoutMarker())).toBe(true));
      expect(installs()).toHaveLength(1);
      expect(existsSync(marker())).toBe(false);
    });

    it('copies from the merge store of the identical key without npm ci', async () => {
      seedMergeStore();
      write(request.repoPath, 'node_modules/stale.txt', 'old');
      refresh();
      await vi.waitFor(() => expect(existsSync(checkoutMarker())).toBe(true));
      expect(installs()).toHaveLength(0);
      expect(existsSync(path.join(request.repoPath, 'node_modules/stale.txt'))).toBe(false);
    });

    it('stamps a store copy as installed, so the checkout is fresh although the store is older', async () => {
      seedMergeStore();
      const store = path.join(root, 'worktrees/_merge-deps', hash(['PM', 'app']), 'current');
      utimesSync(path.join(store, 'node_modules/.package-lock.json'), 1000, 1000);
      refresh();
      await vi.waitFor(() => expect(existsSync(checkoutMarker())).toBe(true));
      expect(await dependencyState(request.repoPath)).toMatchObject({ fresh: true });
    });

    it('does nothing when the repository is not configured or the path is not the bound one', async () => {
      mkdirSync(path.join(root, 'elsewhere'));
      refresh(path.join(root, 'elsewhere'));
      await settle();
      expect(calls).toHaveLength(0);
      await installer.close();
      installer = make(true, false);
      refresh();
      await settle();
      expect(calls).toHaveLength(0);
    });

    it('logs a failed install without throwing', async () => {
      const info = vi.spyOn(logger, 'info');
      install = async () => end({ exitCode: 9 });
      expect(() => refresh()).not.toThrow();
      await vi.waitFor(() =>
        expect(info.mock.calls.at(-1)?.[0]).toMatchObject({
          project: 'PM',
          repo: 'app',
          checkout: true,
          outcome: 'install_failed',
          exitCode: 9,
        }),
      );
    });
  });
});
