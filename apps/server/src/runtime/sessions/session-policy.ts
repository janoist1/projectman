import {
  OPEN_OUTBOUND_DOMAINS,
  SANDBOX_DENIED_ENV_VARS,
  READER_UNSANDBOXED_COMMANDS,
  HYBRID_ARCHIVE_DIR,
  HYBRID_STAGING_DIR,
  sensitivePaths,
} from '../../contracts';
export {
  SANDBOX_DENIED_ENV_VARS,
  HYBRID_ARCHIVE_DIR,
  HYBRID_STAGING_DIR,
  sensitivePaths,
} from '../../contracts';
import path from 'node:path';
import {
  effectiveRepo,
  isMergeFixer,
  repoOf,
  roleSessionAccess,
  roleSessionTools,
  sessionPermissions,
  REVIEW_SHELL_TOOLS,
  DEVELOPMENT_SHELL_TOOLS,
  LOCAL_PUBLISHING_OPERATIONS,
  placementReadsOnly,
  usesCodexCli,
} from '@projectman/shared';
import type { AgentProvider, RoleId, ProjectConfig, Task, SessionReadBoundary } from '@projectman/shared';
import {
  BROWSERS_PATH_VARIABLE,
  MEMBER_SANDBOX_DIRS,
  SANDBOX_GIT_CONFIG_FILE,
  SESSION_DIR_VARIABLE,
} from '../../contracts';
import type { FullTestSandbox, SessionPolicy } from '../../contracts';
import { SANDBOX_HOME_READS, claudeShellRule, claudeToolRules, directoryRulePaths } from '../../contracts';
import type { AgentSandbox } from '../../contracts';
import { isWithin } from '../../kernel';
import { isWithinAny } from '../permissions';
import { editsFilesInPlace, IN_PLACE_EDIT_MESSAGE } from '../permissions';
import { isReadOnlyCommand } from '../permissions';
import { parseShellCommand } from '../permissions';
import { isWorktreeRoutine } from '../permissions';

/**
 * Per-role session settings, kept in one place so they are easy to change.
 */

/** The team tools (MCP server "team"): every AI session may use them without asking. */
export const TEAM_TOOLS_ALLOWED = ['mcp__team__*'];

/** Read-only tools reviewers need constantly; pre-approving them avoids a stream of permission requests. */
export const READ_ONLY_REVIEW_TOOLS = ['Read', 'Grep', 'Glob', ...REVIEW_SHELL_TOOLS.map(claudeShellRule)];

/** Ordinary development in the task branch; package additions still require permission. */
export const DEVELOPMENT_TOOLS = DEVELOPMENT_SHELL_TOOLS.map(claudeShellRule);

export const LOCAL_ONLY_DENIED_TOOLS = claudeToolRules({
  tools: { team: { all: false, names: [] }, files: [], shell: [] },
  deniedOperations: [...LOCAL_PUBLISHING_OPERATIONS],
}).deny;

/**
 * What the task's repository rules out: publishing from a repository without GitHub. The repository
 * is the task's effective one (its own, else the project's only repository).
 */
export function deniedToolsFor(config: ProjectConfig, task: Pick<Task, 'repo'> | null): string[] {
  const repo = repoOf(config, effectiveRepo(config, task));
  return repo && !repo.github ? [...LOCAL_ONLY_DENIED_TOOLS] : [];
}

/** The only hosts sandboxed commands reach: the npm registry (local ports too, decision 24). */
export const SANDBOX_ALLOWED_DOMAINS = ['registry.npmjs.org'];

/**
 * The hosts sandboxed commands reach under a policy: the npm registry only, or (outbound network on)
 * every host except the denied hosts. The denied hosts are named only beside the open rule.
 */
function sandboxNetwork(policy: SessionPolicy): Pick<AgentSandbox, 'allowedDomains' | 'deniedDomains'> {
  if (policy.network.outbound !== 'open') return { allowedDomains: [...SANDBOX_ALLOWED_DOMAINS] };
  return {
    allowedDomains: [...OPEN_OUTBOUND_DOMAINS],
    ...(policy.network.deniedHosts?.length ? { deniedDomains: [...policy.network.deniedHosts] } : {}),
  };
}

/**
 * Set in every session's sandbox (PM-194): Claude Code's sandbox cannot open a pseudo-terminal, so
 * the server's PTY tests (`apps/server/vitest.config.ts`) may be left out there. Without it a PTY
 * that cannot be opened fails the test run.
 */
export const PTY_SKIP_VARIABLE = 'PROJECTMAN_SKIP_PTY_TESTS';
export const SANDBOX_PTY_ENV = { [PTY_SKIP_VARIABLE]: '1' } as const;

/** The machine's heavy-run queue folder (PM-332), named in the sandbox of a session: `scripts/heavy` reads it. */
export const HEAVY_LOCK_DIR_VARIABLE = 'PROJECTMAN_HEAVY_LOCK_DIR';
/** Install from the member's own npm cache when there is no clone to copy the dependencies from (PM-332). */
export const PREFER_OFFLINE_VARIABLE = 'npm_config_prefer_offline';

/**
 * What a sandboxed session needs for the heavy-run queue: its parent folder (`projectman-<uid>`, made
 * 0700 by the lock) writable, the folder named in the environment, and npm preferring its cache. Nothing
 * when the folder is not given, in a denied path, or the parent is the user's or the app's home or above
 * (never the home or a directory above it, whatever the configuration says).
 */
