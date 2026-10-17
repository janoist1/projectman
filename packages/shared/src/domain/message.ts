import { z } from 'zod';
import { Actor } from './event';
import { MessageOrigin } from './involvement';
import { MemberHandle } from './member';
import { MessageAttachmentRef } from './message-attachment';
import { StageId } from './pipeline';
import { WorkItemRef } from './session';
import { TaskKey } from './task';
import type { TaskViewer } from './task';

/** The sender of the messages projectman writes itself (a send-back, a relation notice). It is no member. */
export const SYSTEM_SENDER = 'system';

export const MessageReceipt = z.object({
  handle: MemberHandle,
  kind: z.enum(['human', 'ai']),
  deliveredAt: z.string().nullable(),
  readAt: z.string().nullable(),
  /**
   * Where an AI recipient gets the message when that is not its default place (`routeFor` of the
   * message's task): its general chat for a closed task's message, or its running session on a
   * family card (PM-182). Absent for the default, and for messages from before it existed.
   */
  route: WorkItemRef.optional(),
  /** The message was for the card's old assignee and was forwarded to the receiver of the handoff (PM-342). */
  handedOffTo: MemberHandle.optional(),
});
export type MessageReceipt = z.infer<typeof MessageReceipt>;

/** What an answer message answers (PM-249): the card thread shows it as a question and its answer. */
export const TeamMessageAnswer = z.object({
  /** The `ask_human` inbox item. */
  inboxItemId: z.string(),
  /** The question as asked (`payload.question`, else the item's title). */
  question: z.string(),
  /** `answerText(item)`. */
  answer: z.string(),
});
export type TeamMessageAnswer = z.infer<typeof TeamMessageAnswer>;

export const RelayedReply = z.object({
  /** The project manager's session the text was read from. */
  sessionId: z.string(),
  /** The person's message it answers. */
  inReplyTo: z.string(),
});
export type RelayedReply = z.infer<typeof RelayedReply>;

export const MessageKind = z.enum(['action', 'info']);
export type MessageKind = z.infer<typeof MessageKind>;
export const CardVersion = z.object({
  stageId: StageId,
  commit: z.string().nullable(),
  reviewCommit: z.string().nullable(),
});
export type CardVersion = z.infer<typeof CardVersion>;
export const MessageSubject = z.object({ type: z.literal('permission'), inboxItemId: z.string() });
export type MessageSubject = z.infer<typeof MessageSubject>;
export const StaleReason = z.enum([
  'card_closed',
  'stage_moved',
  'superseded',
  'sender_result',
  'result_recorded',
  'permission_closed',
]);
export type StaleReason = z.infer<typeof StaleReason>;

