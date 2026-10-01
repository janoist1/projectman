import path from 'node:path';
import {
  effectiveRepo,
  repoOf,
  roleSessionAccess,
  roleSessionTools,
  sessionPermissions,
  REVIEW_SHELL_TOOLS,
  DEVELOPMENT_SHELL_TOOLS,
  LOCAL_PUBLISHING_OPERATIONS,
  managedVmPermissions,
} from '@projectman/shared';
import type { RoleId, ProjectConfig, Task } from '@projectman/shared';
import type { SessionPolicy } from '../contracts';
import { claudeShellRule, claudeToolRules } from '../runner';
import type { AgentSandbox } from '../contracts';
import { isWithin } from './command-paths';
import { editsFilesInPlace, IN_PLACE_EDIT_MESSAGE } from './in-place-edits';
import { isReadOnlyCommand } from './read-only-commands';
import { parseShellCommand } from './shell-words';
import { isWorktreeRoutine } from './worktree-commands';

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

/**
 * The OS sandbox of a session in a task's own worktree, the first step of PM-87 (see the PM-126
 * probe in docs/PROVIDERS.md): its shell commands run without asking, writing only the worktree
 * (with the repository's shared git directory, minus hooks and config), the temp directory, the
 * npm cache and the development data directory, and reaching only the npm registry. The tests may
 * listen on local ports, which also opens every local port (decision 24).
 */
export const WORKTREE_SANDBOX: AgentSandbox = {
  allowWrite: ['~/.npm', '~/.projectman-dev'],
  allowedDomains: ['registry.npmjs.org'],
  allowLocalBinding: true,
};

/**
 * What the built-in file tools never read or change, whatever the permission mode (PM-165): the
 * credentials of the user (`userHome`) and the sensitive parts of the live instance (`appHome`:
 * the database, the cookie secret, the logs, the customization repository, the members' memory,
 * the publishing identity and the spool). Not the whole app home: the members' worktrees,
 * workspaces and the task attachments live there, and a deny rule wins over an allow rule.
 */
export function sensitivePaths(input: { userHome: string; appHome?: string }): string[] {
  // Not the whole `.claude`: the member's own saved tool outputs (`projects/.../tool-results`) and the
  // plan file of the plan mode (`plans`) live there. Only the credentials and the settings.
  const user = [
    '.ssh',
    '.config/gh',
    '.claude/.credentials.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks',
    '.claude.json',
    '.codex',
    '.npmrc',
  ];
  // `logs` is not created by the server itself: the owner's live home has it (the process logs of
  // `npm start`). A name that does not exist denies nothing.
  const app = ['db.sqlite*', 'secret', 'logs', 'customization', 'memory', 'github-publish', 'spool'];
  return [
    ...user.map((name) => path.join(input.userHome, name)),
    ...(input.appHome ? app.map((name) => path.join(input.appHome!, name)) : []),
  ];
}

/** Hosts the web fetch tool never reaches: the live instance and anything else on this machine. */
export const HARD_DENIED_HOSTS = ['localhost', '127.0.0.1'];

export type CommandVerdict = { behavior: 'allow' } | { behavior: 'deny'; message: string };

/**
 * Whether the session works in the task's own worktree, inside the worktrees root, or in the
 * member's own workspace, inside the workspaces root (PM-138).
 */
function inTaskWorktree(input: {
  config: ProjectConfig;
  session: { cwd: string; role: RoleId };
  task: Pick<Task, 'repo'> | null;
  worktreesRootDir?: string;
  workspacesRootDir?: string;
}): boolean {
  const { config, session, task } = input;
  if (!effectiveRepo(config, task) || !sessionPolicyFor(session.role, config).worktree) return false;
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
}): string[] {
  const { config, cwd, projectKey, task, worktreesRootDir, attachmentsDir } = input;
  const roots = [cwd];
  const repo = effectiveRepo(config, task);
  if (task && repo && worktreesRootDir) {
    const projectDir = path.join(path.resolve(worktreesRootDir), projectKey);
    const worktree = path.join(projectDir, `${task.key}-${repo}`);
    if (worktree !== projectDir && isWithin(projectDir, worktree)) roots.push(worktree);
  }
  if (task && attachmentsDir) roots.push(attachmentsDir);
  return roots;
}

/** Characters a directory may hold to be named in a Claude Code path rule as it is (no pattern or rule syntax). */
const PLAIN_RULE_PATH = /^\/[\w./@+~ -]*$/;

/**
 * Claude Code rules for the attachment directory of the session's task: its files are read without
 * asking (`read_attachment` gives their paths) and never edited, whatever the permission mode. Not
 * an extra working directory (`--add-dir`): in `acceptEdits` mode Claude Code would accept edits
 * there too. Codex ignores these rules; its sandbox lets it read and never write there. A path
 * with characters that mean something in a rule gets no rules: reading and editing there then ask
 * a human, as anywhere else outside the session's directories.
 */
