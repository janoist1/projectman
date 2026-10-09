import os from 'node:os';
import path from 'node:path';
import { LOCAL_ENGINE_ID } from '@projectman/shared';
import type { EngineId, MemberHandle, Session } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type {
  EngineDirectory,
  EngineHost,
  EnginePaths,
  EngineSessionFolders,
  FullTestExecutor,
  MemberWorkspaceManager,
  RuntimeBoundary,
  ScreenshotExecutor,
  WorktreeManager,
} from '../contracts';
import { isWithin } from './command-paths';
import { userExcludesFile } from './git-excludes';
import {
  prepareSessionFoldersRoot,
  prepareSessionTmpRoot,
  realpathOfNearest,
  SessionFolders,
  sharedClaudeTmpRoots,
} from './session-folders';
import { processExists } from './workspaces';
import type { ProcessProbe } from './workspaces';

/** The engine a session runs on; a session from before engines ran on the local one. */
export function engineIdOf(session: Pick<Session, 'engineId'>): EngineId {
  return session.engineId ?? LOCAL_ENGINE_ID;
}

/**
 * The optional `engineId` of a runner call: absent for the local engine, as a call has always been
 * (the runner reads a missing id as `local`), so the local runner and its tests see no change.
 */
export function engineOption(engineId: EngineId): { engineId?: EngineId } {
  return engineId === LOCAL_ENGINE_ID ? {} : { engineId };
}

/** What the machine the server runs on is made of: the single-machine installation's one engine. */
export interface LocalEngineOptions {
  worktrees: WorktreeManager;
  memberWorkspaces?: MemberWorkspaceManager;
  fullTestExecutor?: FullTestExecutor;
  screenshotExecutor?: ScreenshotExecutor;
  freeDiskBytes?: () => Promise<number | null>;
  processExists?: ProcessProbe;
  /** The project's working directory; null: the project is not known (not loaded). */
  workspacePath: (projectKey: string) => string | null;
  runtimeBoundary?: RuntimeBoundary;
  appHome?: string;
  userHome?: string;
  worktreesRootDir?: string;
  workspacesRootDir?: string;
  installDir?: string;
  sessionFoldersDir?: string;
  sessionTmpDir?: string;
  claudeTmpBase?: string;
  claudeTmpRoots?: readonly string[];
  browsersDir?: string;
  heavyLockDir?: string;
}

/**
 * The session folders of an engine (PM-268, PM-339): `undefined` when they are off, which they are
 * when no root is configured, in the managed VM, and when the root is not a safe directory (logged).
 * A temporary root that is not safe turns off only the Codex folders.
 */
function prepareSessionFolders(
  opts: LocalEngineOptions,
  logger: FastifyBaseLogger,
): EngineSessionFolders | undefined {
  if (!opts.sessionFoldersDir || opts.runtimeBoundary?.mode === 'managed_vm') return undefined;
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

/** The engine of the machine the server runs on (`local`), from the options the domain was given. */
export function createLocalEngine(opts: LocalEngineOptions, logger: FastifyBaseLogger): EngineHost {
  // Once at the start: the roots of this machine's Claude Code (PM-353).
  const claudeTmpRoots = opts.claudeTmpRoots ?? sharedClaudeTmpRoots({ claudeTmpBase: opts.claudeTmpBase });
  const sessionFolders = prepareSessionFolders(opts, logger);
  const alive = opts.processExists ?? processExists;
  return {
    id: LOCAL_ENGINE_ID,
    paths(): EnginePaths {
      const userHome = opts.userHome ?? os.homedir();
      return {
        userHome,
        home: opts.appHome ?? null,
        worktreesRoot: opts.worktreesRootDir ?? null,
        workspacesRoot: opts.workspacesRootDir ?? null,
        installDir: opts.installDir ?? null,
        sessionFoldersRoot: opts.sessionFoldersDir ?? null,
        sessionTmpRoot: opts.sessionTmpDir ?? null,
        claudeTmpRoots,
        browsersDir: opts.browsersDir ?? null,
        heavyLockDir: opts.heavyLockDir ?? null,
        // Read when asked for, as a session start always has: the user may change the git configuration.
        get gitExcludesFile() {
          return userExcludesFile(userHome) ?? null;
        },
      };
    },
    worktrees: opts.worktrees,
    ...(opts.memberWorkspaces ? { memberWorkspaces: opts.memberWorkspaces } : {}),
    ...(opts.fullTestExecutor ? { fullTestExecutor: opts.fullTestExecutor } : {}),
    ...(opts.screenshotExecutor ? { screenshotExecutor: opts.screenshotExecutor } : {}),
    ...(sessionFolders ? { sessionFolders } : {}),
    freeDiskBytes: opts.freeDiskBytes ?? (async () => null),
    processExists: alive,
    workspacePath: opts.workspacePath,
  };
}

/** The directory of a single-machine installation: one engine, `local`, always connected. */
export class LocalEngineDirectory implements EngineDirectory {
  private readonly engine: EngineHost;

  constructor(engine: EngineHost) {
    this.engine = engine;
  }

  get(id: EngineId): EngineHost | null {
    return id === this.engine.id ? this.engine : null;
  }

  ids(): EngineId[] {
    return [this.engine.id];
  }

  engineFor(_projectKey: string, _member: MemberHandle): EngineId | null {
    return this.engine.id;
  }

  /** The one engine never connects or disconnects, so a listener is never called. */
  onChange(_listener: (id: EngineId, online: boolean) => void): () => void {
    return () => {};
  }
}
