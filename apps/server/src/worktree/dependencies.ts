import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, readdir, readFile, rename, rm, stat, statfs, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { DependencySkip, DependencyRefreshResult } from '../contracts';
import { tryGit } from './git';
import { canonical, createKeyedLock } from './paths';

export type DependencyCloneSkip = DependencySkip;
export type DependencyCloneResult = DependencyRefreshResult;

/** Caches under node_modules that may hold absolute paths into the reference. */
const CACHE_DIRS = ['.vite', '.vite-temp', '.cache'];
const LOCKFILE = 'package-lock.json';
/** The hidden lockfile npm writes into node_modules at the end of every install. */
const HIDDEN_LOCKFILE = path.join('node_modules', '.package-lock.json');
const withDependencyLock = createKeyedLock();
const DEPENDENCY_COPY_TIMEOUT_MS = 90_000;

/** The cheap freshness probe shared by the manager and the serialized clone. */
export async function dependencyState(target: string) {
  const [installedAt, lockTime] = await Promise.all([
    mtimeOrNull(path.join(target, HIDDEN_LOCKFILE)),
    mtimeOrNull(path.join(target, LOCKFILE)),
  ]);
  return {
    installedAt,
    lockTime,
    fresh: installedAt !== null && lockTime !== null && installedAt >= lockTime,
  };
}

class Skip extends Error {
  readonly reason: DependencyCloneSkip;

  constructor(reason: DependencyCloneSkip) {
    super(reason);
    this.name = 'Skip';
    this.reason = reason;
  }
}

/**
 * Clones node_modules (the root's and every workspace's) into a task worktree from an installed
 * checkout with the same lockfile, with copy-on-write file clones (APFS `clonefile`, macOS), so a
 * new or stale worktree gets its dependencies in seconds and shares the blocks (PM-332, PM-412). Nothing here
 * installs anything: the server never runs `npm install` outside the sandbox (install scripts), and
 * a clone that cannot be made is a skip or a failure that never stops the worktree: the member
 * installs as before.
 *
 * Temporary names under the final directories make the swap one rename per directory, the root
 * last: a half-made clone never looks like an installed one.
 */
export async function cloneDependencies(args: {
  /** The task's worktree. */
  target: string;
  /** Reference checkouts in order: the repo's path first, then its other worktrees (never the target). */
  candidates: string[];
  logger: FastifyBaseLogger;
  /** Default: process.platform (tests). */
  platform?: NodeJS.Platform;
  /** Default: `cp -c -R src dest` without a shell (tests). */
  copyTree?: (src: string, dest: string) => Promise<void>;
  /** Default: both checkouts on one APFS volume (tests). Throws when cloning from the reference is not possible. */
  probe?: (reference: string, target: string) => Promise<void>;
  /** Total copying budget; tests can shorten it. */
  copyTimeoutMs?: number;
}): Promise<DependencyCloneResult> {
  return withDependencyLock(await canonical(args.target), () => cloneIntoTarget(args));
}

