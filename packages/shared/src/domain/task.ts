import { z } from 'zod';
import { AgentProvider, MemberHandle } from './member';
import { StageId } from './pipeline';

/** Human-friendly task key: project key + sequence number, e.g. "AR-21". */
export const TaskKey = z.string().regex(/^[A-Z][A-Z0-9]{0,9}-\d+$/);
export type TaskKey = z.infer<typeof TaskKey>;

export const TaskStatus = z.enum(['active', 'waiting', 'blocked', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskLinkKind = z.enum(['pull_request', 'branch', 'issue', 'prerequisite', 'url']);
export type TaskLinkKind = z.infer<typeof TaskLinkKind>;

export const TaskLink = z.object({
  kind: TaskLinkKind,
  /** PR/issue number, branch name, task key or URL depending on kind. */
  ref: z.string(),
  /** "owner/name" for GitHub references. */
  repo: z.string().optional(),
  title: z.string().optional(),
  /** Attributed team member who authored this PR (not a GitHub login). */
  author: MemberHandle.optional(),
  /** Last known state, e.g. "open" | "merged" for pull requests. */
  state: z.string().optional(),
});
export type TaskLink = z.infer<typeof TaskLink>;

/** Internal tasks are hidden from client members; shared ones appear in the client view. */
export const Visibility = z.enum(['internal', 'shared']);
export type Visibility = z.infer<typeof Visibility>;

export const TaskStartWaiting = z.object({
  /**
   * The admission refusals a retry can overcome (the start waits for them), and `repo_required`:
   * the task's AI developer cannot start until a person chooses the task's repository, which no
   * retry does (see the deferrable refusals in the server's admission rules).
   */
  reason: z.enum([
    'ai_limit_reached',
    'plan_usage_paused',
    'ai_disabled',
    'member_at_capacity',
    'repo_required',
  ]),
  member: MemberHandle.optional(),
  provider: AgentProvider.optional(),
  /** Admission threshold, rather than current usage. */
  threshold: z.number().optional(),
  since: z.string(),
});
export type TaskStartWaiting = z.infer<typeof TaskStartWaiting>;

export const Task = z.object({
  /** One level of subtasks; omitted by older clients. */
  parentKey: TaskKey.nullable().optional(),
  startWaiting: TaskStartWaiting.optional(),
  id: z.string(),
  projectKey: z.string(),
  key: TaskKey,
  title: z.string().min(1),
  /** Markdown. */
  description: z.string(),
  stageId: StageId,
  status: TaskStatus,
  /** Developer member currently carrying the task (null until started). */
  assignee: MemberHandle.nullable(),
  /**
   * Name of the repository (from the project config) the task's work happens in. Null: the task
   * names none, and the work happens in the project's only repository when it has exactly one,
   * else in no repository (`effectiveRepo`): in the workspace root when the project has none, and
   * not before a person chooses one when it has several.
   */
  repo: z.string().nullable(),
  priority: z.number().int().nullable(),
  /** Label ids: defined in the pipeline's label vocabulary, or plain tags. */
  labels: z.array(z.string()),
  links: z.array(TaskLink),
  visibility: Visibility,
  createdBy: MemberHandle,
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Task = z.infer<typeof Task>;

/** A task is open until it is done or cancelled. */
export function isOpenTask(task: Pick<Task, 'status'>): boolean {
  return task.status !== 'done' && task.status !== 'cancelled';
}

/** Sequence number of a task key ("AR-21" -> 21). */
export function taskSeq(key: string): number {
  return Number(key.slice(key.lastIndexOf('-') + 1));
}

/** Why a task may not become a subtask of a parent: codes of the shared error list. */
export type SubtaskParentRefusal =
  | 'subtask_self_parent'
  | 'subtask_parent_not_found'
  | 'subtask_parent_project'
  | 'subtask_parent_is_subtask'
  | 'subtask_has_children';

/**
 * Why a task may not become a subtask of `parentKey`, or null when it may. Subtasks go one
 * level deep: the parent is another task of the same project and not a subtask itself, and a
 * task with subtasks of its own cannot become one. `parent` is the task stored under
 * `parentKey` (none when it does not exist); the child's `key` is null while it is created.
 */
export function subtaskParentRefusal(
  parentKey: string,
  parent: Pick<Task, 'projectKey' | 'parentKey'> | null | undefined,
  child: { key: string | null; projectKey: string; hasSubtasks: boolean },
): SubtaskParentRefusal | null {
  if (parentKey === child.key) return 'subtask_self_parent';
  if (!parent) return 'subtask_parent_not_found';
  if (parent.projectKey !== child.projectKey) return 'subtask_parent_project';
  if (parent.parentKey) return 'subtask_parent_is_subtask';
  if (child.hasSubtasks) return 'subtask_has_children';
  return null;
}
