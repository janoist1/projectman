import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, readdir, readFile, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { tryGit } from './git';

export type DependencyCloneSkip =
  | 'present' // the worktree has node_modules already
  | 'no_lockfile' // no package-lock.json in the worktree
  | 'not_ignored' // git does not ignore node_modules there
  | 'no_reference' // no candidate with the same lockfile and an install after its last change
  | 'unsupported' // not darwin, the clone probe failed (other volume, no APFS), or a workspaces entry other than `dir/*` or a plain path
  | 'reference_changed' // the reference's hidden lockfile changed during the clone
  | 'failed'; // anything else (logged with the error)

export type DependencyCloneResult =
  | { status: 'cloned'; reference: string; dirs: string[]; ms: number }
  | { status: 'skipped'; reason: DependencyCloneSkip };

/** Caches under node_modules that may hold absolute paths into the reference. */
const CACHE_DIRS = ['.vite', '.vite-temp', '.cache'];
const LOCKFILE = 'package-lock.json';
/** The hidden lockfile npm writes into node_modules at the end of every install. */
const HIDDEN_LOCKFILE = path.join('node_modules', '.package-lock.json');

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
 * new worktree gets its dependencies in seconds and shares the blocks (PM-332). Nothing here
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
}): Promise<DependencyCloneResult> {
  const { target, logger } = args;
  const platform = args.platform ?? process.platform;
  const copyTree = args.copyTree ?? defaultCopyTree;
  const probe = args.probe ?? defaultProbe;
  const suffix = randomBytes(4).toString('hex');
  const temporaries: string[] = [];
  const renamed: string[] = [];
  const started = Date.now();
  try {
    if (platform !== 'darwin') return skipped('unsupported');
    if (await present(path.join(target, 'node_modules'))) return skipped('present');
    const targetLock = await readOrNull(path.join(target, LOCKFILE));
    if (!targetLock) return skipped('no_lockfile');
    // `node_modules/` (with the slash) matches a directory-only ignore pattern that does not exist yet.
    if ((await tryGit(['-C', target, 'check-ignore', '-q', 'node_modules/'])) === null)
      return skipped('not_ignored');

    const reference = await findReference(args.candidates, target, targetLock);
    if (!reference) return skipped('no_reference');

    const dirs = await dependencyDirs(reference.path, target);
    try {
      await probe(reference.path, target);
    } catch {
      return skipped('unsupported');
    }

    for (const dir of dirs) {
      const temporary = path.join(target, dir, `.node_modules.pm-${suffix}`);
      temporaries.push(temporary);
      await copyTree(path.join(reference.path, dir, 'node_modules'), temporary);
      for (const cache of CACHE_DIRS) await rm(path.join(temporary, cache), { recursive: true, force: true });
    }

    // The reference's install must not have been touched while it was being copied.
    if ((await mtimeOrNull(path.join(reference.path, HIDDEN_LOCKFILE))) !== reference.installedAt) {
      await removeAll(temporaries);
      return skipped('reference_changed');
    }

    // Workspaces first, the root last: the root's node_modules is what marks a worktree installed.
    const order = [...dirs.filter((d) => d !== '.'), ...dirs.filter((d) => d === '.')];
    for (const dir of order) {
      const temporary = path.join(target, dir, `.node_modules.pm-${suffix}`);
      const final = path.join(target, dir, 'node_modules');
      try {
        await rename(temporary, final);
        renamed.push(final);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw err;
        // Somebody (a concurrent install or clone) created it meanwhile: theirs stays.
        await rm(temporary, { recursive: true, force: true });
      }
    }
    if (renamed.length === 0) return skipped('present');
    const done = order.filter((dir) => renamed.includes(path.join(target, dir, 'node_modules')));
    return {
      status: 'cloned',
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
function defaultCopyTree(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('cp', ['-c', '-R', src, dest], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`cp -c -R failed: ${stderr.trim() || error.message}`));
      else resolve();
    });
  });
}
