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
  reason: z.enum(['ai_limit_reached', 'plan_usage_paused', 'ai_disabled', 'member_at_capacity']),
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
  /** Repo name from the project config the work happens in; null = the workspace root. */
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
