import { readlinkSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isRegeneratedPath,
  isRegeneratedPathPattern,
  isReleaseTagName,
  usesCodexCli,
  SessionReadBoundary,
  type ProjectConfig,
} from '@projectman/shared';
import type { AgentSandbox, EnginePaths, MachineProbe, ProcessRecord } from '../contracts';
import {
  OPEN_OUTBOUND_DOMAINS,
  READER_UNSANDBOXED_COMMANDS,
  SANDBOX_DENIED_ENV_VARS,
  SANDBOX_HOME_READS,
  sensitivePaths,
} from '../contracts';
import {
  isBranchName,
  isCommitFileSet,
  isCommitId,
  isMergeId,
  isMergeMessage,
  isRepoFilePath,
} from '../engine-host';
import { userExcludesFile } from '../engine-host';
import { isWithin } from '../kernel';
import { BILLING_ENV_VARS, pathPatternMatcher, isReadBoundaryPath } from '../runner';
import { assertNpmCiCheckout, assertRegenerateCheckout } from '../full-test';
import { engineFiles } from './engine-config';
import type { ResolvedEngineConfig } from './engine-config';
import type { EngineMethod, MethodParams } from './methods';
import { EngineRpcError } from './rpc';
import type { EngineErrorCode } from './protocol';

/**
 * The engine's own limit (PM-314). Everything a cloud request names is checked here, on the machine the
 * work happens on, so that a compromised cloud can run only what this engine's owner allowed: the
 * registered projects and repos, the engine's own roots, at most `maxPermissionMode`, the commands
 * the engine was configured with. The checks run after `realpath`, so a symbolic link cannot widen a root.
 */

interface EngineLimitOptions {
  config: ResolvedEngineConfig;
  home: string;
  userHome: string;
  paths: EnginePaths;
  instanceTag: string;
  /** Where the CLIs keep their transcripts (Claude's projects, Codex's sessions, ...); the only places a transcript is read from. */
  transcriptRoots: readonly string[];
  tmpdir?: string;
  probe: MachineProbe;
  /** The root pids of the running sessions' processes. */
  sessionPids: () => number[];
  selfPid?: number;
  selfUid?: number | null;
}

const MODE_ORDER = ['plan', 'default', 'acceptEdits', 'auto'] as const;
const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const TASK_KEY = /^[A-Z][A-Z0-9]{0,9}-\d+$/;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Variables a session's sandbox environment may never set: they change which program runs, or are billing keys. */
const FORBIDDEN_ENV = [
  /^PATH$/i,
  /^NODE_OPTIONS$/i,
  /^BASH_ENV$/i,
  /^ENV$/i,
  /^ZDOTDIR$/i,
  /^HOME$/i,
  /^SHELL$/i,
  /^LD_/i,
  /^DYLD_/i,
];

const DATABASE_PATTERN = /[\\/]db\.sqlite\*$/;
const DATABASE_SUFFIXES = ['', '-wal', '-shm', '-journal'];
/**
 * A file tool's deny rule names a path, not a pattern (Claude refuses `db.sqlite*`): the app database's
 * pattern becomes its four file names. Any other entry stays as it is.
 */
function namedDatabaseFiles(entries: readonly string[]): string[] {
  return entries.flatMap((entry) =>
    DATABASE_PATTERN.test(entry) ? DATABASE_SUFFIXES.map((end) => entry.slice(0, -1) + end) : [entry],
  );
}

function refuse(code: EngineErrorCode, message: string): never {
  throw new EngineRpcError(code, message);
}

/** The real path of the nearest existing ancestor, plus the not yet existing rest (a path to be made). */
function resolveReal(target: string): string {
  return resolveRealPath(target, 0);
}

function resolveRealPath(target: string, depth: number): string {
  const absolute = path.resolve(target);
  let head = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...rest.reverse());
    } catch {
      // realpath cannot resolve a dangling link. Follow its target before appending the
      // missing tail, rather than treating a link into a denied root as a new safe path.
      if (depth < 40) {
        try {
          const link = readlinkSync(head);
          return path.join(
            resolveRealPath(path.resolve(path.dirname(head), link), depth + 1),
            ...rest.reverse(),
          );
        } catch {
          // Not a symbolic link; continue with the nearest existing ancestor.
        }
      }
      const parent = path.dirname(head);
      if (parent === head) return absolute;
      rest.push(path.basename(head));
      head = parent;
    }
  }
}

export interface EngineLimit {
  /** Engine-owned read denials, including key and link headers. */
  sensitiveRead(): string[];
  /** Throws an `EngineRpcError` for a refused request; returns the parameters to use (some are rewritten from `engine.json`). */
  check<M extends EngineMethod>(method: M, params: MethodParams<M>): Promise<MethodParams<M>>;
  /** The paths the cloud may export files from for a session: its working directory and its folder. */
  exportRoots(sessionId: string): string[];
  /** Signals a process if it is the engine's own session process (or its orphan); else refuses `signal_not_allowed`. */
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<'sent' | 'gone' | 'denied'>;
  /** The roots a request may name (for tests and the status file). */
  roots(): string[];
  /** Checks an upload or download token before it goes into a URL path. */
  token(value: string): string;
  /** The attachments cache directory of a card; refuses a name that is not a plain file name. */
  cachePath(projectKey: string, taskKey: string, name: string): string;
}

