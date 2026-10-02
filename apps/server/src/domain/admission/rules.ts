import { isOnLeave, openPrerequisites, repoRequired } from '@projectman/shared';
import type {
  AgentProvider,
  ErrorCode,
  MemberConfig,
  ProjectConfig,
  Task,
  TaskStartWaiting,
} from '@projectman/shared';
import { conflict, DomainError } from '../errors';

/** The project's AI master switch: while it is off, no AI session starts or resumes. */
export function assertAiEnabled(config: ProjectConfig): void {
  if (!config.team.limits.aiEnabled) throw conflict('ai_disabled', 'AI work is switched off in this project');
}

/**
 * A member on leave gets no session (decision 23). Whatever started it waits (`DEFERRABLE`): the
 * messages for the member stay, and the starts retry once the member is called back.
 */
export function assertNotOnLeave(member: MemberConfig | undefined): void {
  if (member && isOnLeave(member))
    throw conflict('member_on_leave', `${member.handle} is on leave`, { member: member.handle });
}

/**
 * A session of a role that changes files works in a worktree of the task's repository. When the
 * project has several repositories and the task names none, nobody has chosen which one, and the
 * session would end up in the workspace root, where it could edit a checkout somebody uses: the
 * start is refused (`repo_required`) until a person chooses the repository. Roles that only read
 * may run in the workspace root. Only a person's choice clears this refusal, so it is not one of
 * the refusals a retry waits for (`DEFERRABLE`).
 */
export function assertRepoChosen(config: ProjectConfig, role: string, task: Task | null): void {
  if (!task || !repoRequired(config, role, task)) return;
  const names = config.project.repos.map((repo) => repo.name).join(', ');
  throw conflict(
    'repo_required',
    `task ${task.key} has no repository and the project has several (${names}): ` +
      `choose one before a ${role} session starts on it`,
    { taskKey: task.key },
  );
}

/**
 * A card whose prerequisite (PM-192) is not closed does not start by itself (`prerequisite_open`,
 * with the open keys in the details): the automatic work start waits for the last one to close
 * (`AutomaticStart.defers`), and a person's start is refused until they start despite the warning.
 */
export function assertPrerequisitesClosed(task: Task, tasks: readonly Task[]): void {
  const open = openPrerequisites(task, tasks).map((card) => card.key);
  if (open.length > 0)
    throw conflict('prerequisite_open', `task ${task.key} waits for ${open.join(', ')}`, {
      prerequisites: open,
    });
}

/** Why a start waits, as a task shows it. */
export type WaitingReason = TaskStartWaiting['reason'];

/**
 * The reasons every automatic start waits for that a later retry can overcome. Every reason the
 * board shows but `repo_required`: only a person's choice clears that one, so the start fails
 * instead of waiting (the task shows why, see `TaskStore`). `no_free_member` and
 * `prerequisite_open` are ones only for the start that picks its developer itself and moves a
 * card into work (`AutomaticStart.defers`). `label_missing` is no refusal at all: the start of a
 * person's Start button that waits for a label (PM-236) is kept with it directly.
 */
type DeferrableReason = Exclude<
  WaitingReason,
  'repo_required' | 'no_free_member' | 'prerequisite_open' | 'label_missing'
>;

/** Admission refusals that a later retry can overcome; an automatic start waits for them. */
const DEFERRABLE = new Set<ErrorCode>([
  'ai_limit_reached',
  'plan_usage_paused',
  'disk_low',
  'ai_disabled',
  'member_at_capacity',
  'member_on_leave',
  // The member's workspace (PM-138): held by another task's session, holding unfinished work, or
  // its default branch could not be fetched fresh. The task shows which.
  'workspace_busy',
  'workspace_dirty',
  'workspace_fetch_failed',
] satisfies DeferrableReason[]);

/** `also`: the further refusals the start in question waits for. */
export function isDeferrable(
  err: unknown,
  also: readonly WaitingReason[] = [],
): err is DomainError & { code: WaitingReason } {
  return err instanceof DomainError && (DEFERRABLE.has(err.code) || (also as ErrorCode[]).includes(err.code));
}

/**
 * Why a refused automatic start waits, as its task shows it: the refusal, the member it waits
 * for, and since when (kept from the previous refusal of the same start).
 */
export function waitingOf(
  err: DomainError & { code: WaitingReason },
  opts: { member?: string; previous?: TaskStartWaiting; at: string },
): TaskStartWaiting {
  const details = err.details as
    { provider?: AgentProvider; threshold?: number; prerequisites?: string[] } | undefined;
  return {
    reason: err.code,
    member: opts.member,
    ...(err.code === 'plan_usage_paused'
      ? { provider: details?.provider, threshold: details?.threshold }
      : {}),
    ...(err.code === 'prerequisite_open' ? { prerequisites: details?.prerequisites } : {}),
    since: opts.previous?.since ?? opts.at,
  };
}
