import { z } from 'zod';
import { MemberHandle } from './member';
import { TaskKey } from './task';

/** Who did something. Every step is attributed to a human, an AI member or the system. */
export const Actor = z.object({
  kind: z.enum(['human', 'ai', 'system']),
  handle: MemberHandle.nullable(),
});
export type Actor = z.infer<typeof Actor>;

export const TimelineEventType = z.enum([
  'task_created',
  'task_updated',
  'task_stage_changed',
  'task_assigned',
  'task_check_changed',
  'task_link_added',
  'task_note',
  'schedule_started',
  'schedule_skipped',
  'session_started',
  'session_ended',
  'team_message',
  'permission_requested',
  'permission_resolved',
  'question_asked',
  'question_answered',
  'member_hired',
  'member_retired',
  'config_changed',
]);
export type TimelineEventType = z.infer<typeof TimelineEventType>;

/**
 * Append-only audit trail. `data` is structured; the UI renders the text via i18n.
 * Free text written by agents or humans (notes, messages) is data in the project's language.
 */
export const TimelineEvent = z.object({
  id: z.string(),
  projectKey: z.string(),
  taskKey: TaskKey.nullable(),
  sessionId: z.string().nullable(),
  actor: Actor,
  type: TimelineEventType,
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

/** Known payload shapes per event type (documentation for producers and renderers). */
export interface TimelineEventData {
  task_created: { title: string };
  task_updated: {
    fields: string[];
    action?: 'cancelled' | 'reopened';
    previousStatus?: string;
    previousAssignee?: string | null;
    reason?: string;
  };
  task_stage_changed: { from: string; to: string };
  task_assigned: { assignee: string | null; previous?: string | null };
  task_check_changed: { check: string; from: string | null; to: string };
  task_link_added: { kind: string; ref: string; repo?: string };
  task_note: { text: string };
  schedule_started: { runId: string; member: string; scheduledFor: string };
  schedule_skipped: { runId: string; member: string; scheduledFor: string; reason: string };
  session_started: { member: string; resumed: boolean };
  session_ended: { member: string; exitCode: number | null };
  team_message: { messageId: string; from: string; to: string[]; excerpt: string };
  permission_requested: { inboxItemId: string; toolName: string; summary: string };
  permission_resolved: { inboxItemId: string; decision: 'allow' | 'deny' };
  question_asked: { inboxItemId: string; question: string };
  question_answered: { inboxItemId: string; answer: string };
  member_hired: { handle: string; role: string };
  member_retired: { handle: string; handoverTo: string | null };
  config_changed: { version: string; message: string };
}
