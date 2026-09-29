import { z } from 'zod';
import { MemberHandle } from './member';
import { TaskKey } from './task';

export const MessageReceipt = z.object({
  handle: MemberHandle,
  kind: z.enum(['human', 'ai']),
  deliveredAt: z.string().nullable(),
  readAt: z.string().nullable(),
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
