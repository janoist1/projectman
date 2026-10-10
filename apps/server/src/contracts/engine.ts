import type { Readable } from 'node:stream';
import type { Attachment, EngineId, MemberHandle } from '@projectman/shared';
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
 * The variables of the session folder and of Playwright's browsers directory, set in the sandbox's
 * environment of the members that get them.
 */
export const SESSION_DIR_VARIABLE = 'PROJECTMAN_SESSION_DIR';
export const BROWSERS_PATH_VARIABLE = 'PLAYWRIGHT_BROWSERS_PATH';

/**
 * A member's own sandbox directory (PM-193): the directories in it and the variables that point
 * there: npm's cache (`npm_config_cache`, `npx` included) and the development instance's home
 * (`PROJECTMAN_HOME`, which `npm run dev` and `npm start` take). The domain computes the path
 * (`memberSandboxDir`); the engine makes the directories (`EngineHost.prepareMemberSandboxDir`).
 */
export const MEMBER_SANDBOX_DIRS = [
  { name: 'npm-cache', variable: 'npm_config_cache' },
  { name: 'projectman-dev', variable: 'PROJECTMAN_HOME' },
] as const;

/**
 * The git settings of the sandboxed commands, written to `SANDBOX_GIT_CONFIG_FILE` in the member's
 * sandbox directory at every start (the reasons are with `GIT_SETTINGS_VARIABLE`,
 * `domain/session-policy.ts`).
 */
export const SANDBOX_GIT_CONFIG_FILE = 'gitconfig';
export const SANDBOX_GIT_CONFIG =
  '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n[core]\n\tpackedRefsTimeout = 0\n';

/**
 * The part of the session folders registry (`engine-host/session-folders.ts`, `SessionFolders`
 * implements it) the domain uses. Everything that touches the disk is asynchronous, so a remote
 * engine can implement it (PM-312); a restart's new folder is made only after the old one's removal
 * is awaited.
 */
