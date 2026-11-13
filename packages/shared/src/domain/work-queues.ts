import { z } from 'zod';
import { IntegratorChannel } from '../api/dto';
import { canSeeInboxItem } from './inbox';
import type { InboxItem } from './inbox';
import { LabelId } from './label';
import { MemberHandle } from './member';
import {
  MEMBER_QUEUE_HOLD_CODES,
  MemberQueueCloseReason,
  MemberQueueItemKind,
  MemberQueueSource,
  MemberQueueState,
  OperatorQueueOutcome,
} from './member-queue';
import type { MemberQueueHoldCode } from './member-queue';
import { canSeeAllTeamMessages, canSeeOperatorSessions, canSeeTeamMessage } from './message';
import type { TeamMessage } from './message';
import { WorkItemRef } from './session';
import { TaskKey } from './task';
import type { TaskStartWaiting, TaskViewer } from './task';

/**
 * The work queues (PM-1294): one read contract for what waits for the AI members (their member queues) and for
 * the connected Claude (the open items addressed to the integrator). The server filters each item by its source's
 * own read rule and counts only afterwards; a hidden item leaves no trace, not even in a number.
 */

/** From when a queued item counts as waiting for long (the UI mark); `MEMBER_QUEUE_STUCK_MS` means something else. */
export const WORK_QUEUE_LONG_WAIT_MS = 30 * 60_000;
/** Open items one group lists in the overview. */
export const WORK_QUEUE_OPEN_PREVIEW = 100;
/** Open items one queue's detailed read lists. */
export const WORK_QUEUE_OPEN_LIMIT = 500;

export const WorkQueueRef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('member'), member: MemberHandle }),
  z.object({ type: z.literal('integrator') }),
]);
export type WorkQueueRef = z.infer<typeof WorkQueueRef>;

const WORK_QUEUE_REASONS = [
  'place',
  'usage',
  'paused',
  'human',
  'machine',
  'next_session',
  'unknown',
] as const;
export const WorkQueueReason = z.enum(WORK_QUEUE_REASONS);
export type WorkQueueReason = z.infer<typeof WorkQueueReason>;

/** What the wait shows of its stored details: the known keys only, each parsed; nothing else leaves the server. */
export const WorkQueueWaitFacts = z.object({
  member: MemberHandle.optional(),
  until: z.string().optional(),
  taskKeys: z.array(TaskKey).max(20).optional(),
  labels: z.array(LabelId).max(20).optional(),
});
export type WorkQueueWaitFacts = z.infer<typeof WorkQueueWaitFacts>;

export const WorkQueueItem = z.object({
  /** `mqi_…`; an integrator item has the inbox item's id. */
  id: z.string(),
  queue: WorkQueueRef,
  /** An integrator item: a fix limit decision is `fix_limit`, everything else `todo`. */
  kind: MemberQueueItemKind,
  /** An integrator item: `{ type: 'inbox', inboxItemId }`. */
  source: MemberQueueSource,
  /** An integrator item: its card, else the general desk. */
  place: WorkItemRef,
  title: z.string().max(200),
  /** An integrator item: the inbox item's source. */
  from: MemberHandle.nullable(),
  taskKey: TaskKey.nullable(),
  state: MemberQueueState,
  /** An integrator item: `integratorOpenedAt`, else the inbox item's creation. */
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  /** Only a `queued` item has one. */
  reason: WorkQueueReason.nullable(),
  /** The fine code behind the reason: an admission refusal or a hold. */
  reasonCode: z.string().max(64).nullable(),
  /** When the wait was last seen so (`wait.at`): it is new when the reason changes, `queuedAt` never is. */
  reasonSince: z.string().nullable(),
  waitFacts: WorkQueueWaitFacts.nullable(),
  attempts: z.number().int(),
  restartedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  closeReason: MemberQueueCloseReason.nullable(),
  /** An integrator item has none. */
  outcome: OperatorQueueOutcome.nullable(),
});
export type WorkQueueItem = z.infer<typeof WorkQueueItem>;

