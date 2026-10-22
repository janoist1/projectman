import os from 'node:os';
import { LOCAL_ENGINE_ID } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import { STALE_LEFTOVER_MS } from '../contracts';
import type {
  EngineHost,
  EnginePaths,
  FullTestExecutor,
  MemberWorkspaceManager,
  ScreenshotExecutor,
  WorktreeManager,
  ProcessProbe,
} from '../contracts';
import { createLocalBranchMerger } from './branch-merger';
import { createLocalEngineHost } from './local-host';
import { sweepStaleChecks } from './merge-check';

/** The real probe: signal 0 to the process group, then to the process; EPERM still means it exists. */
const processExists: ProcessProbe = (pid) => {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    }
  }
  return false;
};

/** What the machine the server runs on is made of: the single-machine installation's one engine. */
export interface LocalEngineOptions {
  worktrees: WorktreeManager;
  memberWorkspaces?: MemberWorkspaceManager;
  fullTestExecutor?: FullTestExecutor;
  screenshotExecutor?: ScreenshotExecutor;
  freeDiskBytes?: () => Promise<number | null>;
  heavyRunSessions?: () => Promise<string[]>;
  processExists?: ProcessProbe;
  /** The project's working directory; null: the project is not known (not loaded). */
  workspacePath: (projectKey: string) => string | null;
  /**
   * A repository's path on this machine (PM-451); null: not bound here. With it the engine merges
   * (`EngineHost.merger`); without it, it does not.
   */
  repoPath?: (projectKey: string, repo: string) => string | null;
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
      ...(opts.claudeTmpBase ? { claudeTmpBase: opts.claudeTmpBase } : {}),
      ...(opts.claudeTmpRoots ? { claudeTmpRoots: opts.claudeTmpRoots } : {}),
      ...(opts.freeDiskBytes ? { freeDiskBytes: opts.freeDiskBytes } : {}),
    },
    logger,
  );
  const { claudeTmpRoots, gitExcludesFile, ...operations } = disk;
  const alive = opts.processExists ?? processExists;
  // The check checkouts a crash left behind, once and in the background (PM-837).
  if (opts.worktreesRootDir)
    void sweepStaleChecks(opts.worktreesRootDir, STALE_LEFTOVER_MS).then(
      (removed) => {
        if (removed > 0) logger.info({ removed }, 'removed merge check checkouts left by a crash');
      },
      (err: unknown) => logger.warn({ err }, 'sweeping the left merge check checkouts failed'),
    );
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
    ...(opts.repoPath
      ? {
          merger: createLocalBranchMerger({
            repoPath: opts.repoPath,
            worktreesRoot: opts.worktreesRootDir ?? null,
          }),
        }
      : {}),
    ...operations,
    async heavyRunSessions() {
      try {
        return (await opts.heavyRunSessions?.()) ?? [];
      } catch {
        return [];
      }
    },
    processExists: alive,
    workspacePath: opts.workspacePath,
  };
}
