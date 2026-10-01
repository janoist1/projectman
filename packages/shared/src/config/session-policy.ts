import { DUTIES } from '../domain/duty';
import type { PermissionMode } from '../domain/member';
import { roleBundle, roleUsesWorktree } from './duties';
import type { ProjectConfig } from './schema';

/**
 * Where a session works. `member_workspace` is the managed VM's placement (PM-141): the member's
 * own durable workspace (or its home, without a repository), whatever the member does in it.
 */
export type SessionAccess = 'task_worktree' | 'review_copy' | 'read_only' | 'member_workspace';
export type ReviewCopyMode = 'inherit' | 'read_only' | 'test';
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

export interface ReviewCopyIntent {
  mode?: ReviewCopyMode;
  enforcement?: 'legacy' | 'strict';
}

/**
 * Only a separate test opt-in with strict intent can grant writes to a review copy. Providers must
 * verify that intent before starting; legacy modes never opt in.
 */
function isReviewTest(access: SessionAccess | undefined, review: ReviewCopyIntent): boolean {
  return access === 'review_copy' && review.mode === 'test' && review.enforcement === 'strict';
}

/**
 * Whether a placement only reads (PM-167): a read-only placement, or a review copy without the
 * test opt-in. Its session writes nothing in its working directory or its extra directories, in
 * any permission mode; the CLI's sandbox and deny rules hold that, not a stricter mode.
 */
export function placementReadsOnly(
  access: SessionAccess | undefined,
  review: ReviewCopyIntent = {},
): boolean {
  return access === 'read_only' || (access === 'review_copy' && !isReviewTest(access, review));
}

/**
 * One compatibility mapping for historical member permissionMode values. The member's mode goes to
 * the CLI as it is (decision 28), in a reading placement too (PM-167): `auto` stays `auto` and
 * `plan` stays `plan`. A reading placement keeps Codex's sandbox `read-only`.
 */
export function sessionPermissions(
  mode: string | undefined,
  access?: SessionAccess,
  review: ReviewCopyIntent = {},
) {
  const known: PermissionMode =
    mode === 'acceptEdits' || mode === 'auto' || mode === 'plan' || mode === 'bypassPermissions'
      ? mode
      : 'default';
  const reviewTest = isReviewTest(access, review);
  const reading = placementReadsOnly(access, review);
  const effective: PermissionMode = known === 'plan' ? 'plan' : reviewTest ? 'acceptEdits' : known;
  return {
    claude: effective,
    sandbox:
      !reading && (effective === 'acceptEdits' || effective === 'auto' || effective === 'bypassPermissions')
        ? ('workspace-write' as const)
        : ('read-only' as const),
    approval: effective === 'plan' ? ('never' as const) : ('on-request' as const),
  };
}