export function createEngineLimit(options: EngineLimitOptions): EngineLimit {
  const { config, home, userHome, paths, probe } = options;
  const selfPid = options.selfPid ?? process.pid;
  const selfUid = options.selfUid === undefined ? (process.getuid?.() ?? null) : options.selfUid;
  const memberCaches = path.join(home, 'member-caches');
  const attachmentsCache = path.join(home, 'attachments-cache');
  const files = engineFiles(home, config);
  // The engine's own secrets: the machine key and the link headers (the service token) are neither read
  // nor changed by a session; its configuration and status file are read but never changed.
  const engineSecrets = [config.keyFile, ...(config.linkHeadersFile ? [config.linkHeadersFile] : [])];
  const sensitive = [...sensitivePaths({ userHome, appHome: home }), ...engineSecrets];
  const sensitiveWrite = [...namedDatabaseFiles(sensitive), files.config, files.status];
  const sessions = new Map<string, { cwd: string; folder?: string }>();
  const present = (values: ReadonlyArray<string | null | undefined>): string[] =>
    values.filter((value): value is string => typeof value === 'string' && value.length > 0);

  /** Home-wide places are never a root: a root is a place the engine's own work lives in. */
  const roots = (): string[] => [
    ...new Set(
      present([
        paths.worktreesRoot,
        paths.workspacesRoot,
        paths.sessionFoldersRoot,
        paths.sessionTmpRoot,
        memberCaches,
        ...config.projects.map((project) => project.workspacePath),
        options.tmpdir ?? os.tmpdir(),
      ]).map(resolveReal),
    ),
  ];
  /**
   * What a session's sandbox may also name: the heavy-run queue's folder and the browsers. Not the CLIs'
   * shared temp roots (`/tmp/claude-<uid>`): they are off limits to a session (PM-353) and the cloud never asks.
   * The attachments cache is here, not among the roots: a task session reads its card's attachments there
   * (the cloud names `<cache>/<project>/<task>` among its read-only paths), but never works in it (PM-667).
   */
  const sandboxRoots = (): string[] => [
    ...roots(),
    ...present([
      paths.heavyLockDir ? path.dirname(paths.heavyLockDir) : null,
      paths.browsersDir,
      attachmentsCache,
    ]).map(resolveReal),
  ];
  /**
   * The user's own files a session's sandbox may read (git identity, the global excludes file, the shell
   * snapshots): read exceptions only, so they join the read candidates and never the write ones. One whose
   * real path is, or holds, a sensitive place (a symlink, a `core.excludesfile` aimed at a key) is dropped.
   */
  const homeReads = (): string[] => {
    const blocked = sensitive.map(resolveReal);
    return present([
      ...SANDBOX_HOME_READS.map((name) => path.join(userHome, name)),
      userExcludesFile(userHome),
    ])
      .map(resolveReal)
      .filter((real) => !blocked.some((place) => isWithin(place, real) || isWithin(real, place)));
  };
  const readRoots = (): string[] => [...sandboxRoots(), ...homeReads()];
  const within = (candidates: readonly string[], target: string): boolean => {
    if (!path.isAbsolute(target) || target.includes('\0')) return false;
    const real = resolveReal(target);
    return candidates.some((root) => isWithin(root, real));
  };
  const inside = (target: string, what: string, candidates: readonly string[] = roots()): string => {
    if (!within(candidates, target))
      refuse('path_outside_roots', `${what} is outside the engine's roots: ${target}`);
    return target;
  };
  const insideAll = (
    targets: readonly string[] | undefined,
    what: string,
    candidates?: readonly string[],
  ) => {
    for (const target of targets ?? []) inside(target, what, candidates);
  };

  const modeRank = (mode: string | undefined): number => {
    if (mode === undefined) return MODE_ORDER.indexOf('default');
    if (mode === 'bypassPermissions')
      refuse('permission_mode_too_high', 'bypassPermissions is not allowed on this engine');
    const rank = (MODE_ORDER as readonly string[]).indexOf(mode);
    if (rank < 0) refuse('invalid_params', 'Unknown permission mode');
    return rank;
  };
  const limitMode = (mode: string | undefined) => {
    if (modeRank(mode) > MODE_ORDER.indexOf(config.maxPermissionMode))
      refuse('permission_mode_too_high', `The permission mode ${mode} is above this engine's limit`);
  };

  /** The registered repos of a project, with the cloud's paths replaced by the engine's. */
  const bind = (cfg: ProjectConfig, repoName: string): ProjectConfig => {
    const project = config.projects.find((entry) => entry.project === cfg.project.key);
    const registered = config.repos.filter((entry) => entry.project === cfg.project.key);
    if (!project || !registered.some((entry) => entry.repo === repoName))
      refuse('repo_not_registered', `${cfg.project.key}/${repoName} is not registered on this engine`);
    return {
      ...cfg,
      project: {
        ...cfg.project,
        workspacePath: project.workspacePath,
        repos: cfg.project.repos.flatMap((repo) => {
          const entry = registered.find((candidate) => candidate.repo === repo.name);
          return entry ? [{ ...repo, path: entry.path }] : [];
        }),
      },
    };
  };
  const registeredProject = (projectKey: string) => {
    if (!config.projects.some((entry) => entry.project === projectKey))
      refuse('repo_not_registered', `${projectKey} is not registered on this engine`);
  };

  /**
   * A merge call's repository (PM-451): registered, and with a `mergeBranch`. The merge and the push run
   * with this machine's git login, so the cloud can reach only the one branch the owner named here.
   */
  const mergeRepo = (ref: { projectKey: string; repo: string }) => {
    const entry = config.repos.find((repo) => repo.project === ref.projectKey && repo.repo === ref.repo);
    if (!entry)
      return refuse('repo_not_registered', `${ref.projectKey}/${ref.repo} is not registered on this engine`);
    if (!entry.mergeBranch)
      return refuse(
        'merge_not_allowed',
        `${ref.projectKey}/${ref.repo} may not be merged into from the cloud`,
      );
    return { ...entry, mergeBranch: entry.mergeBranch };
  };
  const mergeBase = async (ref: { projectKey: string; repo: string }, base: string) => {
    const entry = mergeRepo(ref);
    if (!(await isBranchName(base))) refuse('invalid_params', 'The base is not a branch name');
    if (base !== entry.mergeBranch)
      refuse('merge_not_allowed', `Only ${entry.mergeBranch} may be merged into from the cloud`);
    return entry;
  };
  const commitIds = (...ids: string[]) => {
    for (const id of ids) if (!isCommitId(id)) refuse('invalid_params', 'Not a commit id');
  };
  const mergeIdOf = (id: string) => {
    if (!isMergeId(id)) refuse('invalid_params', 'Not a merge id');
  };
  const regeneratePatterns = (patterns: readonly string[]) => {
    if (!patterns.every(isRegeneratedPathPattern))
      refuse('invalid_params', 'Not a pattern of generated files');
  };

  const withDenials = <T extends { denyRead?: string[]; denyWrite?: string[]; deniedEnvVars?: string[] }>(
    sandbox: T,
  ): T => ({
    ...sandbox,
    denyRead: [...new Set([...(sandbox.denyRead ?? []), ...sensitive])],
    denyWrite: [...new Set([...namedDatabaseFiles(sandbox.denyWrite ?? []), ...sensitiveWrite])],
    deniedEnvVars: [...new Set([...(sandbox.deniedEnvVars ?? []), ...SANDBOX_DENIED_ENV_VARS])],
  });

  const rules: Partial<{
    [M in EngineMethod]: (params: MethodParams<M>) => MethodParams<M> | Promise<MethodParams<M>>;
  }> = {
    'session.start': (spec) => {
      const extra = sandboxRoots();
      const readable = readRoots();
      inside(spec.cwd, 'The working directory');
      insideAll(spec.additionalDirectories, 'An additional directory', extra);
      insideAll(spec.writableRoots, 'A writable root', extra);
      limitMode(spec.permissionMode);
      const policy = spec.policy;
      // The denied paths, the readable roots and the protected paths of every provider come from the policy:
      // without one the engine's secrets would be readable and nothing would bound the session.
      if (!policy) refuse('invalid_params', 'A session needs a policy on this engine');
      limitMode(policy.permissions.claude);
      if (policy.permissions.sandbox === 'danger-full-access')
        refuse('permission_mode_too_high', 'A full-access sandbox is not allowed on this engine');
      const { placement, filesystem } = policy;
      inside(placement.path, 'The placement', extra);
      insideAll(filesystem.readableRoots, 'A readable root', readable);
      insideAll(filesystem.writableRoots, 'A writable root', extra);
      insideAll(filesystem.readOnlyPaths, 'A read-only path', readable);
      if (filesystem.sessionFolder) inside(filesystem.sessionFolder, 'The session folder', extra);
      if (filesystem.sessionFoldersRoot)
        inside(filesystem.sessionFoldersRoot, 'The session folders root', extra);
      if (placement.kind === 'review_copy') {
        inside(placement.gitDir, 'The git directory', extra);
        if (placement.cacheDir) inside(placement.cacheDir, 'The cache directory', extra);
        if (placement.tempDir) inside(placement.tempDir, 'The temporary directory', extra);
      }
      if (placement.kind === 'task_worktree') {
        // Codex and NanoGPT take these as writable roots (the objects, refs and logs of the repository and the
        // worktree's own admin directory): they must be a registered repo's git directory and one of its worktrees.
        const repoGitDirs = config.repos.map((repo) => path.join(repo.path, '.git'));
        if (
          placement.gitDir &&
          !repoGitDirs.some((dir) => resolveReal(dir) === resolveReal(placement.gitDir!))
        )
          refuse('path_outside_roots', 'The git directory is not that of a registered repo');
        if (placement.worktreeGitDir) {
          if (
            !placement.gitDir ||
            !isWithin(
              path.join(resolveReal(placement.gitDir), 'worktrees'),
              resolveReal(placement.worktreeGitDir),
            )
          )
            refuse('path_outside_roots', 'The worktree git directory is not inside the repository');
        }
      }
      let sandbox = spec.sandbox;
      if (usesCodexCli(spec.provider ?? 'claude') && sandbox?.portable?.readBoundary !== undefined) {
        const boundary = SessionReadBoundary.safeParse(sandbox?.portable?.readBoundary);
        if (!boundary.success) refuse('invalid_params', 'The explicit read boundary is invalid');
        const portable = sandbox!.portable!;
        if (
          ![...boundary.data.deniedRoots, ...boundary.data.allowedPaths.map((entry) => entry.path)].every(
            isReadBoundaryPath,
          )
        )
          refuse('invalid_params', 'The read boundary needs absolute normalized paths');
        const blocked = [...sensitive, ...(filesystem.deniedPaths ?? [])].map(resolveReal);
        const matchesDenied = pathPatternMatcher(blocked, process.platform === 'darwin');
        const hardDenied = (target: string) => matchesDenied(resolveReal(target));
        const required = [
          spec.cwd,
          ...(placement.kind === 'task_worktree' && placement.gitDir ? [placement.gitDir] : []),
        ];
        if (policy.permissions.sandbox === 'workspace-write') {
          if (!portable.tmpDir || !portable.env.PROJECTMAN_SESSION_DIR)
            refuse('invalid_params', 'A writing worktree session needs private directories');
          for (const [target, root] of [
            [portable.tmpDir, paths.sessionTmpRoot],
            [portable.env.PROJECTMAN_SESSION_DIR, paths.sessionFoldersRoot],
          ]) {
            if (
              !root ||
              !target ||
              resolveReal(target) === resolveReal(root) ||
              !isWithin(resolveReal(root), resolveReal(target))
            )
              refuse('path_outside_roots', 'A private directory must be below its engine-owned root');
          }
          required.push(portable.tmpDir, portable.env.PROJECTMAN_SESSION_DIR);
        }
        if (required.some(hardDenied)) refuse('path_outside_roots', 'A required path is denied');
        const ownCandidates = [
          spec.cwd,
          ...filesystem.readableRoots,
          ...(filesystem.readOnlyPaths ?? []),
          ...(placement.kind === 'task_worktree' && placement.gitDir ? [placement.gitDir] : []),
          ...(sandbox?.allowRead ?? []),
          ...portable.allowWrite,
          ...(portable.tmpDir ? [portable.tmpDir] : []),
          ...homeReads(),
          ...present([paths.sessionFoldersRoot, paths.browsersDir]),
        ];
        // Never reopen homes or collectors of other members' checkouts/caches. A permitted
        // root is still checked against the engine's read roots after resolving symlinks.
        const collectors = present([
          home,
          userHome,
          paths.worktreesRoot,
          paths.workspacesRoot,
          memberCaches,
          attachmentsCache,
        ]);
        const allowedPaths = boundary.data.allowedPaths.filter((entry) => {
          const real = resolveReal(entry.path);
          if (hardDenied(entry.path)) return false;
          let kindMatches = true;
          try {
            const stat = statSync(entry.path);
            kindMatches = entry.kind === 'file' ? stat.isFile() : stat.isDirectory();
          } catch {
            // Optional technical files and newly allocated directories may not exist yet.
          }
          if (!kindMatches) refuse('path_outside_roots', 'A read exception has the wrong path kind');
          if (collectors.some((root) => isWithin(real, resolveReal(root))))
            refuse('path_outside_roots', 'A read exception would reopen a shared parent');
          if (isWithin(resolveReal(memberCaches), real)) {
            const parts = path.relative(resolveReal(memberCaches), real).split(path.sep);
            if (parts.length < 3 || (spec.member && parts[1] !== spec.member))
              refuse('path_outside_roots', 'A cache exception must name the member’s own directory or file');
          }
          inside(entry.path, 'A read boundary exception', readable);
          if (!ownCandidates.some((candidate) => resolveReal(candidate) === real))
            refuse('path_outside_roots', 'A read exception is not a session path');
          // Technical files stay exact-file grants, even if the hub sends a directory kind.
          if (
            entry.kind === 'directory' &&
            [path.join(userHome, '.gitconfig'), userExcludesFile(userHome)].some(
              (file) => file && resolveReal(file) === real,
            )
          )
            refuse('path_outside_roots', 'A technical file cannot grant directory access');
          return true;
        });
        if (
          required.some(
            (target) =>
              !allowedPaths.some(
                (entry) =>
                  entry.kind === 'directory' && isWithin(resolveReal(entry.path), resolveReal(target)),
              ),
          )
        )
          refuse('path_outside_roots', 'A required path is outside the read boundary');
        const shared = portable.tmpDir
          ? [...paths.claudeTmpRoots, ...(paths.sessionTmpRoot ? [path.dirname(paths.sessionTmpRoot)] : [])]
          : [];
        sandbox = {
          ...sandbox!,
          allowRead: sandbox!.allowRead?.filter((target) => !hardDenied(target)),
          allowWrite: sandbox!.allowWrite.filter((target) => !hardDenied(target)),
          portable: {
            ...portable,
            allowWrite: portable.allowWrite.filter((target) => !hardDenied(target)),
            readBoundary: {
              deniedRoots: [
                ...new Set(
                  [...boundary.data.deniedRoots, userHome, home, ...shared].flatMap((root) => [
                    root,
                    resolveReal(root),
                  ]),
                ),
              ],
              allowedPaths,
            },
          },
        };
      }
      if (sandbox) {
        insideAll(sandbox.allowWrite, 'A writable sandbox path', extra);
        insideAll(sandbox.allowRead, 'A readable sandbox path', readable);
        insideAll(sandbox.portable?.allowWrite, 'A portable path', extra);
        if (sandbox.portable?.tmpDir) inside(sandbox.portable.tmpDir, 'The temporary directory', extra);
        for (const command of sandbox.excludedCommands ?? [])
          if (!READER_UNSANDBOXED_COMMANDS.includes(command))
            refuse('command_not_allowed', 'A command outside the sandbox is not allowed on this engine');
        for (const name of [...Object.keys(sandbox.env ?? {}), ...Object.keys(sandbox.portable?.env ?? {})])
          if (
            !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
            FORBIDDEN_ENV.some((pattern) => pattern.test(name)) ||
            (BILLING_ENV_VARS as readonly string[]).includes(name)
          )
            refuse('invalid_params', `The environment variable ${name} is not allowed`);
        sandbox = withDenials(sandbox);
      } else if (!spec.provider || spec.provider === 'claude') {
        // Never a session without a sandbox because the cloud left it out.
        const baseline: AgentSandbox = {
          allowWrite: [spec.cwd, ...(spec.writableRoots ?? [])],
          allowedDomains: [...OPEN_OUTBOUND_DOMAINS],
          allowLocalBinding: true,
        };
        sandbox = withDenials(baseline);
      }
      const protectedPolicy = policy
        ? {
            ...policy,
            filesystem: {
              ...policy.filesystem,
              deniedPaths: [...new Set([...(policy.filesystem.deniedPaths ?? []), ...sensitive])],
            },
          }
        : undefined;
      sessions.set(spec.sessionId, {
        cwd: resolveReal(spec.cwd),
        ...(sessions.get(spec.sessionId)?.folder ? { folder: sessions.get(spec.sessionId)!.folder! } : {}),
      });
      if (sessions.size > 2000) sessions.delete(sessions.keys().next().value!);
      return {
        ...spec,
        ...(sandbox ? { sandbox } : {}),
        ...(protectedPolicy ? { policy: protectedPolicy } : {}),
      };
    },
    'session.assert_workspace_config': (params) => {
      inside(params.cwd, 'The working directory');
      return params;
    },
    'terminal.input': (params) => {
      if (!config.allowRemoteTerminalInput)
        refuse('terminal_input_disabled', 'Terminal input from the cloud is disabled on this engine');
      return params;
    },
    'transcript.has_content': (params) => {
      inside(params.path, 'The transcript', [...roots(), ...options.transcriptRoots.map(resolveReal)]);
      if (params.confineTo) inside(params.confineTo, 'The transcript confinement');
      return params;
    },
    'transcript.read': (params) => {
      inside(params.path, 'The transcript', [...roots(), ...options.transcriptRoots.map(resolveReal)]);
      if (params.opts?.confineTo) inside(params.opts.confineTo, 'The transcript confinement');
      limit.token(params.uploadToken);
      return params;
    },
    'transcript.summary': (params) => {
      inside(params.path, 'The transcript', [...roots(), ...options.transcriptRoots.map(resolveReal)]);
      if (params.confineTo) inside(params.confineTo, 'The transcript confinement');
      return params;
    },
    'worktree.refreshDependencies': (params) => {
      inside(params[0], 'The worktree');
      return params;
    },
    'worktree.head': (params) => {
      inside(params[0], 'The repository');
      return params;
    },
    'worktree.ensureForTask': ([arg]) => [{ ...arg, project: bind(arg.project, arg.repoName) }],
    'worktree.ensureMergeFix': ([arg]) => {
      commitIds(arg.commit);
      return [{ ...arg, project: bind(arg.project, arg.repoName) }];
    },
    'worktree.findMergeFix': ([arg]) => [{ ...arg, project: bind(arg.project, arg.repoName) }],
    'worktree.removeMergeFix': ([arg]) => [{ ...arg, project: bind(arg.project, arg.repoName) }],
    'worktree.listMergeFixes': ([arg]) => [{ ...arg, project: bind(arg.project, arg.repoName) }],
    'worktree.find': ([arg]) => [{ ...arg, project: bind(arg.project, arg.repoName) }],
    'worktree.status': (params) => {
      inside(params[0], 'The worktree');
      return params;
    },
    'worktree.remove': ([arg]) => {
      const worktreesRoot = paths.worktreesRoot ? resolveReal(paths.worktreesRoot) : null;
      const real = resolveReal(arg.path);
      if (!worktreesRoot || real === worktreesRoot || !isWithin(worktreesRoot, real))
        refuse('path_outside_roots', 'Only a worktree below the worktrees root can be removed');
      return [arg];
    },
    'workspace.location': ([key]) => [{ ...key, project: bind(key.project, key.repoName) }],
    'workspace.home': ([arg]) => {
      registeredProject(arg.projectKey);
      return [arg];
    },
    'workspace.ensure': ([key]) => [{ ...key, project: bind(key.project, key.repoName) }],
    'workspace.status': ([key]) => [{ ...key, project: bind(key.project, key.repoName) }],
    'workspace.sourceHead': ([key, branch]) => [{ ...key, project: bind(key.project, key.repoName) }, branch],
    'workspace.fetchBase': ([key]) => [{ ...key, project: bind(key.project, key.repoName) }],
    'workspace.prepareDependencies': ([key]) => [{ ...key, project: bind(key.project, key.repoName) }],
    'workspace.findTaskBranch': ([key, taskKey, ref]) => [
      { ...key, project: bind(key.project, key.repoName) },
      taskKey,
      ref,
    ],
    'workspace.resolveSource': ([source]) => {
      inside(source.path, 'The source repository');
      return [source];
    },
    'workspace.checkoutTaskBranch': ([key, checkout]) => {
      if (checkout.mode === 'fetch') inside(checkout.source.path, 'The source repository');
      return [{ ...key, project: bind(key.project, key.repoName) }, checkout];
    },
    'workspace.checkoutReview': ([key, source, ref]) => {
      inside(source.path, 'The source repository');
      return [{ ...key, project: bind(key.project, key.repoName) }, source, ref];
    },
    // The target is always the registered repository the key names: the cloud sends no path or ref.
    'workspace.publishTaskBranch': ([key, taskKey, branch, commit]) => {
      commitIds(commit);
      return [{ ...key, project: bind(key.project, key.repoName) }, taskKey, branch, commit];
    },
    'full_test.run': async (params) => {
      const { spec } = params;
      // The run that makes generated files again (PM-1050) is the only one with writable directories (the
      // engine derives them from the patterns), and it runs the registered repo's own `regenerateCommand`,
      // never its `fullTestCommand`; every other run runs the `fullTestCommand` and writes nothing.
      if (spec.regenerate) {
        const entry = mergeRepo(spec.regenerate.ref);
        mergeIdOf(spec.regenerate.mergeId);
        regeneratePatterns(spec.regenerate.patterns);
        if (entry.regenerateCommand === undefined || entry.regenerateCommand !== spec.command)
          refuse('command_not_allowed', 'The regeneration command is not configured for this repository');
        if (spec.githubActions || (spec.npmCi && spec.npmCi.mergeId !== spec.regenerate.mergeId))
          refuse('invalid_params', 'The regeneration runs in its own checkout, on this engine');
        try {
          await assertRegenerateCheckout(paths.worktreesRoot, spec);
        } catch {
          refuse('invalid_params', 'The regeneration needs the canonical merge checkout of its merge id');
        }
      } else if (
        !config.repos.some(
          (repo) => repo.fullTestCommand !== undefined && repo.fullTestCommand === spec.command,
        )
      )
        refuse('command_not_allowed', 'The test command is not the one configured on this engine');
      if (spec.githubActions) {
        // The merge check as a GitHub Actions workflow (PM-900) runs no command here: `cwd` is a label, not a
        // path, and the engine pushes the one commit to the one branch the owner named for this repository.
        const check = spec.githubActions;
        const entry = await mergeBase(check.ref, check.base);
        mergeIdOf(check.mergeId);
        commitIds(check.commit);
        if (entry.fullTestCommand !== spec.command)
          refuse('command_not_allowed', 'The test command is not configured for this repository');
        if (spec.cwd !== `github-actions:${check.repo}` || spec.npmCi || spec.requireHeavyLock)
          refuse('invalid_params', 'A GitHub Actions merge check carries no checkout, installation or lock');
        return params;
      }
      inside(spec.cwd, 'The test directory');
      if (spec.npmCi) {
        const entry = mergeRepo(spec.npmCi.ref);
        mergeIdOf(spec.npmCi.mergeId);
        if (!spec.regenerate && entry.fullTestCommand !== spec.command)
          refuse('command_not_allowed', 'The test command is not configured for this repository');
        try {
          await assertNpmCiCheckout(paths.worktreesRoot, spec);
        } catch {
          refuse(
            'invalid_params',
            'Dependency preparation needs the canonical merge checkout and required heavy lock',
          );
        }
      }
      insideAll(spec.sandbox.allowRead, 'A readable test path', readRoots());
      return {
        ...params,
        spec: {
          ...spec,
          // The command writes only its own run directory, so the write denials do not apply.
          sandbox: { ...spec.sandbox, denyRead: [...new Set([...spec.sandbox.denyRead, ...sensitive])] },
        },
      };
    },
    'screenshots.run': (params) => {
      const { spec } = params;
      const extra = sandboxRoots();
      inside(spec.cwd, 'The screenshot directory');
      inside(spec.sessionDir, 'The session folder');
      if (
        spec.browsersDir &&
        (!paths.browsersDir || resolveReal(spec.browsersDir) !== resolveReal(paths.browsersDir))
      )
        refuse('path_outside_roots', 'The browsers directory is not the engine’s');
      insideAll(spec.sandbox.allowWrite, 'A writable screenshot path', extra);
      insideAll(spec.sandbox.allowRead, 'A readable screenshot path', readRoots());
      // The engine assembles the command (`npm run shots -- <scenario> <flags>`): the scenario is a path
      // inside the roots, the flags are the few `screenshotArgs` builds, never `--out` or `--machine`.
      const [scenario, ...flags] = spec.args;
      if (scenario === undefined || scenario.startsWith('-'))
        refuse('command_not_allowed', 'The screenshot scenario is missing');
      inside(scenario, 'The screenshot scenario');
      for (let index = 0; index < flags.length; index += 1) {
        const flag = flags[index]!;
        if (flag === '--full-page') continue;
        const value = flags[index + 1];
        const valid =
          (flag === '--widths' && /^\d{2,5}(,\d{2,5}){0,9}$/.test(value ?? '')) ||
          (flag === '--scale' && /^\d(\.\d{1,2})?$/.test(value ?? '')) ||
          (flag === '--timeout' && /^\d{1,4}$/.test(value ?? '')) ||
          (flag === '--seed' && /^[A-Za-z0-9._-]{1,64}$/.test(value ?? ''));
        if (!valid) refuse('command_not_allowed', 'A screenshot argument is not allowed on this engine');
        index += 1;
      }
      return {
        ...params,
        spec: {
          ...spec,
          sandbox: {
            ...spec.sandbox,
            denyRead: [...new Set([...spec.sandbox.denyRead, ...sensitive])],
            denyWrite: [...new Set([...namedDatabaseFiles(spec.sandbox.denyWrite), ...sensitiveWrite])],
          },
        },
      };
    },
    'host.is_directory': (params) => {
      inside(params.path, 'The path', readRoots());
      return params;
    },
    'host.resolve_git_dir': (params) => {
      inside(params.repoPath, 'The repository');
      return params;
    },
    'host.realpath': (params) => {
      inside(params.path, 'The path', readRoots());
      return params;
    },
    'host.is_real_directory': (params) => {
      inside(params.dir, 'The directory', readRoots());
      return params;
    },
    'host.prepare_member_sandbox_dir': (params) => {
      const relative = path.relative(resolveReal(memberCaches), resolveReal(params.dir)).split(path.sep);
      if (relative.length !== 2 || !PROJECT_KEY.test(relative[0]!) || !HANDLE.test(relative[1]!))
        refuse('path_outside_roots', 'Only <home>/member-caches/<project>/<member> can be prepared');
      return params;
    },
    'host.prepare_portable_paths': (params) => {
      insideAll(params.paths, 'A portable path', sandboxRoots());
      return params;
    },
    'folders.make': (params) => {
      if (params.dir) inside(params.dir, 'The session folder');
      if (params.tmpDir) inside(params.tmpDir, 'The temporary directory');
      const known = sessions.get(params.sessionId);
      sessions.set(params.sessionId, {
        cwd: known?.cwd ?? '',
        ...(params.dir ? { folder: resolveReal(params.dir) } : {}),
      });
      return params;
    },
    'files.resolve_scenario': (params) => {
      inside(params.roots.cwd, 'The working directory');
      inside(params.roots.sessionDir, 'The session folder');
      return params;
    },
    'files.list_images': (params) => {
      inside(params.dir, 'The image directory');
      return params;
    },
    'merge.prepare': async (params) => {
      await mergeBase(params.ref, params.base);
      commitIds(params.commit);
      return params;
    },
    'merge.is_ancestor': (params) => {
      mergeRepo(params.ref);
      commitIds(params.ancestor, params.commit);
      return params;
    },
    'merge.build': (params) => {
      mergeRepo(params.ref);
      commitIds(params.onto, params.commit);
      if (!isMergeMessage(params.message) || params.message.trim().length === 0)
        refuse('invalid_params', 'Not a commit message');
      regeneratePatterns(params.regenerate ?? []);
      return params;
    },
    'merge.commit_regenerated': (params) => {
      mergeRepo(params.ref);
      mergeIdOf(params.mergeId);
      commitIds(params.onto, params.commit);
      if (!isMergeMessage(params.message) || params.message.trim().length === 0)
        refuse('invalid_params', 'Not a commit message');
      regeneratePatterns(params.patterns);
      if (params.paths.length > 50 || !params.paths.every(isRegeneratedPath))
        refuse('invalid_params', 'Not a set of paths');
      return params;
    },
    'merge.checkout_conflicts': async (params) => {
      await mergeBase(params.ref, params.base);
      if (params.changed.some((entry) => entry.includes('\0') || entry.length > 4096))
        refuse('invalid_params', 'Not a path');
      return params;
    },
    'merge.checkout_for_check': (params) => {
      const entry = mergeRepo(params.ref);
      mergeIdOf(params.mergeId);
      commitIds(params.mergeCommit);
      if (params.depsFrom !== null)
        inside(params.depsFrom, 'The dependencies path', [
          ...present([paths.worktreesRoot]).map(resolveReal),
          resolveReal(entry.path),
        ]);
      return params;
    },
    'merge.release_check': (params) => {
      mergeRepo(params.ref);
      mergeIdOf(params.mergeId);
      return params;
    },
    'merge.push': async (params) => {
      await mergeBase(params.ref, params.base);
      commitIds(params.mergeCommit);
      return params;
    },
    'merge.remote_tags': async (params) => {
      await mergeBase(params.ref, params.base);
      return params;
    },
    'merge.push_tag': async (params) => {
      await mergeBase(params.ref, params.base);
      commitIds(params.commit);
      if (!isReleaseTagName(params.tag)) refuse('invalid_params', 'Not a release tag name');
      return params;
    },
    'merge.advance': async (params) => {
      await mergeBase(params.ref, params.base);
      commitIds(params.from, params.to);
      return params;
    },
    'merge.read_file': async (params) => {
      if ('base' in params.at) await mergeBase(params.ref, params.at.base);
      else {
        mergeRepo(params.ref);
        commitIds(params.at.commit);
      }
      if (!isRepoFilePath(params.path)) refuse('invalid_params', 'Not a path inside the repository');
      return params;
    },
    'merge.commit_files': (params) => {
      mergeRepo(params.ref);
      commitIds(params.onto);
      if (!isCommitFileSet(params.files))
        refuse(
          'invalid_params',
          'Not a set of 1 to 2 different files inside the repository, each text under 1 MiB',
        );
      if (!isMergeMessage(params.message) || params.message.trim().length === 0)
        refuse('invalid_params', 'Not a commit message');
      return params;
    },
    'merge.list_paths': async (params) => {
      await mergeBase(params.ref, params.base);
      return params;
    },
    'merge.changed_paths': async (params) => {
      await mergeBase(params.ref, params.base);
      for (const item of params.items) {
        if ('branch' in item.at) {
          if (!(await isBranchName(item.at.branch))) refuse('invalid_params', 'Not a branch name');
        } else commitIds('commit' in item.at ? item.at.commit : item.at.merge);
      }
      return params;
    },
    'files.export': (params) => {
      const allowed = limit.exportRoots(params.sessionId);
      if (!path.isAbsolute(params.root) || !allowed.includes(resolveReal(params.root)))
        refuse('path_outside_roots', 'Files can be exported from a running session’s own directories only');
      limit.token(params.uploadToken);
      return params;
    },
    'files.materialize_into_session': (params) => {
      limit.token(params.downloadToken);
      // The session's own folder is the only place: the engine knows it from `folders.make`.
      if (!sessions.get(params.sessionId)?.folder)
        refuse('invalid_params', 'The session has no folder on this engine');
      if (
        !params.name ||
        params.name.length > 255 ||
        params.name === '.' ||
        params.name === '..' ||
        /[/\\\0]/.test(params.name)
      )
        refuse('invalid_params', 'Invalid file name');
      return params;
    },
    'files.materialize': (params) => {
      limit.token(params.downloadToken);
      limit.cachePath(params.projectKey, params.taskKey, params.name);
      return params;
    },
  };

  const limit: EngineLimit = {
    sensitiveRead: () => [...sensitive],
    async check(method, params) {
      const rule = rules[method];
      return rule ? ((await rule(params as never)) as MethodParams<typeof method>) : params;
    },
    exportRoots(sessionId) {
      const known = sessions.get(sessionId);
      return known ? present([known.cwd, known.folder]) : [];
    },
    roots,
    token(value) {
      if (!TOKEN.test(value)) refuse('invalid_params', 'Invalid transfer token');
      return value;
    },
    cachePath(projectKey, taskKey, name) {
      if (
        !PROJECT_KEY.test(projectKey) ||
        !TASK_KEY.test(taskKey) ||
        !name ||
        name.length > 255 ||
        name === '.' ||
        name === '..' ||
        /[/\\\0]/.test(name)
      )
        refuse('invalid_params', 'Invalid attachment name');
      return path.join(attachmentsCache, projectKey, taskKey, name);
    },
    async signal(pid, signal) {
      const deny = (): never => refuse('signal_not_allowed', 'This process is not one the engine may signal');
      if (pid <= 1 || pid === selfPid) deny();
      const list = await probe.processes();
      if (!list) return deny();
      const byPid = new Map(list.map((record) => [record.pid, record]));
      const target = byPid.get(pid);
      if (!target) return 'gone';
      if (selfUid !== null && target.uid !== selfUid) deny();
      const children = new Map<number, ProcessRecord[]>();
      for (const record of list) children.set(record.ppid, [...(children.get(record.ppid) ?? []), record]);
      const tree = new Set<number>();
      const queue = options.sessionPids().filter((root) => byPid.has(root));
      while (queue.length > 0) {
        const next = queue.pop()!;
        if (tree.has(next) || next === selfPid) continue;
        tree.add(next);
        for (const child of children.get(next) ?? []) queue.push(child.pid);
      }
      if (!tree.has(pid)) {
        // Not in a running session's tree: only an orphan this engine's own instance left behind.
        const marker = (await probe.envValues([pid], ['PROJECTMAN_INSTANCE'])).get(pid);
        if (marker?.PROJECTMAN_INSTANCE !== options.instanceTag) deny();
      }
      // The same process still: a pid is reused, a start time is not.
      const again = (await probe.processes())?.find((record) => record.pid === pid);
      if (!again) return 'gone';
      if (again.startedAt !== target.startedAt) deny();
      return probe.signal(pid, signal);
    },
  };
  return limit;
}
