import { z } from 'zod';
import { memberOf } from '../config/lookup';
import { hasGuestConversations, managerConversationOf, sessionWorkItemOf } from '../config/project-manager';
import type { ProjectConfig } from '../config/schema';
import { MemberHandle } from './member';
import { WorkItemRef } from './session';
import { TaskKey } from './task';

/**
 * The member queue (PM-894): everything addressed to an AI member waits in its one durable queue, a
 * row per source and place. This slice stores, shows and keeps the rows true; waking the member
 * and processing the rows are the later slices'.
 */

export const MEMBER_QUEUE_ITEM_KINDS = [
  'message',
  'todo',
  'fix_limit',
  'permission',
  'screening',
  'signal',
  'start',
  'checklist',
] as const;
export const MemberQueueItemKind = z.enum(MEMBER_QUEUE_ITEM_KINDS);
export type MemberQueueItemKind = z.infer<typeof MemberQueueItemKind>;

export const MEMBER_QUEUE_STATES = ['queued', 'processing', 'done', 'handed_off', 'cancelled'] as const;
export const MemberQueueState = z.enum(MEMBER_QUEUE_STATES);
export type MemberQueueState = z.infer<typeof MemberQueueState>;

export const MEMBER_QUEUE_CLOSE_REASONS = [
  'delivered',
  'resolved',
  'finished',
  'handed_off',
  'started',
  'place_closed',
  'source_closed',
  'stale',
  'member_removed',
  'attempts_exhausted',
] as const;
export const MemberQueueCloseReason = z.enum(MEMBER_QUEUE_CLOSE_REASONS);
export type MemberQueueCloseReason = z.infer<typeof MemberQueueCloseReason>;

/** What the item is about: one source gives one item per member (the repository's unique key). */
export const MemberQueueSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), messageId: z.string() }),
  z.object({ type: z.literal('inbox'), inboxItemId: z.string() }),
  z.object({ type: z.literal('signal'), signalId: z.string(), followUpAt: z.string().nullable() }),
  z.object({ type: z.literal('fix_limit'), taskKey: TaskKey, heldAt: z.string() }),
  z.object({ type: z.literal('obligation'), obligationId: z.string() }),
  z.object({ type: z.literal('start'), startKey: z.string().max(300) }),
  z.object({ type: z.literal('checklist'), noticeId: z.string() }),
]);
export type MemberQueueSource = z.infer<typeof MemberQueueSource>;

/** The source's id within its type: fix_limit `${taskKey}@${heldAt}`, signal `${signalId}@${followUpAt ?? 'first'}`, else the id. */
export function memberQueueSourceId(source: MemberQueueSource): string {
  switch (source.type) {
    case 'message':
      return source.messageId;
    case 'inbox':
      return source.inboxItemId;
    case 'signal':
      return `${source.signalId}@${source.followUpAt ?? 'first'}`;
    case 'fix_limit':
      return `${source.taskKey}@${source.heldAt}`;
    case 'obligation':
      return source.obligationId;
    case 'start':
      return source.startKey;
    case 'checklist':
      return source.noticeId;
  }
}

/** The source of a stored row: its type and its id within the type (`memberQueueSourceId` the other way). */
export function memberQueueSourceOf(type: MemberQueueSource['type'], id: string): MemberQueueSource {
  const at = id.lastIndexOf('@');
  switch (type) {
    case 'message':
      return { type, messageId: id };
    case 'inbox':
      return { type, inboxItemId: id };
    case 'signal': {
      const followUpAt = at < 0 ? 'first' : id.slice(at + 1);
      return {
        type,
        signalId: at < 0 ? id : id.slice(0, at),
        followUpAt: followUpAt === 'first' ? null : followUpAt,
      };
    }
    case 'fix_limit':
      return { type, taskKey: at < 0 ? id : id.slice(0, at), heldAt: at < 0 ? '' : id.slice(at + 1) };
    case 'obligation':
      return { type, obligationId: id };
    case 'start':
      return { type, startKey: id };
    case 'checklist':
      return { type, noticeId: id };
  }
}

/** Why the Operator handed an item off: owner_reserved goes to the owner, every other reason to the super side. */
export const OPERATOR_HANDOFF_REASONS = [
  'owner_reserved',
  'no_typed_operation',
  'no_grant',
  'processing_failed',
] as const;
export const OperatorHandoffReason = z.enum(OPERATOR_HANDOFF_REASONS);
export type OperatorHandoffReason = z.infer<typeof OperatorHandoffReason>;

export const MemberQueueWait = z.object({ code: z.string().max(64), at: z.string() });
export type MemberQueueWait = z.infer<typeof MemberQueueWait>;

export const MEMBER_QUEUE_MAX_ATTEMPTS = 3;
export const MEMBER_QUEUE_STUCK_MS = 45 * 60_000;

