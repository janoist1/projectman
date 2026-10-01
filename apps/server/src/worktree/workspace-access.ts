import { mkdir, rename, rm } from 'node:fs/promises';
import { git } from './git';

/**
 * Settings for every git command the server runs in a member workspace or reads from one. The
 * member controls those repositories (their config, hooks and attributes), so this git runs no
 * hooks or fsmonitor, reads no system or global configuration (`isolatedConfig` locally), and
 * transfers objects only over local paths. Filters a repository's own configuration defines still
 * apply to a checkout: where that matters, the commands run as the member's worker account
 * (`WorkspaceAccess` of the managed VM, PM-140), never as the server.
 */
export const SAFE_GIT_SETTINGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'init.templateDir=',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.file.allow=always',
  '-c',
  'advice.detachedHead=false',
  '--no-replace-objects',
];

/** A repository a workspace receives commits from, and who owns its files (null: the server). */
export interface TransferSource {
  path: string;
  /** Refs (or `--all`) to hand over. */
  refs: string[];
  owner: string | null;
}

/**
 * How the member workspace manager touches workspaces and their sources (PM-138, PM-140). `owner`
 * is the member whose files a path holds; null is the server's own (the project repository, or
 * every path when the server and the members share one account).
 */
export interface WorkspaceAccess {
  /** Who owns the files at `path` (a workspace below a member's home, or null). */
  ownerOf(path: string): string | null;
  /** Runs git (with SAFE_GIT_SETTINGS in front of `args`) as the owner; rejects with GitCommandError. */
  git(owner: string | null, args: string[], opts?: { timeoutMs?: number }): Promise<string>;
  mkdir(owner: string | null, dir: string): Promise<void>;
  remove(owner: string | null, target: string): Promise<void>;
  rename(owner: string | null, from: string, to: string): Promise<void>;
  /**
   * Makes the source's refs fetchable by `owner`: the source path itself when the owner may read
   * it, else a bundle handed over through the owner's spool. `done` removes what it made.
   */
  transfer(owner: string | null, source: TransferSource): Promise<{ from: string; done(): Promise<void> }>;
  /** Whether a workspace's description file can be written (only where the server owns it). */
  readonly writesDescription: boolean;
}

/** The server and the members share one account: everything runs here, as before PM-140. */
export function localWorkspaceAccess(): WorkspaceAccess {
  return {
    ownerOf: () => null,
    git: (_owner, args, opts) => git([...SAFE_GIT_SETTINGS, ...args], { ...opts, isolatedConfig: true }),
    mkdir: async (_owner, dir) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    },
    remove: (_owner, target) => rm(target, { recursive: true, force: true }),
    rename: (_owner, from, to) => rename(from, to),
    transfer: async (_owner, source) => ({ from: source.path, done: async () => undefined }),
    writesDescription: true,
  };
}