function heavyLockAccess(
  heavyLockDir: string | undefined,
  denied: readonly string[],
  homes: readonly (string | undefined)[],
): { allowWrite: string[]; env: Record<string, string> } {
  if (!heavyLockDir) return { allowWrite: [], env: {} };
  const parent = path.dirname(heavyLockDir);
  if (isWithinAny(denied, parent) || homes.some((home) => home && isWithin(parent, home)))
    return { allowWrite: [], env: {} };
  return {
    allowWrite: [parent],
    env: { [HEAVY_LOCK_DIR_VARIABLE]: heavyLockDir, [PREFER_OFFLINE_VARIABLE]: 'true' },
  };
}

/** The part of a sandbox every provider's own sandbox takes (`AgentSandbox.portable`, PM-346). */
function portableOf(shared: {
  allowWrite: string[];
  env: Record<string, string>;
  tmpDir?: string;
  readBoundary?: SessionReadBoundary;
}): Pick<AgentSandbox, 'portable'> {
  if (shared.allowWrite.length === 0 && !shared.tmpDir && !shared.readBoundary) return {};
  return {
    portable: {
      allowWrite: [...shared.allowWrite],
      env: { ...shared.env },
      ...(shared.tmpDir ? { tmpDir: shared.tmpDir } : {}),
      ...(shared.readBoundary ? { readBoundary: shared.readBoundary } : {}),
    },
  };
}

/**
 * What the CLIs' own sandboxes take besides the heavy-run queue (PM-339): the session's folder and
 * Playwright's browsers, the member's own cache and development data, and the commands' own
 * temporary directory.
 */
function portableShared(
  heavy: { allowWrite: string[]; env: Record<string, string> },
  own: {
    sessionDir?: string;
    browsersDir?: string;
    tmpDir?: string;
    memberDirs?: readonly { path: string; variable: string }[];
  },
): Parameters<typeof portableOf>[0] {
  return {
    allowWrite: [
      ...heavy.allowWrite,
      ...(own.memberDirs ?? []).map((dir) => dir.path),
      ...(own.sessionDir ? [own.sessionDir] : []),
    ],
    env: {
      ...heavy.env,
      ...Object.fromEntries((own.memberDirs ?? []).map((dir) => [dir.variable, dir.path])),
      ...(own.sessionDir ? { [SESSION_DIR_VARIABLE]: own.sessionDir } : {}),
      ...(own.browsersDir ? { [BROWSERS_PATH_VARIABLE]: own.browsersDir } : {}),
    },
    ...(own.tmpDir ? { tmpDir: own.tmpDir } : {}),
  };
}

/**
 * Git settings of a developer's sandboxed commands (PM-216): a system-level git configuration
 * file in the member's sandbox directory (`GIT_CONFIG_SYSTEM`; written by the host at every start,
 * readable but not writable for the commands). Not `GIT_CONFIG_COUNT`/`KEY_n`: a session's
 * environment may already carry such entries (`safe.directory`), and ours would replace them. The
 * user's own configuration still comes after it; the machine's system file (`credential.helper`
 * and the like) is not loaded, which a sandbox without credentials does not miss.
 * - no automatic gc or maintenance: `gc --auto` / `pack-refs` would rewrite the shared
 *   `packed-refs`, which `sharedGitDenials` keeps out;
 * - `core.packedRefsTimeout=0`: git waits 1 s for a `packed-refs.lock` it cannot take. A
 *   `git commit` ends by deleting the `CHERRY_PICK_HEAD`/`REVERT_HEAD` pseudo-refs, and any
 *   ref-deleting transaction locks the shared `packed-refs`: the denied lock makes it print
 *   "Unable to create '.../packed-refs.lock'" after the commit, which already exists. No git
 *   setting avoids that message; allowing the lock would let a sandbox change the host's lock
 *   window, so the message is known and harmless, and only its delay is removed.
 *   PM-411: the Codex worktree profile grants only this lock for rebase pseudo-ref deletion;
 *   Claude keeps denying it. packed-refs itself stays read-only. A leftover lock can block host
 *   ref deletions, and replacing the lock while the host rewrites packed-refs can inject content
 *   into that rewrite. The owner accepted these two risks on 2026-10-08 (PM-411), conditional
 *   on the mitigation follow-up PM-413. A live hard-link creation probe is still required before release.
 */
export const GIT_SETTINGS_VARIABLE = 'GIT_CONFIG_SYSTEM';

/**
 * A member's own directory for what its sandboxed commands keep between sessions (PM-193): its npm
 * cache and its development instance's data. Nothing outside a sandbox runs or loads them; the
 * user's `~/.npm` (whose `_npx` the host's `npx` runs code from) and `~/.projectman-dev` (the host's
 * `npm run dev`) stay unwritten.
 */
export function memberSandboxDir(appHome: string, projectKey: string, handle: string): string {
  return path.join(appHome, 'member-caches', projectKey, handle);
}

/**
 * The empty directory the Operator's conversation with someone who is not an owner runs in (PM-475):
 * not the workspace, so the conversation has a transcript of its own and nothing to read beside it.
 */
export function guestSessionDir(appHome: string, projectKey: string, guestHandle: string): string {
  return path.join(appHome, 'operator-guests', projectKey, guestHandle);
}