export const WorkQueueConnection = z.object({
  owner: MemberHandle,
  /** The key's row id; never the token and never its prefix. */
  connectionId: z.string(),
  /** After it the client counts the connection inactive without an event. */
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  lastUsedChannel: IntegratorChannel.nullable(),
});
export type WorkQueueConnection = z.infer<typeof WorkQueueConnection>;

export const WorkQueueGroup = z.object({
  queue: WorkQueueRef,
  /** `processing` first, then `queued`, the oldest first; may be cut. */
  items: z.array(WorkQueueItem),
  /** Exact, from what the viewer may see; null when the group is restricted. */
  queued: z.number().int().nullable(),
  processing: z.number().int().nullable(),
  everQueued: z.boolean(),
  /** Only the integrator group has it; `[]`: no connected Claude. */
  connections: z.array(WorkQueueConnection).optional(),
  /** The queue shows, its items do not (the integrator queue to an admin). */
  restricted: z.boolean(),
});
export type WorkQueueGroup = z.infer<typeof WorkQueueGroup>;

export const WorkQueuesView = z.object({
  scope: z.enum(['all', 'project_manager']),
  /** Every AI member in the configured order (the empty ones too), then the integrator. */
  groups: z.array(WorkQueueGroup),
  readAt: z.string(),
});
export type WorkQueuesView = z.infer<typeof WorkQueuesView>;

export const WorkQueueDetail = WorkQueueGroup.extend({
  /** Closed since `closedSince`, the newest first, at most `MEMBER_QUEUE_CLOSED_LIMIT`. */
  closed: z.array(WorkQueueItem),
});
export type WorkQueueDetail = z.infer<typeof WorkQueueDetail>;

/** How many of the viewer's queues are readable: all of them, only the project manager's, or none. */
export type WorkQueueScope = 'all' | 'project_manager';

/** A viewer as the project's access describes them (`via`: an integrator credential). */
export type WorkQueueViewer = TaskViewer & { via?: 'integrator' };

// --- The reasons -----------------------------------------------------------------------------------------

/** Typed by the start refusals, so a new one cannot be added without a class. */
const START_REASONS: Record<TaskStartWaiting['reason'], WorkQueueReason> = {
  ai_limit_reached: 'place',
  member_at_capacity: 'place',
  no_free_member: 'place',
  senior_busy: 'place',
  workspace_busy: 'place',
  plan_usage_paused: 'usage',
  provider_rate_limited: 'usage',
  team_paused: 'paused',
  ai_disabled: 'paused',
  member_on_leave: 'paused',
  waiting_answer: 'human',
  repo_required: 'human',
  provider_not_logged_in: 'human',
  nanogpt_key_missing: 'human',
  nanogpt_setup_incomplete: 'human',
  codex_setup_incomplete: 'human',
  workspace_codex_config: 'human',
  disk_low: 'machine',
  machine_busy: 'machine',
  workspace_dirty: 'machine',
  workspace_fetch_failed: 'machine',
  workspace_dependencies_pending: 'machine',
  workspace_dependencies_failed: 'machine',
  prerequisite_open: 'machine',
  label_missing: 'machine',
  full_test_pending: 'machine',
  handoff_open: 'machine',
  engine_offline: 'machine',
  start_backoff: 'machine',
  start_failing: 'human',
};

const HOLD_REASONS: Record<MemberQueueHoldCode, WorkQueueReason> = {
  [MEMBER_QUEUE_HOLD_CODES.waiting_answer]: 'human',
  [MEMBER_QUEUE_HOLD_CODES.fix_limit]: 'human',
  [MEMBER_QUEUE_HOLD_CODES.handoff]: 'machine',
  [MEMBER_QUEUE_HOLD_CODES.refinement_turn]: 'machine',
  [MEMBER_QUEUE_HOLD_CODES.full_test]: 'machine',
  [MEMBER_QUEUE_HOLD_CODES.engine]: 'machine',
  [MEMBER_QUEUE_HOLD_CODES.fix_limit_reassigned]: 'machine',
  [MEMBER_QUEUE_HOLD_CODES.signal_interval]: 'machine',
  [MEMBER_QUEUE_HOLD_CODES.signal_unready]: 'machine',
  [MEMBER_QUEUE_HOLD_CODES.unknown]: 'unknown',
};

