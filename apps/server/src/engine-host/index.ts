import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { EngineHost, EngineSessionFolders } from '../contracts';
import {
  isDirectory,
  isRealDirectory,
  prepareMemberSandboxDir,
  preparePortablePaths,
  realpathOf,
  resolveGitDir,
} from './disk';
import { userExcludesFile } from './git-excludes';
import { listImages, resolveScenario } from './screenshots';
import {
  prepareSessionFoldersRoot,
  prepareSessionTmpRoot,
  realpathOfNearest,
  SessionFolders,
  sharedClaudeTmpRoots,
} from './session-folders';
import { isWithin } from './within';
import { openWorkspaceFile } from './workspace-file';

/**
 * The engine host of the machine the server runs on (PM-312): everything the domain does to a disk
 * goes through `EngineHost` (`contracts/engine.ts`), and this module is what answers it here. The
 * checks (`attach_file`'s links and sizes, the session folders' ownership and renames) live in these
 * files and move with them to the machine of a remote engine. The domain keeps the decisions
 * (`DiskGuard`, the team tools, `ScreenshotRuns`).
 */
export { freeBytesOf } from './disk';
export { openWorkspaceFile } from './workspace-file';
export type { WorkspaceFileHooks } from './workspace-file';
export { userExcludesFile } from './git-excludes';
export { createLocalBranchMerger } from './branch-merger';
export type { LocalBranchMergerOptions } from './branch-merger';
export { isBranchName, isCommitId, isMergeId, isMergeMessage, MERGE_MESSAGE_MAX } from './merge-input';
export { listImages, resolveScenario } from './screenshots';
export {
  defaultSessionTmpRoot,
  prepareSessionFoldersRoot,
  prepareSessionTmpRoot,
  realpathOfNearest,
  SessionFolders,
  sharedClaudeTmpRoots,
} from './session-folders';

/** The disk operations the local engine host answers, besides the places the domain assembles itself. */
export type LocalEngineDisk = Pick<
  EngineHost,
  | 'sessionFolders'
  | 'freeDiskBytes'
  | 'prepareMemberSandboxDir'
  | 'preparePortablePaths'
  | 'isDirectory'
  | 'resolveGitDir'
  | 'realpath'
  | 'isRealDirectory'
  | 'openWorkspaceFile'
  | 'resolveScenario'
  | 'listImages'
> & {
  /** Claude Code's temporary roots every Claude Code process of the user shares (PM-353), computed once. */
  readonly claudeTmpRoots: readonly string[];
  /** The user's global git excludes file, read when asked for (the user may change the git configuration). */
  gitExcludesFile(): string | null;
};

export interface LocalEngineHostOptions {
  userHome: string;
  /** The session folders' root; absent: they are off. */
  sessionFoldersDir?: string;
  /** The root of the Codex sessions' own temporary directories (PM-339). */
  sessionTmpDir?: string;
  /** The heavy-run queue folder: the temporary root must not overlap its parent. */
  heavyLockDir?: string;
  /** The session folders are off whatever the roots say (the managed VM). */
  sessionFoldersOff?: boolean;
  claudeTmpBase?: string;
  claudeTmpRoots?: readonly string[];
  freeDiskBytes?: () => Promise<number | null>;
}

/**
 * The session folders of an engine (PM-268, PM-339): `undefined` when they are off, which they are
 * when no root is configured, in the managed VM, and when the root is not a safe directory (logged).
 * A temporary root that is not safe turns off only the Codex folders.
 */
function prepareSessionFolders(
  opts: LocalEngineHostOptions,
  logger: FastifyBaseLogger,
): EngineSessionFolders | undefined {
  if (!opts.sessionFoldersDir || opts.sessionFoldersOff) return undefined;
  try {
    prepareSessionFoldersRoot(opts.sessionFoldersDir);
    // One registry for the sessions (which make the folders) and the team tools (which attach from them).
    let tmpRoot: string | undefined;
    if (opts.sessionTmpDir) {
      try {
        // The queue folder's parent is writable for every member's commands: a tmp root in it (or
        // above it) would be too.
        // Compared as written and canonically: a link (or macOS `/tmp` -> `/private/tmp`) must not hide it.
        const queueParent = opts.heavyLockDir ? path.dirname(opts.heavyLockDir) : undefined;
        if (queueParent) {
          const overlaps = (a: string, b: string) => isWithin(a, b) || isWithin(b, a);
          if (
            overlaps(queueParent, opts.sessionTmpDir) ||
            overlaps(realpathOfNearest(queueParent), realpathOfNearest(opts.sessionTmpDir))
          )
            throw new Error(`${opts.sessionTmpDir} and ${queueParent}, which the sandboxes write, overlap`);
        }
        prepareSessionTmpRoot(opts.sessionTmpDir);
        tmpRoot = opts.sessionTmpDir;
      } catch (err) {
        logger.error(
          { err, dir: opts.sessionTmpDir },
          'the Codex session folders are off: their temporary root is not a safe directory',
        );
      }
    }
    return new SessionFolders(opts.sessionFoldersDir, tmpRoot, (err, dir) =>
      logger.warn({ err, dir }, 'could not remove a temporary directory of a session'),
    );
  } catch (err) {
    logger.error(
      { err, dir: opts.sessionFoldersDir },
      'the session folders are off: their root is not a safe directory',
    );
    return undefined;
  }
}

/** The disk of the machine the server runs on. */
export function createLocalEngineHost(
  opts: LocalEngineHostOptions,
  logger: FastifyBaseLogger,
): LocalEngineDisk {
  // Once at the start: the roots of this machine's Claude Code (PM-353).
  const claudeTmpRoots = opts.claudeTmpRoots ?? sharedClaudeTmpRoots({ claudeTmpBase: opts.claudeTmpBase });
  const sessionFolders = prepareSessionFolders(opts, logger);
  return {
    ...(sessionFolders ? { sessionFolders } : {}),
    claudeTmpRoots,
    gitExcludesFile: () => userExcludesFile(opts.userHome) ?? null,
    freeDiskBytes: opts.freeDiskBytes ?? (async () => null),
    prepareMemberSandboxDir,
    preparePortablePaths: (paths) => preparePortablePaths(paths, logger),
    isDirectory,
    resolveGitDir,
    realpath: realpathOf,
    isRealDirectory,
    openWorkspaceFile: (root, requested, options) => openWorkspaceFile(root, requested, options),
    resolveScenario,
    listImages,
  };
}
