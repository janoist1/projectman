import { lstat, mkdir, realpath, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { MEMBER_SANDBOX_DIRS, SANDBOX_GIT_CONFIG, SANDBOX_GIT_CONFIG_FILE } from '../contracts';

/** The bytes free for an unprivileged user on the volume of `dir` (`statfs`, the same on every platform). */
export async function freeBytesOf(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * The member's sandbox directory with its npm cache and development data, made if missing (PM-193).
 * Two small local directories and a file; the git settings are written at every call, so the
 * commands' git settings are always the current ones (PM-216). Rejects with the disk's own error.
 */
export async function prepareMemberSandboxDir(dir: string): Promise<void> {
  for (const sub of MEMBER_SANDBOX_DIRS)
    await mkdir(path.join(dir, sub.name), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, SANDBOX_GIT_CONFIG_FILE), SANDBOX_GIT_CONFIG, { mode: 0o600 });
}

/**
 * The writable paths a CLI with a sandbox of its own takes from ours (`AgentSandbox.portable`,
 * PM-346), made so it gets an existing path. A failure is logged, never thrown: the start goes on.
 */
export async function preparePortablePaths(
  paths: readonly string[],
  logger: FastifyBaseLogger,
): Promise<void> {
  for (const dir of paths) {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      logger.warn({ path: dir, err }, 'could not make a writable path of the session sandbox');
    }
  }
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