/**
 * The files of a shared git directory a worktree's commands never write (PM-153): the default
 * branch, and the `HEAD` and `index` of the checkout the directory belongs to (the integrating
 * one), with their lock files, so git fails at the lock and leaves none behind. `packed-refs` too:
 * rewriting it can move or drop the default branch. Nor `refs/replace` (the directory) and
 * `info/grafts`: with them every local git command would see other content or history for the
 * default branch without the ref moving (a `git replace` of one of its blobs reaches the
 * integrating checkout's diff, merge and checkout). Server-managed `refs/projectman` snapshots
 * also stay read-only (PM-794). Everything else stays writable (the task's own
 * branch, objects, other worktrees' metadata); Claude Code itself keeps `hooks` and `config` out.
 */
function sharedGitDenials(gitDir: string, defaultBranch: string): string[] {
  return [
    ...[path.join('refs', 'heads', defaultBranch), 'HEAD', 'index', 'packed-refs'].flatMap((file) => [
      path.join(gitDir, file),
      path.join(gitDir, `${file}.lock`),
    ]),
    path.join(gitDir, 'refs', 'replace'),
    path.join(gitDir, 'refs', 'projectman'),
    path.join(gitDir, 'info', 'grafts'),
  ];
}

/** The actual paths a session's sandbox is computed from, besides its policy. */
interface SandboxPaths {
  /** The user's home directory (`os.homedir()`). */
  userHome: string;
  /** projectman's own data directory (`PROJECTMAN_HOME`). */
  appHome?: string;
  /** The task repository's default branch, which a worktree's commands never move. */
  defaultBranch?: string;
  /**
   * The member's own sandbox directory (`memberSandboxDir`, PM-193), made by the caller with its
   * `MEMBER_SANDBOX_DIRS`; absent (no app home), the commands keep no npm cache or development data.
   */
  memberDir?: string;
  /**
   * The user's `core.excludesfile` (`userExcludesFile`, PM-216): read-only for the commands, so git
   * does not warn about it. Left out when it lies in a denied path or in the app home.
   */
  excludesFile?: string;
  /**
   * The session's own folder (`sessionFolderOf`, PM-268), made by the caller before the start:
   * written by the commands, named in `PROJECTMAN_SESSION_DIR`. A direct child of the session
   * folders root, which a developer's commands do not read otherwise.
   */
  sessionDir?: string;
  /** Playwright's browsers (`PROJECTMAN_BROWSERS_PATH`, PM-268): read-only, in `PLAYWRIGHT_BROWSERS_PATH`. */
  browsersDir?: string;
  /** The machine's heavy-run queue folder (`PROJECTMAN_HEAVY_LOCK_DIR`, PM-332): its parent is writable. */
  heavyLockDir?: string;
  /**
   * The commands' own temporary directory (`SessionFolders.allocateTmp`, PM-339): writable for them
   * and their TMPDIR in the CLI's own sandbox, which closes the shared `/tmp` (Codex), or the base of
   * Claude Code's own temporary root (`CLAUDE_CODE_TMPDIR`, PM-353). Made by the caller before the
   * start, as a new directory (`SessionFolders.make`), never below a path another member's sandbox
   * writes.
   */
  tmpDir?: string;
  /**
   * Temporary roots every session of the user shares (PM-353): Claude Code's (`sharedClaudeTmpRoots`)
   * and the base of the sessions' own temporary directories (`path.dirname(SessionFolders.tmpRoot)`).
   * Used only with `tmpDir`: `denyRead` for the commands, `denyWrite` for those not holding
   * `tmpDir`; `tmpDir` is re-opened (`allowRead`, `allowWrite`).
   */
  sharedTmpRoots?: readonly string[];
}

/**
 * What the shared temporary roots add to a sandbox that keeps `tmpDir` (PM-353): the commands neither
 * read them nor write those that do not hold `tmpDir`, and read and write `tmpDir` (the narrower
 * path wins for reading; a `denyWrite` root that holds `tmpDir` would close it, so it is left out).
 * Nothing without `tmpDir`: the CLI then still uses the shared roots, and closing them would break it.
 */
function sharedTmpRules(
  tmpDir: string | undefined,
  roots: readonly string[] | undefined,
): { denyRead: string[]; denyWrite: string[]; allowRead: string[]; allowWrite: string[] } {
  if (!tmpDir || !roots?.length) return { denyRead: [], denyWrite: [], allowRead: [], allowWrite: [] };
  return {
    denyRead: [...roots],
    denyWrite: roots.filter((root) => !isWithin(root, tmpDir)),
    allowRead: [tmpDir],
    allowWrite: [tmpDir],
  };
}

