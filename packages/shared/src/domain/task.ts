import { z } from 'zod';
import { FullTestErrorReason, FullTestStatus } from './full-test';
import { LabelId } from './label';
import { AgentProvider, MemberHandle } from './member';
import type { HumanAccess } from './member';
import { StageId } from './pipeline';

/** Human-friendly task key: project key + sequence number, e.g. "AR-21". */
export const TaskKey = z.string().regex(/^[A-Z][A-Z0-9]{0,9}-\d+$/);
export type TaskKey = z.infer<typeof TaskKey>;

export const TaskStatus = z.enum(['active', 'waiting', 'blocked', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * `prerequisite`, `related` and `duplicate_of` relate two cards (PM-192): `ref` is the other card's
 * key, stored once on the card that set it (see `domain/relations.ts`).
 */
export const TaskLinkKind = z.enum([
  'pull_request',
  'branch',
  'issue',
  'prerequisite',
  'url',
  'related',
  'duplicate_of',
]);
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
    // Too little free disk space (PM-243): the start continues once there is room again.
    'disk_low',
    'ai_disabled',
    // The team is paused (PM-219): the start continues when it is resumed.
    'team_paused',
    'member_at_capacity',
    'member_on_leave',
    'repo_required',
    // The member's workspace for the repository (PM-138): another task's session holds it, it has
    // unfinished work, or the default branch could not be fetched fresh.
    'workspace_busy',
    'workspace_dirty',
    'workspace_fetch_failed',
    // A prerequisite of the card (PM-192) is not closed: the start continues when the last one is.
    'prerequisite_open',
    // A card moved into a work stage without an assignee (PM-119): no developer is free (or on
    // duty) and no temp worker may be hired; it starts once one is.
    'no_free_member',
    // The gate before the work stage asks for labels an AI member sets (PM-236): that member's session
    // started on the card, and the developer's start continues once the labels are on it.
    'label_missing',
    // The server's full test of the pinned commit (PM-217) has not ended: the reviewer's start
    // continues once it has.
    'full_test_pending',
  ]),
  /** `prerequisite_open`: the keys of the prerequisites still open. */
  prerequisites: z.array(TaskKey).optional(),
  /** `label_missing`: the labels the start waits for; `member` is the one who sets them. */
  labels: z.array(LabelId).optional(),
  member: MemberHandle.optional(),
  provider: AgentProvider.optional(),
  /** Admission threshold, rather than current usage. */
  threshold: z.number().optional(),
  since: z.string(),
});
export type TaskStartWaiting = z.infer<typeof TaskStartWaiting>;

/**
 * The commit of the developer's branch that was handed over when the task entered a review or test
 * stage (PM-183): reviewers and testers work on exactly this commit. Present only while the task is in
 * that stage.
 */
export const TaskReviewPin = z.object({
  commit: z.string(),
  branch: z.string(),
  pinnedAt: z.string(),
  /** The server's full test of this commit (PM-217); absent when there is none or it was cancelled. */
  fullTest: z
    .object({
      status: FullTestStatus.exclude(['cancelled']),
      /** `finishedAt`, else `startedAt`, else `createdAt`. */
      at: z.string(),
      reason: FullTestErrorReason.optional(),
    })
    .optional(),
});
export type TaskReviewPin = z.infer<typeof TaskReviewPin>;

/**
 * An open loop on a card (PM-261): AI members writing to each other without progress (`findLoop`).
 * Present only while it is open; the board shows it as a mark. `notified` is the member told (null when
 * nobody was), `phase` where it stands: `notified` the member was told, `owner` a person decides
 * (`ownerReason`: nobody holds the duty, or it went on after the member was told), `let_run` that person
 * let it run (`letRunBy`) and nothing more is said about this loop. `deciders` are the people it goes to.
 */
export const TaskLoop = z.object({
  id: z.string(),
  members: z.array(MemberHandle),
  count: z.number().int().nonnegative(),
  startedAt: z.string(),
  lastMessageAt: z.string(),
  notified: MemberHandle.nullable(),
  phase: z.enum(['notified', 'owner', 'let_run']),
  ownerReason: z.enum(['no_watcher', 'continued']).nullable(),
  deciders: z.array(MemberHandle),
  letRunBy: MemberHandle.nullable(),
});
export type TaskLoop = z.infer<typeof TaskLoop>;

/**
 * A card held back at the fix round limit (PM-262): its fix rounds reached the project's limit, so the next
 * round does not go to its implementer by itself. Present only while it is held; the board shows it. `phase`:
 * `lead` the lead developer `decider` decides, `replan` the planner `decider` is to make the plan more exact
 * and lets the card go, `owner` the people in `deciders` decide (`reason`: nobody could be asked, the lead
 * passed it on, or it reached the limit again after one more round). A client never sees it.
 */