export function attachmentToolRules(dir: string | null): { allow: string[]; deny: string[] } {
  if (!dir || !PLAIN_RULE_PATH.test(dir)) return { allow: [], deny: [] };
  // An absolute path in a rule starts with `//`; `**` takes everything below.
  const pattern = `/${dir.replace(/\/+$/, '')}/**`;
  return { allow: [`Read(${pattern})`], deny: [`Edit(${pattern})`] };
}

/**
 * Automatic decisions about shell commands; everything else reaches a human.
 * - deny: publishing (`git push`, `gh pr create`, `gh pr merge`) from a repository without GitHub;
 * - deny: a command that rewrites a file in place (`sed -i`, `perl -pi -e`), with a pointer to
 *   the editing tools, see `in-place-edits.ts`;
 * - allow: a developer's routine steps in the task's own worktree (lockfile install, formatting, `git add`,
 *   `git commit` with a message, `git merge --ff-only`), alone or in a chain with read-only
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
  session: { cwd: string; role: RoleId };
  task: Pick<Task, 'repo'> | null;
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
  if (inTaskWorktree(input)) {
    const defaultBranch = repoOf(config, effectiveRepo(config, task))?.defaultBranch;
    if (isWorktreeRoutine(parsed, { cwd: session.cwd, defaultBranch })) return { behavior: 'allow' };
  }
  if (task && readableRoots && isReadOnlyCommand(parsed, { cwd: session.cwd, roots: readableRoots })) {
    return { behavior: 'allow' };
  }
  return null;
}

export interface RoleSessionPolicy {
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
export function allowedToolsFor(role: RoleId, config: Pick<ProjectConfig, 'team'>): string[] {
  return claudeToolRules({ tools: roleSessionTools(config, role), deniedOperations: [] }).allow;
}
export function usesWorktree(role: RoleId, config: Pick<ProjectConfig, 'team'>): boolean {
  return sessionPolicyFor(role, config).worktree;
}

/** Build intent from actual placement. Strict sandbox enforcement is a separate activation. */
export function buildSessionPolicy(input: {
  config: ProjectConfig;
  role: RoleId;
  task: Pick<Task, 'repo'> | null;
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
  /**
   * The managed VM profile (PM-141), given only after its boundary was verified for this start:
   * the placement is the member's own workspace and the CLI asks nothing locally.
   */
  managedVm?: { boundary: { name: string; version: number } };
}): SessionPolicy {
  if (input.managedVm) return buildManagedVmPolicy({ ...input, managedVm: input.managedVm });
  const role = roleSessionAccess(input.config, input.role);
  const placement = input.placement;
  if (
    placement.kind === 'task_worktree' &&
    (!role.worktree || !input.task || !effectiveRepo(input.config, input.task))
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
    tools: roleSessionTools(input.config, input.role),
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
    network: { allowedDomains: [], allowLocalBinding: false, deniedHosts: [...HARD_DENIED_HOSTS] },
    outsideSandbox: enforcement === 'strict' ? 'deny' : 'ask',
    permissions,
  };
}

/**
 * The managed VM profile's policy (PM-141). It is a separate execution profile, not a strict
 * enforcement and not a mode migration: `enforcement` stays `legacy`, the member's `permissionMode`
 * is only read (`plan` stays research-only; the rest runs question-free) and never rewritten.
 * Nothing local is limited: no tool grants to render, no denied operations (the business rules and
 * the owner's exceptions apply at the domain, network and operation gate), no command rules.
 */
function buildManagedVmPolicy(input: {
  config: ProjectConfig;
  role: RoleId;
  task: Pick<Task, 'repo'> | null;
  placement: SessionPolicy['placement'];
  permissionMode?: string;
  readableRoots?: string[];
  protectedPaths?: string[];
  readOnlyPaths?: string[];
  managedVm: { boundary: { name: string; version: number } };
}): SessionPolicy {
  const placement = input.placement;
  if (placement.kind !== 'member_workspace')
    throw new Error('The managed VM profile works only in the member workspace placement.');
  const permissions = managedVmPermissions(input.permissionMode);
  const ownRoots = [placement.path];
  return {
    version: 1,
    enforcement: 'legacy',
    execution: { profile: 'managed_vm', boundary: input.managedVm.boundary },
    access: 'member_workspace',
    placement,
    tools: roleSessionTools(input.config, input.role),
    filesystem: {
      readableRoots: [...new Set([...ownRoots, ...(input.readableRoots ?? [])])],
      writableRoots: permissions.sandbox === 'read-only' ? [] : ownRoots,
      protectedPaths: [...new Set(input.protectedPaths ?? [])],
      ...(input.readOnlyPaths?.length ? { readOnlyPaths: [...new Set(input.readOnlyPaths)] } : {}),
    },
    deniedOperations: [],
    // Which hosts the worker reaches is the network gate's decision (PM-140), not a setting here.
    network: { allowedDomains: [], allowLocalBinding: false },
    outsideSandbox: 'deny',
    permissions,
  };
}

/** Delay before a done task's sessions are stopped, so an in-flight tool result still reaches the agent. */
export const DONE_TASK_CLEANUP_DELAY_MS = 2_000;
