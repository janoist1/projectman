import { lstat, realpath, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

/** The bytes free for an unprivileged user on the volume of `dir` (`statfs`, the same on every platform). */
export async function freeBytesOf(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Whether `target` is a directory (a link to one counts); false when it is not there. */
export async function isDirectory(target: string): Promise<boolean> {
  return stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/**
 * The real `.git` directory of the repository at `repoPath`; null when it has none (a linked
 * worktree's `.git` is a file, and a missing path has nothing).
 */
export async function resolveGitDir(repoPath: string): Promise<string | null> {
  try {
    const gitDir = await realpath(path.join(repoPath, '.git'));
    return (await stat(gitDir)).isDirectory() ? gitDir : null;
  } catch {
    return null;
  }
}

/** The real path of `target`; null when it does not exist (or cannot be resolved). */
export async function realpathOf(target: string): Promise<string | null> {
  return realpath(target).catch(() => null);
}

/** A directory that is not a symbolic link (the server made the session folder as one). */
export async function isRealDirectory(dir: string): Promise<boolean> {
  return lstat(dir).then(
    (info) => info.isDirectory(),
    () => false,
  );
}
