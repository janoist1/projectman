import { z } from 'zod';
import { TaskKey } from './task';
import { MemberHandle } from './member';
import type { InboxItem } from './inbox';
import type { TeamMessage } from './message';

export const PatternFacts = z.strictObject({
  kind: z.enum(['conflict_file', 'failed_test_file', 'fix_rounds']),
  fingerprint: z.string().min(1).max(300),
  taskKeys: z.array(TaskKey).min(2).max(20),
  eventIds: z.array(z.string()).max(40),
  windowStartedAt: z.string().datetime(),
  windowEndedAt: z.string().datetime(),
});
export type PatternFacts = z.infer<typeof PatternFacts>;

export const OperatorStructuralReview = z.strictObject({
  signalId: z.string(),
  evidence: PatternFacts.nullable(),
  milestoneKey: TaskKey.nullable(),
  note: z.string().min(1).max(2000),
  member: MemberHandle.nullable(),
});
export type OperatorStructuralReview = z.infer<typeof OperatorStructuralReview>;

export function structuralReviewOf(item: Pick<InboxItem, 'kind' | 'payload'>) {
  if (item.kind !== 'question') return null;
  const parsed = OperatorStructuralReview.safeParse(item.payload.operatorStructuralReview);
  return parsed.success ? parsed.data : null;
}

/** Only the server's delivered answer to this exact approved proposal can continue a PM request. */
export function structuralReviewContinuation(
  item: InboxItem,
  message: TeamMessage,
  pm: string,
  owner: boolean,
) {
  const payload = structuralReviewOf(item);
  return payload &&
    owner &&
    !message.via &&
    !item.resolution?.via &&
    item.state === 'resolved' &&
    item.resolution?.optionId === 'approve' &&
    item.resolution.by === message.from &&
    item.source === pm &&
    item.projectKey === message.projectKey &&
    message.origin?.kind === 'answer' &&
    message.origin.inboxItemId === item.id &&
    message.answer?.inboxItemId === item.id &&
    message.to.includes(pm) &&
    !message.taskKey &&
    !message.operatorRequest
    ? payload
    : null;
}

export const StructuralReviewResult = z.strictObject({
  status: z.enum(['awaiting_approval', 'started', 'waiting', 'held', 'failed']),
  member: MemberHandle.nullable(),
  message_id: z.string().nullable(),
  inbox_item_id: z.string().nullable(),
});
export type StructuralReviewResult = z.infer<typeof StructuralReviewResult>;