export interface EngineSessionFolders {
  readonly root: string;
  /** The root of the sessions' own temporary directories (Codex, PM-339); absent: none. */
  readonly tmpRoot: string | undefined;
  /** A path, nothing is made. */
  allocate(sessionId: string): string;
  /** A path, nothing is made; `undefined` without a `tmpRoot`. */
  allocateTmp(sessionId: string): string | undefined;
  /** The folder the session's current process has, from the registry. */
  of(sessionId: string): string | undefined;
  make(sessionId: string, dir: string | undefined, tmpDir?: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  sweep(keep: (sessionId: string) => boolean): Promise<string[]>;
  releaseTmpRoot(): Promise<void>;
}

export type WorkspaceFileRefusalReason =
  'invalid' | 'outside' | 'missing' | 'link' | 'not_a_file' | 'too_large' | 'changed' | 'unreadable';

/** Why a file of the working directory is not taken; the message is for the agent that asked. */
export class WorkspaceFileRefusal extends Error {
  readonly reason: WorkspaceFileRefusalReason;
  constructor(reason: WorkspaceFileRefusalReason, message: string) {
    super(message);
    this.name = 'WorkspaceFileRefusal';
    this.reason = reason;
  }
}

/** A regular file of the working directory, opened for reading. */
export interface WorkspaceFile {
  /** The file's own name (the last path component), as metadata for the attachment. */
  name: string;
  /** Its size when it was opened. */
  size: number;
  /** The content, read once from the opened handle (one byte more than `size` at most, to notice growth). */
  stream(): Readable;
  /**
   * Refuses (`changed`) unless the whole file was read, exactly `size` bytes, and the open file
   * still has the size and modification time it had when it was opened.
   */
  verifyUnchanged(): Promise<void>;
  close(): Promise<void>;
}

/** What `EngineHost.openWorkspaceFile` takes besides the root and the requested path. */
export interface WorkspaceFileOptions {
  maxBytes: number;
  /**
   * How the messages name `root` (default 'your working directory') and, for a file outside it,
   * the other place the caller may attach from (PM-268: the session folder).
   */
  place?: { name: string; other?: { name: string; path: string } };
  /**
   * `root` must be its own real path: it is refused (`unreadable`) when it, or a directory above
   * it, is a symbolic link. For a root a sandboxed member could have replaced by a link (the
   * session folder, PM-268); the final check then also catches a replacement made later.
   */
  exactRoot?: boolean;
  /**
   * The session the file is for (PM-315): a local engine ignores it, a remote one names it in its audit
   * log. Absent: the request is not for a session.
   */
  sessionId?: string;
}

/** Why a screenshot scenario is not taken (`EngineHost.resolveScenario`). */
export type ScenarioRefusal = 'missing' | 'outside' | 'not_file';

/** A repository of a project on the engine: the engine finds its path from its own binding, never from the call. */
export interface MergeRepoRef {
  projectKey: string;
  repo: string;
}

export interface MergeBaseState {
  /** The local default branch's commit. */
  local: string;
  /** The default branch's upstream (`<base>@{upstream}`) after the fetch; null: no remote pair. */
  remote: { name: string; commit: string } | null;
  /** The local branch against the remote one; 'same' without a remote. */
  relation: 'same' | 'local_behind' | 'local_ahead' | 'diverged';
  /** Whether `commit` is already reachable from the local and from the remote branch (null: no remote). */
  contains: { local: boolean; remote: boolean | null };
  /** The worktree that has the default branch checked out; null: none. */
  checkout: string | null;
}

export type MergeBuildResult =
  | { ok: true; mergeCommit: string; changed: string[] } // paths differing between onto and mergeCommit, at most 1000
  | { ok: false; conflict: string[] }; // sorted, at most 50

export type MergePushResult =
  { ok: true } | { ok: false; reason: 'non_fast_forward' | 'rejected' | 'unreachable'; message: string };

export type MergeAdvanceResult =
  { ok: true } | { ok: false; reason: 'checkout_in_the_way' | 'moved'; message: string; paths: string[] };

export const MERGE_ERROR_CODES = [
  'invalid_input',
  'unknown_object',
  'no_remote',
  'no_identity',
  'git_failed',
] as const;
export type MergeErrorCode = (typeof MERGE_ERROR_CODES)[number];

/**
 * An error of a merge call that is the caller's to read (`message` is safe to show). The same class
 * comes out of a local merger and out of a remote engine's proxy.
 */
export class MergeError extends Error {
  readonly code: MergeErrorCode;
  constructor(code: MergeErrorCode, message: string) {
    super(message);
    this.name = 'MergeError';
    this.code = code;
  }
}

/**
 * The git work of merging a card's approved commit into the repository's default branch and sending it
 * up (PM-448). It runs on the engine, where the repository and the machine's git identity are; the
 * server only orchestrates. Absent on an `EngineHost`: the engine does not merge.
 */
export interface BranchMerger {
  /** Fetches the upstream of `base` (when it has one), then reports the state; rejects when `base` or `commit` is unknown. */
  prepare(ref: MergeRepoRef, input: { base: string; commit: string }): Promise<MergeBaseState>;
  /** Whether `ancestor` is reachable from `commit`; null when either is unknown here. */
  isAncestor(ref: MergeRepoRef, input: { ancestor: string; commit: string }): Promise<boolean | null>;
  /** The merge commit of `commit` onto `onto` (parents: onto, commit); no ref, index or working tree is touched. */
  build(
    ref: MergeRepoRef,
    input: { onto: string; commit: string; message: string },
  ): Promise<MergeBuildResult>;
  /** Uncommitted paths of the default branch's checkout that `changed` also touches; [] when it is not checked out. */
  checkoutConflicts(ref: MergeRepoRef, input: { base: string; changed: string[] }): Promise<string[]>;
  /** A detached worktree of `mergeCommit` for the check, with the dependencies of `depsFrom`. */
  checkoutForCheck(
    ref: MergeRepoRef,
    input: { mergeId: string; mergeCommit: string; depsFrom: string | null },
  ): Promise<{ path: string; gitDir: string }>;
  /** Removes that worktree; a missing one is fine. */
  releaseCheck(ref: MergeRepoRef, input: { mergeId: string }): Promise<void>;
  /** Pushes `mergeCommit` to `base` of the upstream remote, never forced; the remote is read here, not taken from the call. */
  push(ref: MergeRepoRef, input: { base: string; mergeCommit: string }): Promise<MergePushResult>;
  /** Moves the local `base` from `from` to `to`, a descendant of `from`. */
  advance(ref: MergeRepoRef, input: { base: string; from: string; to: string }): Promise<MergeAdvanceResult>;
}

export interface EngineHost {
  readonly id: EngineId;
  /** The engine's operating system when it is not this process's (a remote engine, PM-315); absent: this machine's. */
  readonly platform?: NodeJS.Platform;
  paths(): EnginePaths;
  readonly worktrees: WorktreeManager;
  readonly memberWorkspaces?: MemberWorkspaceManager;
  readonly fullTestExecutor?: FullTestExecutor;
  readonly screenshotExecutor?: ScreenshotExecutor;
  /** Merges into a repository's default branch and sends it up (PM-448); absent: the engine does not merge. */
  readonly merger?: BranchMerger;
  /** The session folders of this engine; absent: they are off. */
  readonly sessionFolders?: EngineSessionFolders;
  /** null: not measurable (no start is refused for disk space). */
  freeDiskBytes(): Promise<number | null>;
  processExists(pid: number): boolean;
  /** The project's working directory on this engine; null: the engine does not hold the project. */
  workspacePath(projectKey: string): string | null;