export const TaskFixLimit = z.object({
  phase: z.enum(['lead', 'replan', 'owner']),
  rounds: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  changeRequests: z.number().int().nonnegative(),
  designChangeRequests: z.number().int().nonnegative(),
  sendBacks: z.number().int().nonnegative(),
  /** `lead` and `replan`: the AI member who decides. */
  decider: MemberHandle.nullable(),
  /** `owner`: the people who decide. */
  deciders: z.array(MemberHandle),
  reason: z.enum(['no_ai_decider', 'passed_on', 'again']).nullable(),
  heldAt: z.string(),
});
export type TaskFixLimit = z.infer<typeof TaskFixLimit>;

/**
 * What a card is (PM-192): a `task` goes through the pipeline; a `theme` groups cards (an epic): it has a
 * key, a title, a description and a timeline, but no stage to move through, no assignee, no work and no
 * session, and it is only open or closed.
 */
export const TaskKind = z.enum(['task', 'theme']);
export type TaskKind = z.infer<typeof TaskKind>;

export const Task = z.object({
  /** Absent: `task`. */
  kind: TaskKind.optional(),
  /**
   * The theme the card belongs to, as it is read: a subtask has its parent's theme (never its own, so
   * the parent changing theme writes nothing to its subtasks); other cards have the theme they were
   * given. Absent or null: none. A theme has none.
   */
  themeKey: TaskKey.nullable().optional(),
  /** One level of subtasks; omitted by older clients. */
  parentKey: TaskKey.nullable().optional(),
  startWaiting: TaskStartWaiting.optional(),
  reviewPin: TaskReviewPin.optional(),
  /** The loop open on the card (PM-261); absent when there is none. Hidden from clients. */
  loop: TaskLoop.optional(),
  /** The fix round limit that holds the card back (PM-262); absent when it is not held. Hidden from clients. */
  fixLimit: TaskFixLimit.optional(),
  /**
   * The attachment whose thumbnail is the card's cover (`coverAttachmentId` in `domain/attachment`):
   * the task's first image. Null or absent when the task has no image. A plain string here, as
   * `attachment.ts` imports this file.
   */
  coverAttachmentId: z.string().nullable().optional(),
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
  /**
   * The card's place in the manual order of its board column (PM-118): ascending, shared by everyone.
   * Independent of `priority`. Only the order of two cards means something, not the value (see
   * `domain/board-order`). Absent on a card read from a server or fixture from before it existed.
   */
  boardRank: z.number().int().optional(),
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

/** Whoever looks at a task: a project member's access level (`ai` for an AI member) and handle. */
export interface TaskViewer {
  access: HumanAccess | 'ai';
  handle: string;
}

/** Client members see only what is shared with them; every other member sees the whole project. */
export function canSeeTask(viewer: Pick<TaskViewer, 'access'>, task: Pick<Task, 'visibility'>): boolean {
  return viewer.access !== 'client' || task.visibility === 'shared';
}

/** A task is open until it is done or cancelled. */
export function isOpenTask(task: Pick<Task, 'status'>): boolean {
  return task.status !== 'done' && task.status !== 'cancelled';
}

/**
 * Whether the card is a theme. Every pipeline path (moving, starting, assigning, the repository,
 * subtasks, prerequisites, review watching, load, hand-over) leaves a theme out by this one predicate.
 */
export function isTheme(task: Pick<Task, 'kind'>): boolean {
  return task.kind === 'theme';
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
  | 'subtask_has_children'
  | 'subtask_theme';

/**
 * Why a task may not become a subtask of `parentKey`, or null when it may. Subtasks go one
 * level deep: the parent is another task of the same project and not a subtask itself, and a
 * task with subtasks of its own cannot become one. A theme is neither a parent nor a subtask.
 * `parent` is the task stored under `parentKey` (none when it does not exist); the child's `key`
 * is null while it is created.
 */
export function subtaskParentRefusal(
  parentKey: string,
  parent: Pick<Task, 'projectKey' | 'parentKey' | 'kind'> | null | undefined,
  child: { key: string | null; projectKey: string; hasSubtasks: boolean; kind?: TaskKind | undefined },
): SubtaskParentRefusal | null {
  if (parentKey === child.key) return 'subtask_self_parent';
  if (!parent) return 'subtask_parent_not_found';
  if (parent.projectKey !== child.projectKey) return 'subtask_parent_project';
  if (isTheme(parent) || child.kind === 'theme') return 'subtask_theme';
  if (parent.parentKey) return 'subtask_parent_is_subtask';
  if (child.hasSubtasks) return 'subtask_has_children';
  return null;
}
