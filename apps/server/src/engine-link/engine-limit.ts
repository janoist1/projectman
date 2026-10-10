import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectConfig } from '@projectman/shared';
import type { AgentSandbox, EnginePaths, MachineProbe, ProcessRecord } from '../contracts';
import {
  OPEN_OUTBOUND_DOMAINS,
  READER_UNSANDBOXED_COMMANDS,
  SANDBOX_DENIED_ENV_VARS,
  sensitivePaths,
} from '../domain/session-policy';
import { isBranchName, isCommitId, isMergeId, isMergeMessage } from '../engine-host/merge-input';
import { isWithin } from '../engine-host/within';
import { BILLING_ENV_VARS } from '../runner';
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

export interface EngineLimitOptions {
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

function refuse(code: EngineErrorCode, message: string): never {
  throw new EngineRpcError(code, message);
}

/** The real path of the nearest existing ancestor, plus the not yet existing rest (a path to be made). */
export function resolveReal(target: string): string {
  const absolute = path.resolve(target);
  let head = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...rest.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return absolute;
      rest.push(path.basename(head));
      head = parent;
    }
  }
}

export interface EngineLimit {
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
  const sensitiveWrite = [...sensitive, files.config, files.status];
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
   */
  const sandboxRoots = (): string[] => [
    ...roots(),
    ...present([paths.heavyLockDir ? path.dirname(paths.heavyLockDir) : null, paths.browsersDir]).map(
      resolveReal,
    ),
  ];
  const within = (candidates: readonly string[], target: string): boolean => {
    if (!path.isAbsolute(target) || target.includes('\0')) return false;
    const real = resolveReal(target);
    return candidates.some((root) => isWithin(root, real));
  };
  const inside = (target: string, what: string, candidates: readonly string[] = roots()): string => {
    if (!within(candidates, target)) refuse('path_outside_roots', `${what} is outside the engine's roots`);
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

  const withDenials = <T extends { denyRead?: string[]; denyWrite?: string[]; deniedEnvVars?: string[] }>(
    sandbox: T,
  ): T => ({
    ...sandbox,
    denyRead: [...new Set([...(sandbox.denyRead ?? []), ...sensitive])],
    denyWrite: [...new Set([...(sandbox.denyWrite ?? []), ...sensitiveWrite])],
    deniedEnvVars: [...new Set([...(sandbox.deniedEnvVars ?? []), ...SANDBOX_DENIED_ENV_VARS])],
  });

  const rules: Partial<{
    [M in EngineMethod]: (params: MethodParams<M>) => MethodParams<M> | Promise<MethodParams<M>>;
  }> = {
    'session.start': (spec) => {
      const extra = sandboxRoots();
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
      insideAll(filesystem.readableRoots, 'A readable root', extra);
      insideAll(filesystem.writableRoots, 'A writable root', extra);
      insideAll(filesystem.readOnlyPaths, 'A read-only path', extra);
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
      if (sandbox) {
        insideAll(sandbox.allowWrite, 'A writable sandbox path', extra);
        insideAll(sandbox.allowRead, 'A readable sandbox path', extra);
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
    'workspace.export_branch': (params) => {
      limit.token(params.uploadToken);
      return { ...params, key: { ...params.key, project: bind(params.key.project, params.key.repoName) } };
    },
    'full_test.run': (params) => {
      const { spec } = params;
      if (
        !config.repos.some(
          (repo) => repo.fullTestCommand !== undefined && repo.fullTestCommand === spec.command,
        )
      )
        refuse('command_not_allowed', 'The test command is not the one configured on this engine');
      inside(spec.cwd, 'The test directory');
      insideAll(spec.sandbox.allowRead, 'A readable test path', sandboxRoots());
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
      insideAll(spec.sandbox.allowRead, 'A readable screenshot path', extra);
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
            denyWrite: [...new Set([...spec.sandbox.denyWrite, ...sensitiveWrite])],
          },
        },
      };
    },
    'host.is_directory': (params) => {
      inside(params.path, 'The path', sandboxRoots());
      return params;
    },
    'host.resolve_git_dir': (params) => {
      inside(params.repoPath, 'The repository');
      return params;
    },
    'host.realpath': (params) => {
      inside(params.path, 'The path', sandboxRoots());
      return params;
    },
    'host.is_real_directory': (params) => {
      inside(params.dir, 'The directory', sandboxRoots());
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
    'merge.advance': async (params) => {
      await mergeBase(params.ref, params.base);
      commitIds(params.from, params.to);
      return params;
    },
    'files.export': (params) => {
      const allowed = limit.exportRoots(params.sessionId);
      if (!path.isAbsolute(params.root) || !allowed.includes(resolveReal(params.root)))
        refuse('path_outside_roots', 'Files can be exported from a running session’s own directories only');
      limit.token(params.uploadToken);
      return params;
    },
    'files.materialize': (params) => {
      limit.token(params.downloadToken);
      limit.cachePath(params.projectKey, params.taskKey, params.name);
      return params;
    },
  };

  const limit: EngineLimit = {
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