/**
 * The OS sandbox of a session in a task's own worktree (PM-134, PM-153, PM-193; see the probe in
 * docs/PROVIDERS.md): its shell commands run without asking.
 * - Reading: nothing below the user's home and the app home (`denyRead`), except the session's own
 *   directories (the worktree, the task's attachments, the member's sandbox directory), the shared
 *   git directory and `SANDBOX_HOME_READS` (`allowRead`). The credentials and the live instance's
 *   data stay in `denyRead` as well: the narrower path wins, so no `allowRead` re-opens them, and an
 *   `allowRead` inside one of them is left out.
 * - Writing: the worktree (with the shared git directory, minus hooks and config, Claude Code's own
 *   rule), the temp directory and the member's npm cache and development data
 *   (`MEMBER_SANDBOX_DIRS`, set in the environment); never the default branch and the integrating
 *   checkout's `HEAD` and `index` (`sharedGitDenials`), and nothing the host runs or loads outside a
 *   sandbox. A member workspace is an independent clone with its own `.git`: nothing is shared
 *   there, so nothing is denied.
 *   The parent of the heavy-run queue folder is writable too (`heavyLockAccess`).
 * - Environment: without `SANDBOX_DENIED_ENV_VARS`, with `SANDBOX_PTY_ENV`.
 * - Network: only the npm registry; the tests may listen on local ports, which also opens every
 *   local port (decision 24).
 */
function worktreeSandbox(policy: SessionPolicy, paths: SandboxPaths): AgentSandbox {
  const { userHome, appHome, defaultBranch, memberDir, excludesFile } = paths;
  const denied = policy.filesystem.deniedPaths ?? [];
  const sessionDir =
    paths.sessionDir && !isWithinAny(denied, paths.sessionDir) ? paths.sessionDir : undefined;
  // Never the home or a directory above it, nor the app home or above it, whatever the config says.
  const browsersDir =
    paths.browsersDir &&
    !isWithinAny(denied, paths.browsersDir) &&
    !isWithin(paths.browsersDir, userHome) &&
    !(appHome && isWithin(paths.browsersDir, appHome))
      ? paths.browsersDir
      : undefined;
  const heavy = heavyLockAccess(paths.heavyLockDir, denied, [userHome, appHome]);
  const gitDir = policy.placement.kind === 'task_worktree' ? policy.placement.gitDir : undefined;
  const own = memberDir
    ? MEMBER_SANDBOX_DIRS.map((dir) => ({ ...dir, path: path.join(memberDir, dir.name) }))
    : [];
  const writableOwn = own.filter((dir) => !isWithinAny(denied, dir.path));
  const gitConfig = memberDir ? path.join(memberDir, SANDBOX_GIT_CONFIG_FILE) : undefined;
  const tmpDir = paths.tmpDir && !isWithinAny(denied, paths.tmpDir) ? paths.tmpDir : undefined;
  const sharedTmp = sharedTmpRules(tmpDir, paths.sharedTmpRoots);
  const denyWrite = [
    ...(gitDir && defaultBranch ? sharedGitDenials(gitDir, defaultBranch) : []),
    ...sharedTmp.denyWrite,
  ];
  const directory = (path: string) => ({ path, kind: 'directory' as const });
  const file = (path: string) => ({ path, kind: 'file' as const });
  const candidates: SessionReadBoundary['allowedPaths'] = [
    ...(tmpDir ? [directory(tmpDir)] : []),
    ...policy.filesystem.readableRoots.map(directory),
    directory(policy.placement.path),
    ...(policy.filesystem.readOnlyPaths ?? []).map(directory),
    ...own.map((dir) => directory(dir.path)),
    ...(gitConfig ? [file(gitConfig)] : []),
    ...(gitDir ? [directory(gitDir)] : []),
    // The instance's whole folder root: every member's folder is read, only its own is written (PM-333).
    ...(sessionDir ? [directory(path.dirname(sessionDir))] : []),
    ...(browsersDir ? [directory(browsersDir)] : []),
    ...SANDBOX_HOME_READS.map((name) =>
      name === '.gitconfig' ? file(path.join(userHome, name)) : directory(path.join(userHome, name)),
    ),
    // Never the home or a directory above it, whatever the config says.
    ...(excludesFile && !isWithin(excludesFile, userHome) && !(appHome && isWithin(appHome, excludesFile))
      ? [file(excludesFile)]
      : []),
    ...heavy.allowWrite.map(directory),
  ];
  const readBoundary: SessionReadBoundary = {
    deniedRoots: [...new Set([userHome, ...(appHome ? [appHome] : []), ...sharedTmp.denyRead])],
    allowedPaths: [
      ...new Map(
        candidates.filter((entry) => !isWithinAny(denied, entry.path)).map((entry) => [entry.path, entry]),
      ).values(),
    ],
  };
  const allowRead = readBoundary.allowedPaths.map((entry) => entry.path);
  return {
    allowWrite: [
      ...writableOwn.map((dir) => dir.path),
      ...(sessionDir ? [sessionDir] : []),
      ...heavy.allowWrite,
      ...sharedTmp.allowWrite,
    ],
    ...(denyWrite.length > 0 ? { denyWrite } : {}),
    denyRead: [...new Set([...readBoundary.deniedRoots, ...denied, ...sharedTmp.denyRead])],
    allowRead: [...new Set(allowRead)],
    env: {
      ...Object.fromEntries(own.map((dir) => [dir.variable, dir.path])),
      ...(sessionDir ? { [SESSION_DIR_VARIABLE]: sessionDir } : {}),
      ...(browsersDir ? { [BROWSERS_PATH_VARIABLE]: browsersDir } : {}),
      ...heavy.env,
      ...SANDBOX_PTY_ENV,
      ...(gitConfig ? { [GIT_SETTINGS_VARIABLE]: gitConfig } : {}),
    },
    deniedEnvVars: [...SANDBOX_DENIED_ENV_VARS],
    ...sandboxNetwork(policy),
    allowLocalBinding: true,
    ...portableOf({
      ...portableShared(heavy, {
        memberDirs: writableOwn,
        sessionDir,
        browsersDir,
        tmpDir,
      }),
      readBoundary,
    }),
  };
}

