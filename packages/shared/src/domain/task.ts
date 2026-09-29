import { z } from 'zod';
import { MemberHandle } from './member';
import { CheckState, StageId } from './pipeline';

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
  /** Last known state, e.g. "open" | "merged" for pull requests. */
  state: z.string().optional(),
});
export type TaskLink = z.infer<typeof TaskLink>;

export const TaskChecks = z.object({
  code_review: CheckState.optional(),
  security_review: CheckState.optional(),
  qa: CheckState.optional(),
  client_test: CheckState.optional(),
});
export type TaskChecks = z.infer<typeof TaskChecks>;

/** Internal tasks are hidden from client members; shared ones appear in the client view. */
export const Visibility = z.enum(['internal', 'shared']);
export type Visibility = z.infer<typeof Visibility>;

export const Task = z.object({
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
  labels: z.array(z.string()),
  checks: TaskChecks,
  links: z.array(TaskLink),
  visibility: Visibility,
  createdBy: MemberHandle,
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
});
export type Task = z.infer<typeof Task>;
