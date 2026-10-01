import { randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { SessionLauncher, WorkerLayout, WorkerProgram } from '../contracts';
import { git, GitCommandError, SAFE_GIT_SETTINGS } from '../worktree';
import type { WorkspaceAccess } from '../worktree';
import { isWithin } from './config';

/**
 * Member workspaces in the managed VM (PM-138 workspaces, PM-140 boundary). A workspace lives in
 * its member's worker home and every command in it runs as that worker through the launcher, so
 * the hooks, filters and configuration the member controls never run with the server's rights.
 * Commits cross between accounts only as git bundles in the spool: the server bundles the project
 * repository into the member's `in` spool; a teammate's worker bundles its branch into its own
 * `out` spool, and the server copies that file into the receiving member's `in` spool. Each side
 * reads only what it owns or what was handed to it.
 */
/** The largest bundle handed between workers. */
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Copies a file from a worker's `out` spool, which that worker controls: not through a symlink
 * (`O_NOFOLLOW`), never blocking on a FIFO (`O_NONBLOCK`), a regular file owned by that worker
 * only, read from the descriptor that was checked. The copy is created new (`wx`).
 */
export async function copyFromWorker(from: string, to: string, ownerUid: number): Promise<void> {
  const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== ownerUid || info.nlink !== 1 || info.size > MAX_BUNDLE_BYTES)
      throw new Error(`${from} is not a bundle of its worker`);
    await pipeline(
      handle.createReadStream({ start: 0, autoClose: false }),
      createWriteStream(to, { flags: 'wx', mode: 0o640 }),
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function workerWorkspaceAccess(opts: {
  layout: WorkerLayout;
  /** The member whose worker home holds a path (`memberOfPath`), or null for the server's own. */
  ownerOf: (target: string) => string | null;
  launcher: SessionLauncher;
}): WorkspaceAccess {
  const { layout, launcher, ownerOf } = opts;

  async function run(
    owner: string,
    program: WorkerProgram,
    args: string[],
    timeoutMs?: number,
  ): Promise<string> {
    const result = await launcher.run({
      member: owner,
      program,
      args,
      cwd: layout.home(owner),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    if (result.exitCode !== 0)
      throw new GitCommandError(
        [program, ...args],
        result.stderr,
        result.exitCode,
        new Error(result.timedOut ? 'timed out' : `${program} failed`),
      );
    return result.stdout;
  }

  /** A path the worker may change: inside its workspaces. */
  function insideWorkspaces(owner: string, target: string): string {
    const resolved = path.posix.resolve(target);
    if (!isWithin(resolved, layout.workspaces(owner)))
      throw new Error(`${target} is not inside the workspaces of ${owner}`);
    return resolved;
  }

  return {
    ownerOf,
    git(owner, args, gitOpts) {
      if (owner === null) return git([...SAFE_GIT_SETTINGS, ...args], { ...gitOpts, isolatedConfig: true });
      return run(owner, 'git', [...SAFE_GIT_SETTINGS, ...args], gitOpts?.timeoutMs);
    },
    async mkdir(owner, dir) {
      if (owner === null) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        return;
      }
      // Group-readable (0750): the server reads the workspace's state and transcripts.
      await run(owner, 'mkdir', ['-p', '-m', '0750', '--', path.posix.resolve(dir)]);
    },
    async remove(owner, target) {
      if (owner === null) return rm(target, { recursive: true, force: true });
      await run(owner, 'rm', ['-rf', '--', insideWorkspaces(owner, target)]);
    },
    async rename(owner, from, to) {
      if (owner === null) return rename(from, to);
      await run(owner, 'mv', ['-T', '--', insideWorkspaces(owner, from), insideWorkspaces(owner, to)]);
    },
    async transfer(owner, source) {
      if (owner === source.owner) return { from: source.path, done: async () => undefined };
      if (owner === null) throw new Error('the server receives no hand-over from a worker');
      const id = randomBytes(8).toString('hex');
      const handed = path.posix.join(layout.spoolIn(owner), `${id}.bundle`);
      try {
        if (source.owner === null) {
          await git(
            [...SAFE_GIT_SETTINGS, '-C', source.path, 'bundle', 'create', '--quiet', handed, ...source.refs],
            {
              isolatedConfig: true,
              timeoutMs: 10 * 60_000,
            },
          );
        } else {
          // The teammate's worker bundles its own branch; the server only copies the file.
          const out = path.posix.join(layout.spoolOut(source.owner), `${id}.bundle`);
          try {
            await run(source.owner, 'git', [
              ...SAFE_GIT_SETTINGS,
              '-C',
              source.path,
              'bundle',
              'create',
              '--quiet',
              out,
              ...source.refs,
            ]);
            await copyFromWorker(out, handed, (await stat(layout.home(source.owner))).uid);
          } finally {
            await run(source.owner, 'rm', ['-f', '--', out]).catch(() => undefined);
          }
        }
        // The spool directory is set-group-id to the member's group: the file is the member's to read.
        await chmod(handed, 0o640);
      } catch (err) {
        await rm(handed, { force: true });
        throw err;
      }
      return { from: handed, done: () => rm(handed, { force: true }) };
    },
    writesDescription: false,
  };
}