/**
 * The CLI's own sandbox of a legacy session (decision 28, PM-167), from the policy's actual paths;
 * - Work in a task's own worktree: `worktreeSandbox`, from the `SandboxPaths` too (PM-153).
 * - A reading placement (read-only, or a review copy without the test opt-in): its commands write
 *   only the temp directory; the working directory, every extra directory (`--add-dir`, the
 *   developer's worktree among them) and the installation's other checkouts (`readerDenyWrite`:
 *   the app home with every member's worktree, the project's workspace, the server's own
 *   checkout; PM-188) are `denyWrite`, so the member's own mode (Auto too) runs reads, git queries,
 *   tests and type checks without asking and changes nothing, and the file tools get an `Edit` deny
 *   rule for each of them. The npm registry and local ports as for a developer (decision 24). On a
 *   repository on GitHub (`github`), `gh pr view` and `gh pr diff` run outside the sandbox.
 * Both never read the credentials and the live instance's data (`deniedPaths`, PM-165) from the
 * shell either. A placement the CLI writes as a whole without a sandbox (a review copy's test
 * opt-in) gets none: that is the strict path, refused before the start.
 */
export function sessionSandbox(
  policy: SessionPolicy,
  options: Partial<SandboxPaths> & {
    github?: boolean;
    readerDenyWrite?: readonly (string | undefined)[];
  } = {},
): AgentSandbox | undefined {
  if (policy.access === 'task_worktree') {
    // Without the user's home the sandbox could not close it: no start rather than an open one.
    if (!options.userHome) throw new Error("A worktree session's sandbox needs the user's home.");
    return worktreeSandbox(policy, { ...options, userHome: options.userHome });
  }
  if (!placementReadsOnly(policy.access, { mode: policy.reviewCopyMode, enforcement: policy.enforcement }))
    return undefined;
  const own = [...new Set([policy.placement.path, ...policy.filesystem.readableRoots])];
  // The installation's directories, each once: none inside another (a member's worktree in the app home).
  const listed = [
    ...new Set(
      (options.readerDenyWrite ?? []).filter((dir): dir is string => !!dir).map((dir) => path.resolve(dir)),
    ),
  ];
  const others = listed.filter(
    (dir) => !own.includes(dir) && !listed.some((other) => other !== dir && isWithin(other, dir)),
  );
  const denyWrite = [...own, ...others];
  const denied = policy.filesystem.deniedPaths ?? [];
  // Its own folder, outside every checkout and the app home; a folder inside a denyWrite path stays read-only.
  const sessionDir =
    options.sessionDir &&
    !isWithinAny(denied, options.sessionDir) &&
    !isWithinAny(denyWrite, options.sessionDir)
      ? options.sessionDir
      : undefined;
  // Read-only already (the reader reads everything outside `deniedPaths`; the app home is `denyWrite`).
  const browsersDir =
    options.browsersDir && !isWithinAny(denied, options.browsersDir) ? options.browsersDir : undefined;
  const heavy = heavyLockAccess(options.heavyLockDir, denied, [options.userHome, options.appHome]);
  // Checked against `denyWrite` as it is before the shared roots join it.
  const tmpDir =
    options.tmpDir && !isWithinAny(denied, options.tmpDir) && !isWithinAny(denyWrite, options.tmpDir)
      ? options.tmpDir
      : undefined;
  const sharedTmp = sharedTmpRules(tmpDir, options.sharedTmpRoots);
  const denyRead = [...new Set([...denied, ...sharedTmp.denyRead])];
  return {
    allowWrite: [...(sessionDir ? [sessionDir] : []), ...heavy.allowWrite, ...sharedTmp.allowWrite],
    denyWrite: [...denyWrite, ...sharedTmp.denyWrite],
    ...(denyRead.length > 0 ? { denyRead } : {}),
    ...(sharedTmp.allowRead.length > 0 ? { allowRead: sharedTmp.allowRead } : {}),
    ...sandboxNetwork(policy),
    allowLocalBinding: true,
    env: {
      ...SANDBOX_PTY_ENV,
      ...(sessionDir ? { [SESSION_DIR_VARIABLE]: sessionDir } : {}),
      ...(browsersDir ? { [BROWSERS_PATH_VARIABLE]: browsersDir } : {}),
      ...heavy.env,
    },
    ...(options.github ? { excludedCommands: [...READER_UNSANDBOXED_COMMANDS] } : {}),
    ...portableOf(
      portableShared(heavy, {
        sessionDir,
        browsersDir,
        tmpDir,
      }),
    ),
  };
}

/**
 * The read rules of the server's full test run (PM-217), stricter than a member's sandbox: nothing
 * below the user's home and the app home (`denyRead`, the credentials and the live instance's data
 * in it too), except the developer's checkout and the shared git directory it points to
 * (`allowRead`; the checkout is read-only, the executor makes the run's own directory writable).
 * Other cards' worktrees, the database and the secrets stay closed.
 */