/**
 * What a queued item waits for. A known code decides; without one the item waits for its place's next session
 * (a session runs there, or the item does not wake anyone), else the cause is not known; an unknown code is
 * `unknown` too.
 */
export function workQueueReasonOf(input: {
  code: string | null;
  wake: boolean;
  placeLive: boolean;
}): WorkQueueReason {
  const { code } = input;
  if (code === null) return input.placeLive || !input.wake ? 'next_session' : 'unknown';
  if (Object.hasOwn(START_REASONS, code)) return START_REASONS[code as TaskStartWaiting['reason']];
  if (Object.hasOwn(HOLD_REASONS, code)) return HOLD_REASONS[code as MemberQueueHoldCode];
  return 'unknown';
}

/** A queued item that has waited for `WORK_QUEUE_LONG_WAIT_MS` or more; one being processed never counts. */
export function isWorkQueueLongWait(item: Pick<WorkQueueItem, 'state' | 'queuedAt'>, nowMs: number): boolean {
  return item.state === 'queued' && nowMs - Date.parse(item.queuedAt) >= WORK_QUEUE_LONG_WAIT_MS;
}

// --- Who sees what ---------------------------------------------------------------------------------------

/** The owner and the admin read every queue, a developer the project manager's, everyone else none. */
export function workQueueScopeOf(viewer: Pick<TaskViewer, 'access'>): WorkQueueScope | null {
  if (viewer.access === 'owner' || viewer.access === 'admin') return 'all';
  return viewer.access === 'developer' ? 'project_manager' : null;
}

/**
 * Whether the queue is readable at all. A project manager's queue needs `isProjectManager`: without it only the
 * `all` scope gets a member's queue. The integrator queue is the `all` scope's.
 */
export function canSeeWorkQueue(
  viewer: Pick<TaskViewer, 'access'>,
  queue: WorkQueueRef,
  isProjectManager?: (handle: string) => boolean,
): boolean {
  const scope = workQueueScopeOf(viewer);
  if (scope === 'all') return true;
  return scope === 'project_manager' && queue.type === 'member' && !!isProjectManager?.(queue.member);
}

/** The integrator queue's items are the owner's alone (`canSeeInboxItem`); a member queue's are decided one by one. */
export function canSeeWorkQueueItems(viewer: Pick<TaskViewer, 'access'>, queue: WorkQueueRef): boolean {
  return queue.type === 'member' || viewer.access === 'owner';
}

/** What the source of an item says about who may read it; a source that is missing is `null`. */
export interface WorkQueueSourceFacts {
  message?: Pick<TeamMessage, 'from' | 'to'> | null;
  inbox?: Pick<InboxItem, 'state' | 'assignees' | 'payload'> | null;
}

/** Whether the item's source needs its record to decide (`canSeeWorkQueueItem`). */
export function workQueueSourceNeedsFacts(source: MemberQueueSource): boolean {
  return source.type === 'message' || source.type === 'inbox';
}

/**
 * Whether the viewer may read the item: its source's own rule decides. A team message is its parties' (and the
 * owner's and admin's), an inbox item follows `canSeeInboxItem` (a screening item and a private proposal are
 * hidden), a signal or checklist notice is for those who see the Operator's sessions, a card-level fact (a held
 * fix limit, a start, an obligation) shows. A source that can no longer be read (a deleted message) is seen
 * only by those who see every message.
 */
export function canSeeWorkQueueItem(
  viewer: WorkQueueViewer,
  item: { source: MemberQueueSource },
  facts: WorkQueueSourceFacts,
): boolean {
  switch (item.source.type) {
    case 'message':
      return facts.message ? canSeeTeamMessage(viewer, facts.message) : canSeeAllTeamMessages(viewer);
    case 'inbox':
      return facts.inbox ? canSeeInboxItem(viewer, facts.inbox) : canSeeAllTeamMessages(viewer);
    case 'signal':
    case 'checklist':
      return canSeeOperatorSessions(viewer);
    case 'fix_limit':
    case 'start':
    case 'obligation':
      return true;
  }
}