async function cloneIntoTarget(
  args: Parameters<typeof cloneDependencies>[0],
): Promise<DependencyCloneResult> {
  const { target, logger } = args;
  const platform = args.platform ?? process.platform;
  const probe = args.probe ?? defaultProbe;
  const suffix = randomBytes(4).toString('hex');
  const temporaries: string[] = [];
  const renamed: string[] = [];
  const backups: { final: string; backup: string }[] = [];
  const started = Date.now();
  try {
    if (platform !== 'darwin') return skipped('unsupported');
    const { installedAt, lockTime, fresh } = await dependencyState(target);
    if (fresh) return skipped('present');
    const refreshing = await present(path.join(target, 'node_modules'));
    const targetLock = await readOrNull(path.join(target, LOCKFILE));
    if (!targetLock) return skipped('no_lockfile');
    // `node_modules/` (with the slash) matches a directory-only ignore pattern that does not exist yet.
    if ((await tryGit(['-C', target, 'check-ignore', '-q', 'node_modules/'])) === null)
      return skipped('not_ignored');

    const reference = await findReference(args.candidates, target, targetLock);
    if (!reference) return skipped('no_reference');

    const dirs = await dependencyDirs(reference.path, target);
    const removedDirs: string[] = [];
    if (refreshing) {
      for (const workspace of await workspaceDirs(target)) {
        if (!dirs.includes(workspace) && (await isDirectory(path.join(target, workspace, 'node_modules')))) {
          removedDirs.push(workspace);
        }
      }
    }
    try {
      await probe(reference.path, target);
    } catch {
      return skipped('unsupported');
    }

    const copyDeadline = Date.now() + (args.copyTimeoutMs ?? DEPENDENCY_COPY_TIMEOUT_MS);
    for (const dir of dirs) {
      const temporary = path.join(target, dir, `.node_modules.pm-${suffix}`);
      temporaries.push(temporary);
      const remaining = copyDeadline - Date.now();
      if (remaining <= 0) throw new Error('dependency copying timed out');
      const src = path.join(reference.path, dir, 'node_modules');
      if (args.copyTree) await boundedCopy(args.copyTree, src, temporary, remaining);
      else await defaultCopyTree(src, temporary, remaining);
      for (const cache of CACHE_DIRS) await rm(path.join(temporary, cache), { recursive: true, force: true });
    }

    // The reference's install must not have been touched while it was being copied.
    if (
      (await mtimeOrNull(path.join(reference.path, HIDDEN_LOCKFILE))) !== reference.installedAt ||
      !(await readOrNull(path.join(reference.path, LOCKFILE)))?.equals(targetLock)
    ) {
      await removeAll(temporaries);
      return skipped('reference_changed');
    }

    if (
      !(await readOrNull(path.join(target, LOCKFILE)))?.equals(targetLock) ||
      (await mtimeOrNull(path.join(target, LOCKFILE))) !== lockTime ||
      (refreshing && (await mtimeOrNull(path.join(target, HIDDEN_LOCKFILE))) !== installedAt)
    ) {
      await removeAll(temporaries);
      return skipped('target_changed');
    }

    // Workspaces first, the root last: the root's node_modules is what marks a worktree installed.
    const order = [...dirs.filter((d) => d !== '.'), ...removedDirs, '.'];
    for (const dir of order) {
      const temporary = path.join(target, dir, `.node_modules.pm-${suffix}`);
      const final = path.join(target, dir, 'node_modules');
      if (refreshing && (await present(final))) {
        const backup = path.join(target, dir, `.node_modules.pm-${suffix}-old`);
        await rename(final, backup);
        backups.push({ final, backup });
      }
      if (removedDirs.includes(dir)) continue;
      try {
        await rename(temporary, final);
        renamed.push(final);
      } catch (err) {
        if (refreshing) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw err;
        // Somebody (a concurrent install or clone) created it meanwhile: theirs stays.
        await rm(temporary, { recursive: true, force: true });
      }
    }
    if (renamed.length === 0) return skipped('present');
    if (renamed.includes(path.join(target, 'node_modules'))) {
      const now = new Date(Math.max(Date.now(), Math.ceil(lockTime ?? 0)));
      await utimes(path.join(target, HIDDEN_LOCKFILE), now, now);
    }
    await removeAll(backups.map(({ backup }) => backup));
    const done = order.filter(
      (dir) => removedDirs.includes(dir) || renamed.includes(path.join(target, dir, 'node_modules')),
    );
    return {
      status: refreshing ? 'refreshed' : 'cloned',
      reference: reference.path,
      dirs: done.map((d) => (d === '.' ? '.' : d.split(path.sep).join('/'))),
      ms: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof Skip) {
      await removeAll(temporaries);
      return skipped(err.reason);
    }
    // Leave nothing half-made behind: the temporaries and the directories renamed so far.
    await removeAll(temporaries);
    await removeAll(renamed);
    for (const { final, backup } of backups.reverse()) await rename(backup, final);
    logger.warn(
      { target, err: err instanceof Error ? err.message : String(err) },
      'cloning the dependencies failed; the member installs them',
    );
    return skipped('failed');
  }
}

function skipped(reason: DependencyCloneSkip): DependencyCloneResult {
  return { status: 'skipped', reason };
}

