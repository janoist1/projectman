import { z } from 'zod';
import { MemberHandle } from './member';
import { WorkItemRef } from './session';
import { TaskKey } from './task';
import type { TaskViewer } from './task';

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
});
export type MessageReceipt = z.infer<typeof MessageReceipt>;

/** A message between team members (human or AI), optionally about a task. */
export const TeamMessage = z.object({
  id: z.string(),
  projectKey: z.string(),
  from: MemberHandle,
  to: z.array(MemberHandle).min(1),
  taskKey: TaskKey.nullable(),
  body: z.string().min(1),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  receipts: z.array(MessageReceipt).optional(),
});
export type TeamMessage = z.infer<typeof TeamMessage>;

/** Whether the viewer sees every team message of the project: an owner or an admin. */
export function canSeeAllTeamMessages(viewer: Pick<TaskViewer, 'access'>): boolean {
  return viewer.access === 'owner' || viewer.access === 'admin';
}

/** An owner and an admin see every team message; everyone else only what they sent or what was sent to them. */
export function canSeeTeamMessage(viewer: TaskViewer, message: Pick<TeamMessage, 'from' | 'to'>): boolean {
  return (
    canSeeAllTeamMessages(viewer) || message.from === viewer.handle || message.to.includes(viewer.handle)
  );
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
      return true;
  }
}