  // The disk operations of the domain (PM-312). The domain computes the paths and decides; the
  // engine, which holds the disk, does the work. Each is a call a remote engine answers.
  /** Makes `MEMBER_SANDBOX_DIRS` (0700) and `SANDBOX_GIT_CONFIG_FILE` (0600) in `dir`; the git settings are written at every call. Rejects on failure. */
  prepareMemberSandboxDir(dir: string): Promise<void>;
  /** `mkdir -p` 0700 for each path; a failure is logged and never thrown. */
  preparePortablePaths(paths: readonly string[]): Promise<void>;
  /** Whether `path` is a directory (a link to one counts; false when it is not there). */
  isDirectory(path: string): Promise<boolean>;
  /** The `.git` directory of the repository at `repoPath`, real; null when it has none. */
  resolveGitDir(repoPath: string): Promise<string | null>;
  /** The real path of `path`; null when it does not exist. */
  realpath(path: string): Promise<string | null>;
  /** Whether `dir` is a directory and not a symbolic link (the session folder the server made). */
  isRealDirectory(dir: string): Promise<boolean>;
  /** Opens a regular file inside `root` for reading, with the checks of `WorkspaceFile`; rejects with `WorkspaceFileRefusal`. */
  openWorkspaceFile(root: string, requested: string, opts: WorkspaceFileOptions): Promise<WorkspaceFile>;
  /** The scenario's real path when it exists, is a file and lies in `cwd` or `sessionDir`; else why not. */
  resolveScenario(
    roots: { cwd: string; sessionDir: string },
    requested: string,
  ): Promise<{ path: string } | { refused: ScenarioRefusal }>;
  /** The images (`.png`, `.jpg`, `.jpeg`) below `dir` written at or after `sinceMs`, absolute, sorted, at most 100. */
  listImages(dir: string, sinceMs: number): Promise<string[]>;
}

/**
 * Task attachments on a remote engine (PM-315): the files are stored on the server, and a session reads
 * them on its engine, so `read_attachment` gives the file to the engine first. Absent, the session runs
 * on the server's machine and reads the stored file itself.
 */
export interface EngineAttachments {
  /** The directory of a card's attachments on the default engine, the one the sessions' read rules grant. */
  directory(projectKey: string, taskKey: string): Promise<string>;
  /** Gives the attachment to the engine the session runs on; the path it has there. Rejects `engine_offline`. */
  materialize(input: {
    sessionId: string;
    projectKey: string;
    taskKey: string;
    attachment: Attachment;
    storedPath: string;
  }): Promise<string>;
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