/** A message between team members (human or AI), optionally about a task. */
export const TeamMessage = z.object({
  via: z.literal('integrator').optional(),
  /**
   * The full origin of a message sent in the Operator's super mode (PM-757); absent on every other message.
   * `from` stays the Operator's handle and `via` stays `integrator`.
   */
  actor: Actor.optional(),
  origin: MessageOrigin.optional(),
  id: z.string(),
  projectKey: z.string(),
  from: MemberHandle,
  to: z.array(MemberHandle).min(1),
  taskKey: TaskKey.nullable(),
  /** The text; empty only for a message that carries files alone. */
  body: z.string(),
  /** Files the message carries (PM-515); absent: none. */
  attachments: z.array(MessageAttachmentRef).optional(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  kind: MessageKind.optional(),
  version: CardVersion.optional(),
  subject: MessageSubject.optional(),
  receipts: z.array(MessageReceipt).optional(),
  /** Set on the message that carries a person's answer to an AI member's question (PM-249); older answers have none. The asker is `to[0]`, the one who answered is `from`. */
  answer: TeamMessageAnswer.optional(),
  relayed: RelayedReply.optional(),
  /** Set on a message the Operator sent during an owner's request (PM-463): the request's id. */
  operatorRequest: z.string().optional(),
  operatorSignal: z.string().optional(),
});
export type TeamMessage = z.infer<typeof TeamMessage>;

/** Whether the viewer sees every team message of the project: an owner or an admin. */
export function canSeeAllTeamMessages(viewer: Pick<TaskViewer, 'access'>): boolean {
  return viewer.access === 'owner' || viewer.access === 'admin';
}

/**
 * Whether the viewer sees the Operator's sessions (their list, detail, terminal and live events, PM-475): the
 * same people who see every team message, so the owner and the admin keep sight of what the Operator tells
 * the project's other people.
 */
export function canSeeOperatorSessions(viewer: Pick<TaskViewer, 'access'>): boolean {
  return canSeeAllTeamMessages(viewer);
}

/** An owner and an admin see every team message; everyone else only what they sent or what was sent to them. */
export function canSeeTeamMessage(viewer: TaskViewer, message: Pick<TeamMessage, 'from' | 'to'>): boolean {
  return (
    canSeeAllTeamMessages(viewer) || message.from === viewer.handle || message.to.includes(viewer.handle)
  );
}

export type CardThreadRecipientBasis = 'workers' | 'assignee' | 'stage_owners' | 'project_manager' | 'none';

/**
 * Who a message written on a card's thread goes to by default (PM-249): the members working on the card,
 * else its assignee, else its stage's owners, else the project manager (PM-488), who passes it on; never
 * the writer, only members who may get messages.
 */
export function cardThreadRecipients(input: {
  /** Members of `cardWorkerSessions(...)`, in its order. */
  workers: readonly string[];
  assignee: string | null;
  /** The resolved owners of the card's stage (`BoardView.stages`). */
  stageOwners: readonly string[];
  /** The project manager (`projectManagerAmong`), the last fallback (PM-488); null: there is none. */
  projectManager: string | null;
  writer: string;
  /** An active member of the project (not retired) other than a client. */
  canReceive: (handle: string) => boolean;
}): { basis: CardThreadRecipientBasis; to: string[] } {
  const usable = (handles: readonly string[]) => [
    ...new Set(handles.filter((handle) => handle !== input.writer && input.canReceive(handle))),
  ];
  const workers = usable(input.workers);
  if (workers.length > 0) return { basis: 'workers', to: workers };
  const assignee = usable(input.assignee ? [input.assignee] : []);
  if (assignee.length > 0) return { basis: 'assignee', to: assignee };
  const owners = usable(input.stageOwners);
  if (owners.length > 0) return { basis: 'stage_owners', to: owners };
  const projectManager = usable(input.projectManager ? [input.projectManager] : []);
  if (projectManager.length > 0) return { basis: 'project_manager', to: projectManager };
  return { basis: 'none', to: [] };
}

/** Whether the message was sent to `handle` and `handle` has not read it yet. */
export function isUnreadBy(message: Pick<TeamMessage, 'to' | 'receipts'>, handle: string | null): boolean {
  return (
    !!handle && message.to.includes(handle) && !message.receipts?.find((r) => r.handle === handle)?.readAt
  );
}

/**
 * The conversations `handle` has the message in: the sender's, one with each recipient (not with
 * themselves); a recipient's, the one with the sender. Anyone else has it in none.
 */
export function threadPeersOf(message: Pick<TeamMessage, 'from' | 'to'>, handle: string): string[] {
  if (message.from === handle) return message.to.filter((to) => to !== handle);
  return message.to.includes(handle) ? [message.from] : [];
}

/** The default place of an AI recipient's message about a task: its session for the task, else its general chat. */
export function routeFor(taskKey: string | null): WorkItemRef {
  return taskKey ? { type: 'task', taskKey } : { type: 'general' };
}

/** Where `handle` gets (or got) the message: the route stored on its receipt, else the default. */
export function messageRoute(
  message: Pick<TeamMessage, 'taskKey' | 'receipts'>,
  handle: string,
): WorkItemRef {
  return message.receipts?.find((r) => r.handle === handle)?.route ?? routeFor(message.taskKey);
}

export function sameWorkItem(a: WorkItemRef, b: WorkItemRef): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'task':
      return a.taskKey === (b as typeof a).taskKey;
    case 'meeting':
      return a.meetingId === (b as typeof a).meetingId;
    case 'schedule':
      return a.runId === (b as typeof a).runId;
    case 'general':
      return a.with === (b as typeof a).with;
  }
}
