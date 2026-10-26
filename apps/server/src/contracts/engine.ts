import path from 'node:path';
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

export const MERGE_CHECK_DIR = '_merge';

/**
 * The age (by mtime) from which a `pmft-*` run directory or a `_merge/<mergeId>` check checkout is a
 * leftover of a crash and the engine's startup sweep removes it (PM-837). A run lasts about an hour at most.
 */
export const STALE_LEFTOVER_MS = 24 * 60 * 60 * 1000;

/** The merge check checkout of a merge or a train on its engine: `<worktreesRoot>/_merge/<mergeId>`. */
export function mergeCheckPath(worktreesRoot: string, mergeId: string): string {
  return path.join(worktreesRoot, MERGE_CHECK_DIR, mergeId);
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
/** The user's own files a session's sandbox may read under the home folder (git identity, shell snapshots). */
export const SANDBOX_HOME_READS = ['.gitconfig', '.config/git', '.claude/shell-snapshots'];
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
  /**
   * Puts a file into the session's own folder, `<folder>/<name>` (PM-518, PM-523), and
   * names its path there: a message attachment the session's agent opens with its own tools.
   * `source` is the stored file on the server's machine with its size and SHA-256; a remote engine
   * fetches it with a single-use download token, a local one copies it. The file is made exclusively
   * (0600); one already there with the same checksum is the answer as it is. Rejects for a session
   * with no folder on this engine, and for a name that is not a plain file name.
   */
  materializeFile(
    sessionId: string,
    input: { name: string; source: { path: string; size: number; sha256: string } },
  ): Promise<{ path: string }>;
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
  // sorted, at most 50. provisional (PM-1050): a merge commit (parents onto, commit) without the conflicting
  // files; only when the caller gave `regenerate` and every conflicting path matches it.
  | { ok: false; conflict: string[]; provisional?: string };

/** The result of `BranchMerger.commitRegenerated` (PM-1050); `paths` are at most 50. */
export type MergeRegeneratedResult =
  | { ok: true; mergeCommit: string; changed: string[] } // changed: at most 1000
  | { ok: false; reason: 'outside' | 'missing' | 'not_regular'; paths: string[] };

export type MergePushResult =
  { ok: true } | { ok: false; reason: 'non_fast_forward' | 'rejected' | 'unreachable'; message: string };

/**
 * The check branches of the GitHub Actions merge check (PM-900), on the base's upstream remote. Used
 * inside one engine only: there is no wire method for it. Branch names are `pm-check/<time>/<id>`.
 */
export interface CheckBranchGit {
  /** "owner/name" of the base's upstream remote when its URL is a github.com one (ssh or https); null otherwise. */
  upstreamRepo(ref: MergeRepoRef, input: { base: string }): Promise<string | null>;
  /** Pushes `commit` to refs/heads/<branch> of that remote, never forced. */
  push(ref: MergeRepoRef, input: { base: string; commit: string; branch: string }): Promise<MergePushResult>;
  /** Deletes refs/heads/<branch> there; a missing branch is fine. */
  remove(ref: MergeRepoRef, input: { base: string; branch: string }): Promise<void>;
  /** The branch names under `prefix` there (ls-remote), at most 100. */
  list(ref: MergeRepoRef, input: { base: string; prefix: string }): Promise<string[]>;
}

export type MergeAdvanceResult =
  { ok: true } | { ok: false; reason: 'checkout_in_the_way' | 'moved'; message: string; paths: string[] };

/** The most tracked files `BranchMerger.listPaths` returns (PM-595). */
export const MAX_LISTED_PATHS = 20_000;
/** The most changed files `BranchMerger.changedPaths` returns for one item (PM-595). */
export const MAX_CHANGED_PATHS = 1_000;
/** The most items one `BranchMerger.changedPaths` call takes (PM-595). */
export const MAX_CHANGED_ITEMS = 25;

/** One card's work to diff (`BranchMerger.changedPaths`, PM-595). */
export interface ChangedPathsItem {
  /** Echoed in the result (a task key); 1..40 characters. */
  id: string;
  /**
   * branch: the tip of refs/heads/<branch>; commit: that commit. Both are diffed against their merge
   * base with the local `base` head. merge: a merge commit, diffed against its first parent.
   */
  at: { branch: string } | { commit: string } | { merge: string };
}

export type ChangedPathsResult =
  | { id: string; ok: true; commit: string; paths: string[]; truncated: boolean }
  | { id: string; ok: false; reason: 'unknown' };

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
  /**
   * The merge commit of `commit` onto `onto` (parents: onto, commit); no ref, index or working tree is touched.
   * `regenerate` (PM-1050): glob patterns of generated files; a conflict only on those gets a `provisional` commit.
   */
  build(
    ref: MergeRepoRef,
    input: { onto: string; commit: string; message: string; regenerate?: string[] },
  ): Promise<MergeBuildResult>;
  /**
   * The merge commit of a conflict whose generated files were made again in the check checkout of `mergeId`
   * (PM-1050): the checkout's HEAD is the provisional commit (parents exactly onto, commit). Commits the
   * files in `paths` and any other changed or new file matching `patterns`, nothing outside them: a change
   * outside is `outside`, a path not rewritten `missing`, a file that is not a regular unlinked file under
   * 1 MiB `not_regular`. No ref is touched.
   */
  commitRegenerated(
    ref: MergeRepoRef,
    input: {
      mergeId: string;
      onto: string;
      commit: string;
      message: string;
      paths: string[];
      patterns: string[];
    },
  ): Promise<MergeRegeneratedResult>;
  /** Uncommitted paths of the default branch's checkout that `changed` also touches; [] when it is not checked out. */
  checkoutConflicts(ref: MergeRepoRef, input: { base: string; changed: string[] }): Promise<string[]>;
  /** A detached worktree of `mergeCommit` for the check. `depsFrom` is the preferred source;
   * the engine selects an installed checkout matching the merged lockfile. `allowDependencyInstall`
   * (default false, PM-681) lets the engine answer `dependencyInstallRequired` (missing: false) when the
   * dependencies are not there and the check has to prepare them. */
  checkoutForCheck(
    ref: MergeRepoRef,
    input: {
      mergeId: string;
      mergeCommit: string;
      depsFrom: string | null;
      allowDependencyInstall?: boolean;
    },
  ): Promise<{ path: string; gitDir: string; dependencyInstallRequired?: boolean }>;
  /** Removes that worktree; a missing one is fine. */
  releaseCheck(ref: MergeRepoRef, input: { mergeId: string }): Promise<void>;
  /** Pushes `mergeCommit` to `base` of the upstream remote, never forced; the remote is read here, not taken from the call. */
  push(ref: MergeRepoRef, input: { base: string; mergeCommit: string }): Promise<MergePushResult>;
  /**
   * The tags of `base`'s upstream remote (`git ls-remote --tags`), at most 5000: the commit a tag points at
   * (the peeled one for an annotated tag). no_remote when `base` has no upstream. For `publish_release` (PM-968).
   */
  remoteTags(ref: MergeRepoRef, input: { base: string }): Promise<{ name: string; commit: string }[]>;
  /**
   * Makes the annotated tag `tag` on `commit` with the repository's git identity and pushes it to `base`'s
   * upstream remote, never forced: a tag that exists there already is refused (`rejected`). An old local tag
   * of that name is replaced. invalid_input for a name that is not a release tag name; no_remote without an
   * upstream. For `publish_release` (PM-968).
   */
  pushTag(ref: MergeRepoRef, input: { base: string; tag: string; commit: string }): Promise<MergePushResult>;
  /** Moves the local `base` from `from` to `to`, a descendant of `from`. */
  advance(ref: MergeRepoRef, input: { base: string; from: string; to: string }): Promise<MergeAdvanceResult>;
  /**
   * The text of `path` at `commit`, or at the head of `base` after fetching its upstream (the upstream's
   * commit, else the local branch's). text null: no such file there. Rejects (invalid_input) a path that
   * fails isRepoFilePath, a file over 1 MiB or one that is not UTF-8 text; unknown_object for an unknown commit.
   * For the Operator's documents (PM-388).
   */
  readFile(
    ref: MergeRepoRef,
    input: { at: { commit: string } | { base: string }; path: string },
  ): Promise<{ commit: string; text: string | null }>;
  /**
   * A commit whose parent is `onto` and whose tree is onto's with these files' text set (created when
   * absent). No ref, index or working tree is touched; the machine's git identity, like build (no_identity).
   * changed: the paths whose content differs from onto. For the Operator's documents (PM-388).
   */
  commitFiles(
    ref: MergeRepoRef,
    input: { onto: string; files: { path: string; text: string }[]; message: string },
  ): Promise<{ commit: string; changed: string[] }>;
  /**
   * The tracked files at the local `base` head, without a fetch: sorted, at most MAX_LISTED_PATHS
   * (truncated: there were more). Rejects with unknown_object when `base` has no commit. For the
   * structure map (PM-595).
   */
  listPaths(
    ref: MergeRepoRef,
    input: { base: string },
  ): Promise<{ commit: string; paths: string[]; truncated: boolean }>;
  /**
   * Each item's changed files, in input order, without a fetch: sorted, at most MAX_CHANGED_PATHS
   * (truncated), a rename as a delete and an add. An unknown branch or commit, no merge base with
   * `base`, or a `merge` without a parent: { ok: false, reason: 'unknown' }. More than
   * MAX_CHANGED_ITEMS items: invalid_input. The result's commit is the resolved head (branch, commit)
   * or the merge commit itself. For the structure map (PM-595).
   */
  changedPaths(
    ref: MergeRepoRef,
    input: { base: string; items: ChangedPathsItem[] },
  ): Promise<ChangedPathsResult[]>;
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
  /** Session ids holding or waiting for this engine's heavy-run queue; unavailable gives [], never rejects (PM-569). */
  heavyRunSessions(): Promise<string[]>;
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

/** A call failed because the engine link was lost, not because the engine refused it (PM-777). */
export class EngineLinkLostError extends Error {
  /** true: the link was already waited for (the executor's linkWaitMs ran out). */
  readonly waited: boolean;
  constructor(message: string, waited = false) {
    super(message);
    this.name = 'EngineLinkLostError';
    this.waited = waited;
  }
}

/** A timeout or a refusal is not a lost engine link. */
export function isEngineLinkLost(err: unknown): boolean {
  return (
    err instanceof EngineLinkLostError ||
    (typeof err === 'object' && err !== null && 'linkCode' in err && err.linkCode === 'link_down')
  );
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
  /** Waits until the engine's link is up and its connect steps ran, at most waitMs (0: answers at once). */
  awaitConnected?(
    id: EngineId,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<'connected' | 'timeout' | 'aborted'>;
}

/** Whether a process (or any process of its group) still exists. */
export type ProcessProbe = (pid: number) => boolean;

export const ENGINE_OFFLINE_AFTER_MS = 120_000;
