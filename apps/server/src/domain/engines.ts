import os from 'node:os';
import { LOCAL_ENGINE_ID } from '@projectman/shared';
import type { EngineId, MemberHandle, Session } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type {
  EngineDirectory,
  EngineHost,
  EnginePaths,
  FullTestExecutor,
  MemberWorkspaceManager,
  RuntimeBoundary,
  ScreenshotExecutor,
  WorktreeManager,
} from '../contracts';
import { createLocalEngineHost } from '../engine-host';
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
 * The engine of the machine the server runs on (`local`), from the options the domain was given.
 * Its disk is the local engine host's (`engine-host/`, PM-312); this assembles the places and the
 * parts that are not the disk's.
 */
export function createLocalEngine(opts: LocalEngineOptions, logger: FastifyBaseLogger): EngineHost {
  const userHome = opts.userHome ?? os.homedir();
  const disk = createLocalEngineHost(
    {
      userHome,
      ...(opts.sessionFoldersDir ? { sessionFoldersDir: opts.sessionFoldersDir } : {}),
      ...(opts.sessionTmpDir ? { sessionTmpDir: opts.sessionTmpDir } : {}),
      ...(opts.heavyLockDir ? { heavyLockDir: opts.heavyLockDir } : {}),
      sessionFoldersOff: opts.runtimeBoundary?.mode === 'managed_vm',
      ...(opts.claudeTmpBase ? { claudeTmpBase: opts.claudeTmpBase } : {}),
      ...(opts.claudeTmpRoots ? { claudeTmpRoots: opts.claudeTmpRoots } : {}),
      ...(opts.freeDiskBytes ? { freeDiskBytes: opts.freeDiskBytes } : {}),
    },
    logger,
  );
  const { claudeTmpRoots, gitExcludesFile, ...operations } = disk;
  const alive = opts.processExists ?? processExists;
  return {
    id: LOCAL_ENGINE_ID,
    paths(): EnginePaths {
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
          return gitExcludesFile();
        },
      };
    },
    worktrees: opts.worktrees,
    ...(opts.memberWorkspaces ? { memberWorkspaces: opts.memberWorkspaces } : {}),
    ...(opts.fullTestExecutor ? { fullTestExecutor: opts.fullTestExecutor } : {}),
    ...(opts.screenshotExecutor ? { screenshotExecutor: opts.screenshotExecutor } : {}),
    ...operations,
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