export function fullTestSandbox(input: {
  checkout: string;
  gitDir?: string;
  userHome: string;
  appHome?: string;
  /**
   * The temporary roots the machine's sessions share (PM-353): Claude Code's and the base of the
   * sessions' own temporary directories. The run's own directory is none of them.
   */
  closedTmpRoots?: readonly string[];
}): FullTestSandbox {
  const { checkout, gitDir, userHome, appHome } = input;
  const denied = sensitivePaths({ userHome, appHome });
  return {
    denyRead: [
      ...new Set([
        userHome,
        ...(appHome && !isWithin(userHome, appHome) ? [appHome] : []),
        ...denied,
        ...(input.closedTmpRoots ?? []),
      ]),
    ],
    allowRead: [...new Set([checkout, ...(gitDir ? [gitDir] : [])])].filter(
      (dir) => !isWithinAny(denied, dir),
    ),
  };
}

/** Hosts the web fetch tool never reaches: the live instance and anything else on this machine. */
export const HARD_DENIED_HOSTS = ['localhost', '127.0.0.1'];

type CommandVerdict = { behavior: 'allow' } | { behavior: 'deny'; message: string };

/**
 * Whether the session works in the task's own worktree, inside the worktrees root, or in the
 * member's own workspace, inside the workspaces root (PM-138).
 */
function inTaskWorktree(input: {
  config: ProjectConfig;
  session: { cwd: string; role: RoleId; member?: string; branch?: string | null };
  task: Pick<Task, 'repo' | 'merge'> | null;
  worktreesRootDir?: string;
  workspacesRootDir?: string;
}): boolean {
  const { config, session, task } = input;
  const fixing =
    session.member !== undefined &&
    isMergeFixer(task?.merge, session.member) &&
    session.branch === task?.merge?.fix?.branch;
  if (!effectiveRepo(config, task) || (!sessionPolicyFor(session.role, config).worktree && !fixing))
    return false;
  return [input.worktreesRootDir, input.workspacesRootDir].some((root) => {
    if (!root) return false;
    const relative = path.relative(path.resolve(root), path.resolve(session.cwd));
    return (
      relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  });
}

/**
 * The directories an AI session on a task may read without asking: its own working directory
 * and, when the task has a repository (its own, else the project's only one), the task's worktree,
 * where the developer's changes are (a reviewer works elsewhere and reads them there). The worktree
 * is at the location the worktree manager gives it: `<worktreesRoot>/<PROJECT>/<TASKKEY>-<repo>`.
 */
export function readableRootsFor(input: {
  config: Pick<ProjectConfig, 'project'>;
  cwd: string;
  projectKey: string;
  task: Pick<Task, 'key' | 'repo'> | null;
  worktreesRootDir?: string;
  /** The task's own attachment directory (`AttachmentStorage.taskDirectory`), read-only. */
  attachmentsDir?: string | null;
  /** The attachment directory of the task's direct parent (PM-228), read-only as well. */
  parentAttachmentsDir?: string | null;
}): string[] {
  const { config, cwd, projectKey, task, worktreesRootDir, attachmentsDir, parentAttachmentsDir } = input;
  const roots = [cwd];
  const repo = effectiveRepo(config, task);
  if (task && repo && worktreesRootDir) {
    const projectDir = path.join(path.resolve(worktreesRootDir), projectKey);
    const worktree = path.join(projectDir, `${task.key}-${repo}`);
    if (worktree !== projectDir && isWithin(projectDir, worktree)) roots.push(worktree);
  }
  if (task && attachmentsDir) roots.push(attachmentsDir);
  if (task && parentAttachmentsDir) roots.push(parentAttachmentsDir);
  return roots;
}

/**
 * Claude Code rules for the attachment directory of the session's task: its files are read without
 * asking (`read_attachment` gives their paths) and never edited, whatever the permission mode. Not
 * an extra working directory (`--add-dir`): in `acceptEdits` mode Claude Code would accept edits
 * there too. Codex ignores these rules; its sandbox lets it read and never write there. A path
 * with characters that mean something in a rule gets no rules: reading and editing there then ask
 * a human, as anywhere else outside the session's directories.
 */
export function attachmentToolRules(dir: string | null): { allow: string[]; deny: string[] } {
  const paths = dir ? directoryRulePaths(dir) : null;
  if (!paths) return { allow: [], deny: [] };
  return { allow: paths.map((p) => `Read(${p})`), deny: paths.map((p) => `Edit(${p})`) };
}

/**
 * What a session of the legacy profile does with its own folder (PM-268, PM-339, PM-522): `write` when
 * the session (its sandbox or its file tools) writes it, `read` when only the server puts files there
 * and the session reads them. The caller leaves out the managed VM (and a session without a folder
 * root), which gets none.
 */
export type SessionFolderAccess = 'write' | 'read';

export function sessionFolderAccess(input: {
  provider: AgentProvider;
  sandbox: SessionPolicy['permissions']['sandbox'];
  /** The engine has a safe temporary root (`EngineSessionFolders.tmpRoot`). */
  tmpRoot: boolean;
}): SessionFolderAccess | null {
  const { provider, sandbox, tmpRoot } = input;
  // Claude Code's own sandbox and file tools write it; Gemini's file tools do (its hook gates them).
  if (provider === 'claude' || provider === 'gemini') return 'write';
  if (!usesCodexCli(provider)) return null;
  if (sandbox === 'read-only') return 'read';
  // Without the short TMPDIR root the shared `/tmp` stays writable: no folder either.
  if (sandbox === 'workspace-write') return tmpRoot ? 'write' : null;
  return null;
}

/**
 * The policy with the session folder the sandbox kept (PM-268) and its root (PM-333); unchanged
 * without one. The adapter renders the file-tool rules from them (`claudeToolRules`). A folder
 * that is not directly below the root gets no root: only its own is then read and written.
 */
export function withSessionFolders(
  policy: SessionPolicy,
  folders: { own: string; root: string } | undefined,
): SessionPolicy {
  if (!folders) return policy;
  return {
    ...policy,
    filesystem: {
      ...policy.filesystem,
      sessionFolder: folders.own,
      ...(path.dirname(folders.own) === folders.root ? { sessionFoldersRoot: folders.root } : {}),
    },
  };
}

/**
 * Automatic decisions about shell commands; everything else reaches a human.
 * - deny: publishing (`git push`, `gh pr create`, `gh pr merge`) from a repository without GitHub;
 * - deny: a command that rewrites a file in place (`sed -i`, `perl -pi -e`), with a pointer to
 *   the editing tools, see `in-place-edits.ts`;
 * - allow: a developer's routine steps in the task's own worktree (lockfile install, formatting, `git add`,
 *   `git commit` with a message, `git merge --ff-only`, `git checkout`/`git restore` of named paths
 *   from HEAD or the index), alone or in a chain with read-only
 *   steps, see `worktree-commands.ts`;
 * - allow: read-only commands inside `readableRoots`, for any AI session on a task, see
 *   `read-only-commands.ts`. Without roots this rule gives no verdict.
 * The allow rules and the in-place deny rule read the command with the strict parser in
 * `shell-words.ts`; a command it refuses gets no verdict from them. The publishing deny rule
 * works on the raw text and so holds for such a command too. It leaves quoted text out, read as
 * the parser reads it: a backslash in double quotes also covers the newline after it (a line
 * continuation).
 */
export function commandVerdict(input: {
  config: ProjectConfig;
  session: { cwd: string; role: RoleId; provider?: AgentProvider; member?: string; branch?: string | null };
  task: Pick<Task, 'repo' | 'merge'> | null;
  toolName: string;
  toolInput: unknown;
  worktreesRootDir?: string;
  /** Where member workspaces live (PM-138); a developer's routine steps there are allowed too. */
  workspacesRootDir?: string;
  readableRoots?: readonly string[];
}): CommandVerdict | null {
  const { config, session, task, toolName, toolInput, readableRoots } = input;
  if (toolName !== 'Bash' || !toolInput || typeof toolInput !== 'object') return null;
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== 'string') return null;
  // Quoted prose (e.g. a commit message mentioning git push) is not a publishing command. A
  // backslash in double quotes takes the next character along, a newline too (`s`): the quotes
  // must pair up as the parser and the shell pair them, or a `git push` could hide between two.
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/gs, '');
  if (deniedToolsFor(config, task).length && /\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b/.test(unquoted)) {
    return { behavior: 'deny', message: 'The owner has not allowed publishing from this repository.' };
  }
  const parsed = parseShellCommand(command);
  if (!parsed) return null;
  // Whoever the session is, a file is edited with the editing tools: nobody needs to be asked.
  if (editsFilesInPlace(parsed)) return { behavior: 'deny', message: IN_PLACE_EDIT_MESSAGE };
  // NanoGPT commands require an explicit decision, including reads and routine worktree steps.
  // Keep unconditional denials above this guard so they cannot become approval requests.
  if (session.provider === 'nanogpt') return null;
  if (inTaskWorktree(input)) {
    const defaultBranch = repoOf(config, effectiveRepo(config, task))?.defaultBranch;
    const mergeFixBase =
      session.member !== undefined &&
      isMergeFixer(task?.merge, session.member) &&
      session.branch === task?.merge?.fix?.branch
        ? task?.merge?.fix?.base
        : undefined;
    if (isWorktreeRoutine(parsed, { cwd: session.cwd, defaultBranch, mergeFixBase }))
      return { behavior: 'allow' };
  }
  if (task && readableRoots && isReadOnlyCommand(parsed, { cwd: session.cwd, roots: readableRoots })) {
    return { behavior: 'allow' };
  }
  return null;
}

