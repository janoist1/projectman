import path from 'node:path';
import { DUTIES, roleBundle } from '@projectman/shared';
import type { RoleId, ProjectConfig, Task } from '@projectman/shared';

/**
 * Per-role session settings, kept in one place so they are easy to change.
 */

/** The team tools (MCP server "team"): every AI session may use them without asking. */
export const TEAM_TOOLS_ALLOWED = ['mcp__team__*'];

/** Read-only tools reviewers need constantly; pre-approving them avoids a stream of permission requests. */
export const READ_ONLY_REVIEW_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr diff:*)',
  'Bash(git status:*)',
  'Bash(git rev-parse:*)',
  'Bash(git merge-base:*)',
  'Bash(git branch --list:*)',
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(npm run typecheck:*)',
  'Bash(npx vitest run:*)',
  'Bash(npx tsc --noEmit:*)',
  'Bash(npx prettier --check:*)',
];

/** Ordinary development in the task branch; package additions still require permission. */
export const DEVELOPMENT_TOOLS = [
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git merge --ff-only:*)',
  'Bash(git rev-parse:*)',
  'Bash(git branch --show-current)',
  'Bash(npm install)',
  'Bash(npm ci)',
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(npm run typecheck:*)',
  'Bash(npm run build:*)',
  'Bash(npm run format:*)',
  'Bash(npm run lint:*)',
  'Bash(npx vitest:*)',
  'Bash(npx tsc:*)',
  'Bash(npx prettier:*)',
];

export const LOCAL_ONLY_DENIED_TOOLS = ['Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(gh pr merge:*)'];

export function deniedToolsFor(config: ProjectConfig, task: Pick<Task, 'repo'> | null): string[] {
  const repo = config.project.repos.find((repo) => repo.name === task?.repo);
  return repo && !repo.github ? [...LOCAL_ONLY_DENIED_TOOLS] : [];
}

export type CommandVerdict = { behavior: 'allow' } | { behavior: 'deny'; message: string };

/** Narrow automatic decisions for publishing and lockfile installs; everything else reaches a human. */
export function commandVerdict(input: {
  config: ProjectConfig;
  session: { cwd: string; role: RoleId };
  task: Pick<Task, 'repo'> | null;
  toolName: string;
  toolInput: unknown;
  worktreesRootDir?: string;
}): CommandVerdict | null {
  const { config, session, task, toolName, toolInput, worktreesRootDir } = input;
  if (toolName !== 'Bash' || !toolInput || typeof toolInput !== 'object') return null;
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== 'string') return null;
  // Quoted prose (e.g. a commit message mentioning git push) is not a publishing command.
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
  if (deniedToolsFor(config, task).length && /\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b/.test(unquoted)) {
    return { behavior: 'deny', message: 'The owner has not allowed publishing from this repository.' };
  }
  if (!worktreesRootDir || !task?.repo || !sessionPolicyFor(session.role, config).worktree) return null;
  const relative = path.relative(path.resolve(worktreesRootDir), path.resolve(session.cwd));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  // Accept only literal directories and these exact install commands, with no shell continuations.
  if (/[\r\n]/.test(command)) return null;
  let install = command.trim();
  const cd = /^cd[ \t]+(?:'([^']*)'|"([^"$`\\]*)"|([^\s"'$`\\;&|<>(){}\[\]*?!]+))[ \t]*&&[ \t]*/.exec(
    install,
  );
  if (cd) {
    const dir = cd[1] ?? cd[2] ?? cd[3]!;
    if (!dir || path.resolve(session.cwd, dir) !== path.resolve(session.cwd)) return null;
    install = install.slice(cd[0].length);
  }
  if (/^npm[ \t]+(?:ci|install)(?:[ \t]+--(?:prefer-offline|no-audit|no-fund))*$/.test(install))
    return { behavior: 'allow' };
  return null;
}

export interface RoleSessionPolicy {
  /** Review and research roles: the read-only tools are pre-approved. */
  readOnlyTools: boolean;
  /** Roles that change files: their task sessions run in the task's own git worktree (when the task names a repo). */
  worktree: boolean;
}

/** Union of the actual duties, including custom roles and project overrides. */
export function sessionPolicyFor(role: RoleId, config: Pick<ProjectConfig, 'team'>): RoleSessionPolicy {
  const duties = roleBundle(config, role).duties;
  return {
    readOnlyTools: duties.some((id) => DUTIES[id].toolPolicy === 'read_only'),
    worktree: duties.some((id) => DUTIES[id].toolPolicy === 'task_worktree'),
  };
}
export function allowedToolsFor(role: RoleId, config: Pick<ProjectConfig, 'team'>): string[] {
  const policy = sessionPolicyFor(role, config);
  return [
    ...TEAM_TOOLS_ALLOWED,
    ...(policy.readOnlyTools ? READ_ONLY_REVIEW_TOOLS : []),
    ...(policy.worktree ? DEVELOPMENT_TOOLS : []),
  ];
}
export function usesWorktree(role: RoleId, config: Pick<ProjectConfig, 'team'>): boolean {
  return sessionPolicyFor(role, config).worktree;
}

/** Delay before a done task's sessions are stopped, so an in-flight tool result still reaches the agent. */
export const DONE_TASK_CLEANUP_DELAY_MS = 2_000;
