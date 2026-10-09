import type { EngineId, MemberHandle } from '@projectman/shared';
import type { MemberWorkspaceManager, WorktreeManager } from './context';
import type { FullTestExecutor, ScreenshotExecutor } from './full-test';

/**
 * The engine (PM-311): the machine the AI sessions, their worktrees and their sandboxes live on. The
 * domain reaches every machine-dependent part through an `EngineHost` (see "Machine-dependent parts"
 * in docs/ARCHITECTURE.md); today there is one, `local`, the machine the server runs on.
 */

/** The places of an engine. `null`: the engine has none of it (the feature is off). */
export interface EnginePaths {
  /** The user's home, where the credentials are. */
  userHome: string;
  /** The installation's home (PROJECTMAN_HOME). */
  home: string | null;
  worktreesRoot: string | null;
  /** Where member workspaces live; it matters only on an engine that has `EngineHost.memberWorkspaces`. */
  workspacesRoot: string | null;
  /** The checkout the server runs from. */
  installDir: string | null;
  sessionFoldersRoot: string | null;
  /** The root of the Codex sessions' own temporary directories (PM-339, PM-353). */
  sessionTmpRoot: string | null;
  /** Claude Code's temporary roots every Claude Code process of the user shares (PM-353). */
  claudeTmpRoots: readonly string[];
  browsersDir: string | null;
  heavyLockDir: string | null;
  /** The user's global git excludes file, computed once. */
  gitExcludesFile: string | null;
}

/**
 * The part of the session folders registry (`domain/session-folders.ts`, `SessionFolders`
 * implements it) the domain uses.
 */
export interface EngineSessionFolders {
  readonly root: string;
  /** The root of the sessions' own temporary directories (Codex, PM-339); absent: none. */
  readonly tmpRoot: string | undefined;
  allocateTmp(sessionId: string): string | undefined;
  allocate(sessionId: string): string;
  make(sessionId: string, dir: string | undefined, tmpDir?: string): void;
  of(sessionId: string): string | undefined;
  remove(sessionId: string): void;
  sweep(keep: (sessionId: string) => boolean): string[];
  releaseTmpRoot(): void;
}

export interface EngineHost {
  readonly id: EngineId;
  paths(): EnginePaths;
  readonly worktrees: WorktreeManager;
  readonly memberWorkspaces?: MemberWorkspaceManager;
  readonly fullTestExecutor?: FullTestExecutor;
  readonly screenshotExecutor?: ScreenshotExecutor;
  /** The session folders of this engine; absent: they are off. */
  readonly sessionFolders?: EngineSessionFolders;
  /** null: not measurable (no start is refused for disk space). */
  freeDiskBytes(): Promise<number | null>;
  processExists(pid: number): boolean;
  /** The project's working directory on this engine; null: the engine does not hold the project. */
  workspacePath(projectKey: string): string | null;
}

export interface EngineDirectory {
  /** The engine while it can be used (connected); otherwise null. */
  get(id: EngineId): EngineHost | null;
  /** Every registered, not withdrawn engine. */
  ids(): EngineId[];
  /**
   * The engine a new session of the member starts on. Today the default one; PM-310 reads the
   * member's setting here. null: there is no engine.
   */
  engineFor(projectKey: string, member: MemberHandle): EngineId | null;
  onChange(listener: (id: EngineId, online: boolean) => void): () => void;
}