/** The first candidate with the target's lockfile (byte for byte) and an install after its last change. */
async function findReference(
  candidates: string[],
  target: string,
  targetLock: Buffer,
): Promise<{ path: string; installedAt: number } | null> {
  const resolvedTarget = path.resolve(target);
  for (const candidate of candidates) {
    if (path.resolve(candidate) === resolvedTarget) continue;
    const lock = await readOrNull(path.join(candidate, LOCKFILE));
    if (!lock || !lock.equals(targetLock)) continue;
    const lockTime = await mtimeOrNull(path.join(candidate, LOCKFILE));
    const installedAt = await mtimeOrNull(path.join(candidate, HIDDEN_LOCKFILE));
    if (lockTime === null || installedAt === null || installedAt < lockTime) continue;
    return { path: candidate, installedAt };
  }
  return null;
}

/**
 * The directories whose node_modules is cloned, relative to the checkout: the root (`.`) and
 * every workspace that has one in the reference and exists in the target.
 */
async function dependencyDirs(reference: string, target: string): Promise<string[]> {
  const dirs = ['.'];
  for (const workspace of await workspaceDirs(reference)) {
    if (!(await isFile(path.join(target, workspace, 'package.json')))) continue;
    if (!(await isDirectory(path.join(reference, workspace, 'node_modules')))) continue;
    dirs.push(workspace);
  }
  return dirs;
}

/** The root package.json's workspaces: `dir/*` (the subdirectories of `dir`) or a plain path; anything else is unsupported. */
async function workspaceDirs(reference: string): Promise<string[]> {
  const raw = await readOrNull(path.join(reference, 'package.json'));
  if (!raw) return [];
  const workspaces = (JSON.parse(raw.toString('utf8')) as { workspaces?: unknown }).workspaces;
  if (workspaces === undefined) return [];
  if (!Array.isArray(workspaces)) throw new Skip('unsupported');
  const found: string[] = [];
  for (const entry of workspaces) {
    if (typeof entry !== 'string') throw new Skip('unsupported');
    const pattern = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    const wildcard = pattern.endsWith('/*');
    const base = wildcard ? pattern.slice(0, -2) : pattern;
    const segments = base.split('/');
    if (
      !base ||
      path.isAbsolute(base) ||
      segments.some((s) => !s || s === '.' || s === '..' || /[*?[\]{}!()]/.test(s))
    )
      throw new Skip('unsupported');
    if (!wildcard) {
      found.push(path.normalize(base));
      continue;
    }
    for (const child of await readdirOrEmpty(path.join(reference, base))) {
      if (child.isDirectory() && child.name !== 'node_modules') found.push(path.join(base, child.name));
    }
  }
  return found;
}

async function present(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function readOrNull(p: string): Promise<Buffer | null> {
  try {
    return await readFile(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw err;
  }
}

async function mtimeOrNull(p: string): Promise<number | null> {
  try {
    return (await stat(p)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function isFile(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isFile() ?? false;
}

async function isDirectory(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => null))?.isDirectory() ?? false;
}

async function readdirOrEmpty(p: string) {
  return readdir(p, { withFileTypes: true }).catch(() => []);
}

async function removeAll(paths: string[]): Promise<void> {
  for (const p of paths) await rm(p, { recursive: true, force: true }).catch(() => undefined);
}

/** macOS `f_type` of APFS (VT_APFS). */
const APFS_TYPE = 26;

/**
 * `clonefile` works within one APFS volume. Node cannot force a file clone on macOS (libuv answers
 * ENOSYS to COPYFILE_FICLONE_FORCE), and `cp -c` falls back to a plain copy by itself, so the
 * volume is checked instead: the same device, and APFS.
 */
async function defaultProbe(reference: string, target: string): Promise<void> {
  const [from, to] = await Promise.all([stat(reference), stat(target)]);
  if (from.dev !== to.dev) throw new Error('the checkouts are on different volumes');
  if ((await statfs(target)).type !== APFS_TYPE) throw new Error('the volume is not APFS');
}

/** `-R` keeps symbolic links as links, so a workspace link stays relative and points at the copy's own package. */
function defaultCopyTree(src: string, dest: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('cp', ['-c', '-R', src, dest], { windowsHide: true, timeout }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`cp -c -R failed: ${stderr.trim() || error.message}`));
      else resolve();
    });
  });
}

/** Bounds injected test copies; production cp is killed and awaited by execFile on timeout. */
async function boundedCopy(
  copy: (src: string, dest: string) => Promise<void>,
  src: string,
  dest: string,
  timeout: number,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      copy(src, dest),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('dependency copying timed out')), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