interface RoleSessionPolicy {
  /** Review and research roles: the read-only tools are pre-approved. */
  readOnlyTools: boolean;
  /**
   * Roles that change files: their task sessions run in the task's own worktree and branch, never
   * in the workspace root. A project with several repositories refuses to start one on a task
   * without a repository (`assertRepoChosen`).
   */
  worktree: boolean;
}

/** Union of the actual duties, including custom roles and project overrides. */
export function sessionPolicyFor(role: RoleId, config: Pick<ProjectConfig, 'team'>): RoleSessionPolicy {
  const { readOnlyTools, worktree } = roleSessionAccess(config, role);
  return { readOnlyTools, worktree };
}
export function allowedToolsFor(
  role: RoleId,
  config: Pick<ProjectConfig, 'team'>,
  options: { teamToolsOnly?: boolean } = {},
): string[] {
  const tools = roleSessionTools(config, role);
  return claudeToolRules({
    tools: options.teamToolsOnly ? { ...tools, files: [], shell: [] } : tools,
    deniedOperations: [],
  }).allow;
}
export function usesWorktree(role: RoleId, config: Pick<ProjectConfig, 'team'>): boolean {
  return sessionPolicyFor(role, config).worktree;
}

/** The tools a session may use: its role's, or the team tools alone (`teamToolsOnly`, PM-475). */
function sessionToolsOf(input: {
  config: ProjectConfig;
  role: RoleId;
  teamToolsOnly?: boolean;
}): SessionPolicy['tools'] {
  const tools = roleSessionTools(input.config, input.role);
  return input.teamToolsOnly ? { ...tools, files: [], shell: [] } : tools;
}

