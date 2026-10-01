import { DUTIES } from '../domain/duty';
import type { PermissionMode } from '../domain/member';
import { roleBundle, roleUsesWorktree } from './duties';
import type { ProjectConfig } from './schema';

export type SessionAccess = 'task_worktree' | 'review_copy' | 'read_only';
export interface ShellToolRule {
  command: string;
  arguments: 'exact' | 'prefix';
}

const prefix = (command: string): ShellToolRule => ({ command, arguments: 'prefix' });
const exact = (command: string): ShellToolRule => ({ command, arguments: 'exact' });

/** Semantic tool grants; provider syntax belongs to the provider adapters. */
export const REVIEW_SHELL_TOOLS: readonly ShellToolRule[] = [
  ...[
    'git diff',
    'git log',
    'git show',
    'gh pr view',
    'gh pr diff',
    'git status',
    'git rev-parse',
    'git merge-base',
    'git branch --list',
    'npm test',
    'npm run test',
    'npm run typecheck',
    'npx vitest run',
    'npx tsc --noEmit',
    'npx prettier --check',
  ].map(prefix),
];
export const DEVELOPMENT_SHELL_TOOLS: readonly ShellToolRule[] = [
  ...[
    'git status',
    'git diff',
    'git log',
    'git show',
    'git add',
    'git commit',
    'git merge --ff-only',
    'git rev-parse',
  ].map(prefix),
  exact('git branch --show-current'),
  exact('npm install'),
  exact('npm ci'),
  ...[
    'npm test',
    'npm run test',
    'npm run typecheck',
    'npm run build',
    'npm run format',
    'npm run lint',
    'npx vitest',
    'npx tsc',
    'npx prettier',
  ].map(prefix),
];
export const LOCAL_PUBLISHING_OPERATIONS = ['git_push', 'pull_request_create', 'pull_request_merge'] as const;
export type DeniedSessionOperation = (typeof LOCAL_PUBLISHING_OPERATIONS)[number];

/** A custom/overridden role is resolved from its duties, never its display name. */
export function roleSessionAccess(config: Pick<ProjectConfig, 'team'>, role: string) {
  const duties = roleBundle(config, role).duties;
  const worktree = roleUsesWorktree(config, role);
  const readOnlyTools = duties.some((id) => DUTIES[id].toolPolicy === 'read_only');
  const reviewCopy = duties.some(
    (id) => id === 'code_review' || id === 'security_review' || id === 'testing_acceptance',
  );
  return { worktree, readOnlyTools, reviewCopy };
}

export function roleSessionTools(config: Pick<ProjectConfig, 'team'>, role: string) {
  const access = roleSessionAccess(config, role);
  return {
    team: { all: true, names: [] as string[] },
    files: access.readOnlyTools ? (['read', 'grep', 'glob'] as Array<'read' | 'grep' | 'glob'>) : [],
    shell: [
      ...(access.readOnlyTools ? REVIEW_SHELL_TOOLS : []),
      ...(access.worktree ? DEVELOPMENT_SHELL_TOOLS : []),
    ],
  };
}

/** One compatibility mapping for historical member permissionMode values. */
export function sessionPermissions(mode: string | undefined, access?: SessionAccess) {
  const known: PermissionMode =
    mode === 'acceptEdits' || mode === 'auto' || mode === 'plan' || mode === 'bypassPermissions'
      ? mode
      : 'default';
  // A member setting cannot grant edits to the original source of a reading role.
  const effective = access === 'read_only' && known !== 'plan' ? 'default' : known;
  return {
    claude: effective,
    sandbox:
      effective === 'acceptEdits' || effective === 'auto' || effective === 'bypassPermissions'
        ? ('workspace-write' as const)
        : ('read-only' as const),
    approval: effective === 'plan' ? ('never' as const) : ('on-request' as const),
  };
}
