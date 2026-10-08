import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneDependencies } from './dependencies';

/*
 * Temp repositories only. The tests inject `platform`, `probe` and `copyTree` so they run
 * anywhere; the one real `cp -c` test runs on macOS.
 */

const exec = promisify(execFile);

let configDir: string;
let base: string;
let reference: string;
let target: string;

beforeAll(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'pm-deps-gitconfig-'));
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('XDG_CONFIG_HOME', configDir);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

async function git(...args: string[]): Promise<void> {
  await exec('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
}

async function put(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

const LOCK = '{"name":"app","lockfileVersion":3}\n';

/** The files committed in the repository: the root package with two workspaces. */
async function seedRepository(root: string): Promise<void> {
  await put(root, '.gitignore', 'node_modules/\n');
  await put(root, 'package.json', JSON.stringify({ name: 'app', workspaces: ['apps/*', 'packages/shared'] }));
  await put(root, 'package-lock.json', LOCK);
  await put(root, 'apps/web/package.json', '{"name":"@app/web"}');
  await put(root, 'apps/api/package.json', '{"name":"@app/api"}');
  await put(root, 'packages/shared/package.json', '{"name":"@app/shared"}');
  await git('-C', root, 'add', '.');
  await git('-C', root, 'commit', '--quiet', '-m', 'Initial commit');
}

/** What `npm ci` leaves behind, with the hidden lockfile stamped after the lockfile. */
async function install(root: string, opts: { webModules?: boolean } = {}): Promise<void> {
  await put(root, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
  await put(root, 'node_modules/.package-lock.json', LOCK);
  await put(root, 'node_modules/.vite/deps/chunk.js', `/* ${root} */`);
  await put(root, 'node_modules/.vite-temp/x.js', 'x');
  await put(root, 'node_modules/.cache/y', 'y');
  await mkdir(path.join(root, 'node_modules/@app'), { recursive: true });
  await rm(path.join(root, 'node_modules/@app/shared'), { force: true });
  await symlink('../../packages/shared', path.join(root, 'node_modules/@app/shared'));
  if (opts.webModules ?? true) await put(root, 'apps/web/node_modules/vite/index.js', 'vite\n');
  const lockTime = new Date('2026-01-01T10:00:00Z');
  const installTime = new Date('2026-01-01T10:05:00Z');
  await utimes(path.join(root, 'package-lock.json'), lockTime, lockTime);
  await utimes(path.join(root, 'node_modules/.package-lock.json'), installTime, installTime);
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'pm-deps-')));
  reference = path.join(base, 'reference');
  target = path.join(base, 'target');
  await mkdir(reference);
  await git('init', '--quiet', '-b', 'main', reference);
  await seedRepository(reference);
  await git('-C', reference, 'worktree', 'add', '--quiet', '-b', 'task', target);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function testLogger() {
  const warnings: string[] = [];
  const noop = () => undefined;
  const logger = {
    level: 'silent',
    fatal: noop,
    error: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    warn: (obj: unknown, msg?: string) => {
      warnings.push(msg ?? String(obj));
    },
    child: () => logger,
  };
  return { logger: logger as unknown as FastifyBaseLogger, warnings };
}

/** A copy that keeps symbolic links as links, like `cp -R`. */
async function plainCopy(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true, verbatimSymlinks: true });
}

function clone(overrides: Partial<Parameters<typeof cloneDependencies>[0]> = {}) {
  const { logger, warnings } = testLogger();
  const result = cloneDependencies({
    target,
    candidates: [reference],
    logger,
    platform: 'darwin',
    copyTree: plainCopy,
    probe: async () => undefined,
    ...overrides,
  });
  return { result, warnings };
}

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

/** Temporary clone directories and probe files left in the worktree. */
async function leftovers(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.name.startsWith('.node_modules.pm-') || entry.name.startsWith('.pm-clone-probe-')) {
        found.push(path.join(dir, entry.name));
      } else if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name));
      }
    }
  }
  await walk(root);
  return found;
}