/** Build intent from actual placement. Strict sandbox enforcement is a separate activation. */
export function buildSessionPolicy(input: {
  config: ProjectConfig;
  role: RoleId;
  task: Pick<Task, 'repo' | 'merge'> | null;
  member?: string;
  placement: SessionPolicy['placement'];
  permissionMode?: string;
  reviewCopyMode?: SessionPolicy['reviewCopyMode'];
  /** Intent only: provider verification and activation belong to PM-128/129/130. */
  enforcement?: SessionPolicy['enforcement'];
  readableRoots?: string[];
  protectedPaths?: string[];
  /** Directories read but never changed, outside the placement (the task's attachments). */
  readOnlyPaths?: string[];
  /** Files and directories the file tools never touch (`sensitivePaths`); the legacy profile only. */
  deniedPaths?: string[];
  /** Whether the member's commands can reach the network. */
  outboundNetwork: boolean;
  /**
   * The Operator's conversation with someone who is not an owner (PM-475): the team tools only, no
   * file, shell or web tool, and nothing to read outside the placement.
   */
  teamToolsOnly?: boolean;
}): SessionPolicy {
  if (input.teamToolsOnly) {
    input = { ...input, readableRoots: [], readOnlyPaths: [] };
  }
  const role = roleSessionAccess(input.config, input.role);
  const placement = input.placement;
  const mergeFix =
    input.member !== undefined &&
    isMergeFixer(input.task?.merge, input.member) &&
    placement.kind === 'task_worktree' &&
    placement.mergeFix?.branch === input.task?.merge?.fix?.branch;
  if (
    placement.kind === 'task_worktree' &&
    ((!role.worktree && !mergeFix) || !input.task || !effectiveRepo(input.config, input.task))
  )
    throw new Error('Task worktree placement requires a file-changing duty and a task repository.');
  if (
    placement.kind === 'review_copy' &&
    (!role.reviewCopy || !input.task || !effectiveRepo(input.config, input.task))
  )
    throw new Error('Review copy placement requires a review/testing duty and a task repository.');
  const enforcement = input.enforcement ?? 'legacy';
  const reviewCopyMode = input.reviewCopyMode ?? 'inherit';
  const permissions = sessionPermissions(input.permissionMode, placement.kind, {
    mode: reviewCopyMode,
    enforcement,
  });
  const ownRoots = [
    placement.path,
    ...(placement.kind === 'review_copy'
      ? [placement.gitDir, placement.cacheDir, placement.tempDir].filter((p): p is string => !!p)
      : []),
  ];
  const repo = repoOf(input.config, effectiveRepo(input.config, input.task));
  return {
    version: 1,
    enforcement,
    access: placement.kind,
    ...(placement.kind === 'review_copy' ? { reviewCopyMode } : {}),
    placement,
    tools: mergeFix
      ? {
          ...sessionToolsOf(input),
          files: [],
          shell: [
            ...sessionToolsOf(input).shell,
            ...DEVELOPMENT_SHELL_TOOLS,
            { command: `git merge ${input.task!.merge!.fix!.base}`, arguments: 'exact' },
          ],
        }
      : sessionToolsOf(input),
    ...(input.teamToolsOnly ? { teamToolsOnly: true } : {}),
    filesystem: {
      readableRoots: [...new Set([...ownRoots, ...(input.readableRoots ?? [])])],
      writableRoots: permissions.sandbox === 'workspace-write' ? [...new Set(ownRoots)] : [],
      protectedPaths: [
        ...new Set([
          ...(input.protectedPaths ?? []),
          ...(placement.kind === 'task_worktree' && placement.gitDir ? [placement.gitDir] : []),
        ]),
      ],
      ...(input.readOnlyPaths?.length ? { readOnlyPaths: [...new Set(input.readOnlyPaths)] } : {}),
      ...(input.deniedPaths?.length ? { deniedPaths: [...new Set(input.deniedPaths)] } : {}),
    },
    deniedOperations: repo && !repo.github ? [...LOCAL_PUBLISHING_OPERATIONS] : [],
    // No network widening: adapters retain their current enforcement until PM-128/129/130.
    network: {
      allowedDomains: [],
      allowLocalBinding: false,
      deniedHosts: [...HARD_DENIED_HOSTS],
      outbound: input.outboundNetwork ? 'open' : 'allowlist',
    },
    outsideSandbox: enforcement === 'strict' ? 'deny' : 'ask',
    permissions,
  };
}

/** Delay before a done task's sessions are stopped, so an in-flight tool result still reaches the agent. */
export const DONE_TASK_CLEANUP_DELAY_MS = 2_000;

/**
 * How long the session that moved a task to done may take to finish the turn it made the move in
 * (its messages and notes after the move) before it is stopped anyway (PM-190).
 */
export const DONE_TASK_TURN_LIMIT_MS = 10 * 60_000;