/** How an item ended: what the member did with it. */
export const OperatorQueueOutcome = z.object({
  summary: z.string().max(2000),
  operationIds: z.array(z.string().max(100)).max(20),
  /** True when any of its operations ran on the supervisor (an administration command): the UI's "(super)" mark. */
  machine: z.boolean(),
  handoff: z
    .object({
      reason: OperatorHandoffReason,
      inboxItemId: z.string(),
      /** Missing on old rows: the owner. */
      to: z.enum(['owner', 'super']).optional(),
    })
    .nullable(),
});
export type OperatorQueueOutcome = z.infer<typeof OperatorQueueOutcome>;

export const MemberQueueItem = z.object({
  id: z.string(),
  projectKey: z.string(),
  member: MemberHandle,
  kind: MemberQueueItemKind,
  source: MemberQueueSource,
  /** Where the member works it: a card (needs its workspace) or its desk (`general`, no workspace). */
  place: WorkItemRef,
  /** Whether the item wakes the member; an item that does not waits for the place's next session. */
  wake: z.boolean(),
  state: MemberQueueState,
  /** The todo's or decision's title, the message's first line; cut. */
  title: z.string().max(200),
  /** Null: the system. */
  from: MemberHandle.nullable(),
  taskKey: TaskKey.nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  closeReason: MemberQueueCloseReason.nullable(),
  attempts: z.number().int(),
  restartedAt: z.string().nullable(),
  sessionId: z.string().nullable(),
  /** Why the item has not been started, while it waits. */
  wait: MemberQueueWait.nullable(),
  outcome: OperatorQueueOutcome.nullable(),
});
export type MemberQueueItem = z.infer<typeof MemberQueueItem>;

export const MemberQueueView = z.object({
  member: MemberHandle,
  /** Open items (queued, processing), the oldest first. */
  items: z.array(MemberQueueItem),
  /** Items closed since `closedSince` (default 24 hours), the newest first, at most `MEMBER_QUEUE_CLOSED_LIMIT`. */
  closed: z.array(MemberQueueItem),
  /** Whether the member ever had an item: the "first use" state of the screen. */
  everQueued: z.boolean(),
});
export type MemberQueueView = z.infer<typeof MemberQueueView>;

/** The query of a member's queue: how far back the closed items go. */
export const MemberQueueQuery = z.strictObject({ closedSince: z.iso.datetime({ offset: true }).optional() });
export type MemberQueueQuery = z.infer<typeof MemberQueueQuery>;

/** The closed items one view lists at most. */
export const MEMBER_QUEUE_CLOSED_LIMIT = 50;
/** How far back `closedSince` goes when a request names none. */
export const MEMBER_QUEUE_CLOSED_DEFAULT_MS = 24 * 60 * 60_000;

/**
 * How soon an item is looked at (PM-925), the smallest first: a member waits on a permission
 * decision, a held fix limit and a screening are the next, then todos, the starts, and the messages and signals last.
 */
export function memberQueueUrgency(kind: MemberQueueItemKind): number {
  switch (kind) {
    case 'permission':
      return 0;
    case 'fix_limit':
    case 'screening':
      return 1;
    case 'todo':
      return 2;
    case 'start':
    case 'checklist':
      return 3;
    case 'message':
    case 'signal':
      return 4;
  }
}

/**
 * Which start limits apply when an item wakes its member (PM-925): the member's capacity and the team's
 * concurrent AI limit. Decisions the team waits on must not stand behind a full team.
 */
export function memberQueueStartLimits(kind: MemberQueueItemKind): { capacity: boolean; aiLimit: boolean } {
  const free = kind === 'permission' || kind === 'fix_limit' || kind === 'screening';
  return { capacity: !free, aiLimit: !free };
}

/**
 * Integrator items stay on the integrator side while an owner has a live super key (PM-1045): that owner's
 * connected Claude works them. Without one they go to the owners. `hasActiveSuperKey` takes the owner's email.
 */
export function integratorSideAvailable(
  config: Pick<ProjectConfig, 'team'>,
  hasActiveSuperKey: (ownerEmail: string) => boolean,
): boolean {
  return config.team.members.some(
    (member) =>
      member.kind === 'human' &&
      member.access === 'owner' &&
      !!member.email &&
      hasActiveSuperKey(member.email),
  );
}

/**
 * The place a message is meant for, before running sessions count: the conversation with the sender for a
 * member who has guest conversations (`hasGuestConversations`), else the member's own work item
 * (`sessionWorkItemOf`). `Messaging.place` starts with it.
 */
export function nominalMessagePlace(
  config: Pick<ProjectConfig, 'team'>,
  handle: string,
  workItem: WorkItemRef,
  from?: string,
): WorkItemRef {
  const recipient = memberOf(config, handle);
  return from !== undefined &&
    hasGuestConversations(config, recipient) &&
    (workItem.type === 'task' || workItem.type === 'general')
    ? managerConversationOf(config, from)
    : sessionWorkItemOf(recipient, workItem);
}