describe('cloneDependencies', { timeout: 30_000 }, () => {
  it('clones the root and the workspaces node_modules from a reference with the same lockfile', async () => {
    await install(reference);

    const { result } = clone();

    const done = await result;
    expect(done).toMatchObject({ status: 'cloned', reference, dirs: ['apps/web', '.'] });
    expect(await readFile(path.join(target, 'node_modules/left-pad/index.js'), 'utf8')).toContain('module');
    expect(await readFile(path.join(target, 'apps/web/node_modules/vite/index.js'), 'utf8')).toBe('vite\n');
    expect(await leftovers(target)).toEqual([]);
  });

  it('leaves out the caches that may hold paths into the reference', async () => {
    await install(reference);

    await clone().result;

    expect(await exists(path.join(target, 'node_modules/left-pad'))).toBe(true);
    expect(await exists(path.join(target, 'node_modules/.package-lock.json'))).toBe(true);
    for (const cache of ['.vite', '.vite-temp', '.cache']) {
      expect(await exists(path.join(target, 'node_modules', cache))).toBe(false);
    }
  });

  it('skips a workspace that is missing from the target or has no node_modules in the reference', async () => {
    await install(reference);
    await put(reference, 'apps/api/node_modules/a/index.js', 'a');
    await rm(path.join(target, 'apps/api'), { recursive: true });

    const done = await clone().result;

    expect(done).toMatchObject({ status: 'cloned', dirs: ['apps/web', '.'] });
    expect(await exists(path.join(target, 'apps/api'))).toBe(false);
    expect(await exists(path.join(target, 'packages/shared/node_modules'))).toBe(false);
  });

  it('skips on another platform than darwin', async () => {
    await install(reference);

    expect(await clone({ platform: 'linux' }).result).toEqual({ status: 'skipped', reason: 'unsupported' });
    expect(await exists(path.join(target, 'node_modules'))).toBe(false);
  });

  it('refreshes an existing node_modules with no hidden npm lockfile', async () => {
    await install(reference);
    await mkdir(path.join(target, 'node_modules'));

    expect(await clone().result).toMatchObject({ status: 'refreshed' });
    expect(await exists(path.join(target, 'node_modules/left-pad'))).toBe(true);
  });

  it('skips a worktree without a lockfile', async () => {
    await install(reference);
    await rm(path.join(target, 'package-lock.json'));

    expect(await clone().result).toEqual({ status: 'skipped', reason: 'no_lockfile' });
  });

  async function staleTarget(): Promise<void> {
    await install(target);
    await put(target, 'node_modules/obsolete/index.js', 'old');
    await put(target, 'apps/web/node_modules/vite/index.js', 'old');
    const changed = new Date('2026-01-01T11:00:00Z');
    await utimes(path.join(target, 'package-lock.json'), changed, changed);
  }

  it('replaces stale root and workspace dependencies and skips a second refresh', async () => {
    await install(reference);
    await staleTarget();
    await put(reference, 'node_modules/new-package/index.js', 'new');

    expect(await clone().result).toMatchObject({ status: 'refreshed', dirs: ['apps/web', '.'] });
    expect(await exists(path.join(target, 'node_modules/obsolete'))).toBe(false);
    expect(await readFile(path.join(target, 'node_modules/new-package/index.js'), 'utf8')).toBe('new');
    expect(await readFile(path.join(target, 'apps/web/node_modules/vite/index.js'), 'utf8')).toBe('vite\n');
    expect(await clone().result).toEqual({ status: 'skipped', reason: 'present' });
    expect(await leftovers(target)).toEqual([]);
  });

  it('keeps stale dependencies when no matching reference is available', async () => {
    await staleTarget();

    expect(await clone().result).toEqual({ status: 'skipped', reason: 'no_reference' });
    expect(await exists(path.join(target, 'node_modules/obsolete'))).toBe(true);
    expect(await readFile(path.join(target, 'apps/web/node_modules/vite/index.js'), 'utf8')).toBe('old');
  });

  it('removes stale workspace modules absent from the new reference', async () => {
    await install(reference, { webModules: false });
    await staleTarget();

    expect(await clone().result).toMatchObject({ status: 'refreshed', dirs: ['apps/web', '.'] });
    expect(await exists(path.join(target, 'apps/web/node_modules'))).toBe(false);
    expect(await exists(path.join(target, 'node_modules/obsolete'))).toBe(false);
    expect(await leftovers(target)).toEqual([]);
  });

  it('leaves workspace module symlinks and their external targets alone', async () => {
    await install(reference, { webModules: false });
    await staleTarget();
    const external = path.join(base, 'external-modules');
    await put(external, 'marker', 'keep');
    const link = path.join(target, 'apps/web/node_modules');
    await rm(link, { recursive: true });
    await symlink(external, link);

    expect(await clone().result).toMatchObject({ status: 'refreshed', dirs: ['.'] });
    expect(await readlink(link)).toBe(external);
    expect(await readFile(path.join(external, 'marker'), 'utf8')).toBe('keep');
  });

  it('does not copy a fresh installation', async () => {
    await install(target);
    const copyTree = vi.fn(plainCopy);

    expect(await clone({ copyTree }).result).toEqual({ status: 'skipped', reason: 'present' });
    expect(copyTree).not.toHaveBeenCalled();
  });

  it('keeps stale dependencies when a copy never completes', async () => {
    await install(reference);
    await staleTarget();

    expect(await clone({ copyTree: () => new Promise(() => undefined), copyTimeoutMs: 10 }).result).toEqual({
      status: 'skipped',
      reason: 'failed',
    });
    expect(await exists(path.join(target, 'node_modules/obsolete'))).toBe(true);
    expect(await readFile(path.join(target, 'apps/web/node_modules/vite/index.js'), 'utf8')).toBe('old');
    expect(await leftovers(target)).toEqual([]);
  });

  it('keeps stale dependencies when the reference changes during copying', async () => {
    await install(reference);
    await staleTarget();
    const copyTree = async (src: string, dest: string) => {
      await plainCopy(src, dest);
      await put(reference, 'package-lock.json', 'changed');
    };

    expect(await clone({ copyTree }).result).toEqual({ status: 'skipped', reason: 'reference_changed' });
    expect(await exists(path.join(target, 'node_modules/obsolete'))).toBe(true);
    expect(await leftovers(target)).toEqual([]);
  });

  it('keeps stale dependencies when copying the replacement fails', async () => {
    await install(reference);
    await staleTarget();
    let copies = 0;
    const copyTree = async (src: string, dest: string) => {
      if (++copies === 2) throw new Error('disk full');
      await plainCopy(src, dest);
    };

    expect(await clone({ copyTree }).result).toEqual({ status: 'skipped', reason: 'failed' });
    expect(await exists(path.join(target, 'node_modules/obsolete'))).toBe(true);
    expect(await readFile(path.join(target, 'apps/web/node_modules/vite/index.js'), 'utf8')).toBe('old');
    expect(await leftovers(target)).toEqual([]);
  });

  it.each([true, false])(
    'restores root and workspace backups on failure (reference workspace modules: %s)',
    async (webModules) => {
      await install(reference, { webModules });
      await staleTarget();
      const copyTree = async (src: string, dest: string) => {
        await plainCopy(src, dest);
        if (src === path.join(reference, 'node_modules')) {
          await rm(path.join(dest, '.package-lock.json'));
        }
      };

      expect(await clone({ copyTree }).result).toEqual({ status: 'skipped', reason: 'failed' });
      expect(await exists(path.join(target, 'node_modules/obsolete'))).toBe(true);
      expect(await readFile(path.join(target, 'apps/web/node_modules/vite/index.js'), 'utf8')).toBe('old');
      expect(await leftovers(target)).toEqual([]);
    },
  );

  it('discards a replacement when the target lock changes during copying', async () => {
    await install(reference);
    await staleTarget();
    const copyTree = async (src: string, dest: string) => {
      await plainCopy(src, dest);
      await put(target, 'package-lock.json', 'changed again');
    };

    expect(await clone({ copyTree }).result).toEqual({ status: 'skipped', reason: 'target_changed' });
    expect(await exists(path.join(target, 'node_modules/obsolete'))).toBe(true);
    expect(await leftovers(target)).toEqual([]);
  });

  it('serializes concurrent refreshes of the same worktree', async () => {
    await install(reference);
    await staleTarget();
    const copyTree = vi.fn(plainCopy);

    const results = await Promise.all([clone({ copyTree }).result, clone({ copyTree }).result]);

    expect(results[0]).toMatchObject({ status: 'refreshed' });
    expect(results[1]).toEqual({ status: 'skipped', reason: 'present' });
    expect(copyTree).toHaveBeenCalledTimes(2);
    expect(await leftovers(target)).toEqual([]);
  });

  it('skips a worktree where git does not ignore node_modules', async () => {
    await install(reference);
    await rm(path.join(target, '.gitignore'));

    expect(await clone().result).toEqual({ status: 'skipped', reason: 'not_ignored' });
    expect(await exists(path.join(target, 'node_modules'))).toBe(false);
  });

  it('skips when no candidate has the same lockfile', async () => {
    await install(reference);
    await put(reference, 'package-lock.json', '{"name":"app","lockfileVersion":3,"packages":{}}\n');
    await install(reference);

    expect(await clone().result).toEqual({ status: 'skipped', reason: 'no_reference' });
  });

  it('skips a candidate whose install is older than its lockfile', async () => {
    await install(reference);
    const older = new Date('2026-01-01T09:00:00Z');
    await utimes(path.join(reference, 'node_modules/.package-lock.json'), older, older);

    expect(await clone().result).toEqual({ status: 'skipped', reason: 'no_reference' });
  });

  it('skips when there is no candidate with node_modules', async () => {
    expect(await clone().result).toEqual({ status: 'skipped', reason: 'no_reference' });
    expect(await clone({ candidates: [] }).result).toEqual({ status: 'skipped', reason: 'no_reference' });
  });

  it('takes the first valid candidate in order and never the target itself', async () => {
    const second = path.join(base, 'second');
    await git('-C', reference, 'worktree', 'add', '--quiet', '-b', 'second', second);
    const third = path.join(base, 'third');
    await git('-C', reference, 'worktree', 'add', '--quiet', '-b', 'third', third);
    await install(second);
    await put(second, 'node_modules/marker', 'second');
    await install(third);
    await put(third, 'node_modules/marker', 'third');
    await install(target);
    await rm(path.join(target, 'node_modules'), { recursive: true });
    // the reference is not installed, the target is listed: the second is the first valid one
    const done = await clone({ candidates: [reference, target, second, third] }).result;

    expect(done).toMatchObject({ status: 'cloned', reference: second });
    expect(await readFile(path.join(target, 'node_modules/marker'), 'utf8')).toBe('second');
  });

  it('takes a later candidate when the first has another lockfile', async () => {
    const second = path.join(base, 'second');
    await git('-C', reference, 'worktree', 'add', '--quiet', '-b', 'second', second);
    await install(reference);
    await put(reference, 'package-lock.json', '{"name":"app","lockfileVersion":3,"changed":1}\n');
    await install(second);

    const done = await clone({ candidates: [reference, second] }).result;

    expect(done).toMatchObject({ status: 'cloned', reference: second });
  });

  it('skips a workspaces entry other than dir/* or a plain path', async () => {
    await put(reference, 'package.json', JSON.stringify({ name: 'app', workspaces: ['apps/**'] }));
    await install(reference);

    expect(await clone().result).toEqual({ status: 'skipped', reason: 'unsupported' });
    expect(await exists(path.join(target, 'node_modules'))).toBe(false);
    expect(await leftovers(target)).toEqual([]);
  });

  it('skips when the clone probe fails (another volume, no APFS), and copies nothing', async () => {
    await install(reference);
    const probe = vi.fn(async () => {
      throw new Error('the checkouts are on different volumes');
    });
    const copyTree = vi.fn(plainCopy);

    expect(await clone({ probe, copyTree }).result).toEqual({ status: 'skipped', reason: 'unsupported' });
    expect(probe).toHaveBeenCalledWith(reference, target);
    expect(copyTree).not.toHaveBeenCalled();
    expect(await leftovers(target)).toEqual([]);
    expect(await exists(path.join(target, 'node_modules'))).toBe(false);
  });

  it('removes everything when the reference was installed again during the clone', async () => {
    await install(reference);
    const copyTree = async (src: string, dest: string) => {
      await plainCopy(src, dest);
      const later = new Date('2026-01-01T11:00:00Z');
      await utimes(path.join(reference, 'node_modules/.package-lock.json'), later, later);
    };

    expect(await clone({ copyTree }).result).toEqual({ status: 'skipped', reason: 'reference_changed' });
    expect(await leftovers(target)).toEqual([]);
    expect(await exists(path.join(target, 'node_modules'))).toBe(false);
    expect(await exists(path.join(target, 'apps/web/node_modules'))).toBe(false);
  });

  it('keeps what a concurrent install created and drops its own copy', async () => {
    await install(reference, { webModules: false });
    const copyTree = async (src: string, dest: string) => {
      await plainCopy(src, dest);
      await put(target, 'node_modules/theirs/index.js', 'theirs');
    };

    expect(await clone({ copyTree }).result).toEqual({ status: 'skipped', reason: 'present' });
    expect(await readdir(path.join(target, 'node_modules'))).toEqual(['theirs']);
    expect(await leftovers(target)).toEqual([]);
  });

  it('reports only the directories it made when a concurrent install made the root', async () => {
    await install(reference);
    const copyTree = async (src: string, dest: string) => {
      await plainCopy(src, dest);
      await put(target, 'node_modules/theirs/index.js', 'theirs');
    };

    const done = await clone({ copyTree }).result;

    expect(done).toMatchObject({ status: 'cloned', dirs: ['apps/web'] });
    expect(await readdir(path.join(target, 'node_modules'))).toEqual(['theirs']);
    expect(await leftovers(target)).toEqual([]);
  });

  it('fails softly: logs a warning and leaves no temporary directory when the copy fails', async () => {
    await install(reference);
    let copies = 0;
    const copyTree = async (src: string, dest: string) => {
      if (++copies === 2) throw new Error('cp: disk full');
      await plainCopy(src, dest);
    };

    const { result, warnings } = clone({ copyTree });

    expect(await result).toEqual({ status: 'skipped', reason: 'failed' });
    expect(warnings).toHaveLength(1);
    expect(await leftovers(target)).toEqual([]);
    expect(await exists(path.join(target, 'node_modules'))).toBe(false);
    expect(await exists(path.join(target, 'apps/web/node_modules'))).toBe(false);
  });

  it('fails softly on a root package.json it cannot read', async () => {
    await install(reference);
    await put(reference, 'package.json', '{ not json');

    const { result, warnings } = clone();

    expect(await result).toEqual({ status: 'skipped', reason: 'failed' });
    expect(warnings).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'darwin')(
    'clones with the real cp -c and keeps workspace links relative, pointing at the target',
    async () => {
      await install(reference);
      await put(reference, 'node_modules/.vite/leftover', 'x');

      const done = await clone({ platform: undefined, copyTree: undefined, probe: undefined }).result;

      expect(done).toMatchObject({ status: 'cloned', reference });
      const link = path.join(target, 'node_modules/@app/shared');
      expect(await readlink(link)).toBe('../../packages/shared');
      expect(await realpath(link)).toBe(path.join(target, 'packages/shared'));
      expect((await stat(path.join(target, 'node_modules/left-pad/index.js'))).isFile()).toBe(true);
      expect(await exists(path.join(target, 'node_modules/.vite'))).toBe(false);
      expect(await leftovers(target)).toEqual([]);
      // the reference is untouched
      expect(await readFile(path.join(reference, 'node_modules/.vite/leftover'), 'utf8')).toBe('x');
    },
  );
});
