import { z } from 'zod';
import { MemberHandle } from './member';
import type { GateCondition } from './pipeline';
import { TaskKey } from './task';

/** Who did something. Every step is attributed to a human, an AI member or the system. */
export const Actor = z.object({
  kind: z.enum(['human', 'ai', 'system']),
  handle: MemberHandle.nullable(),
});
export type Actor = z.infer<typeof Actor>;

export const TimelineEventType = z.enum([
  'task_subtask_added',
  'task_subtask_removed',
  'task_created',
  'task_updated',
  'task_stage_changed',
  'task_assigned',
  'task_check_changed',
  'task_labels_changed',
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
  task_subtask_added: { parentKey: string; subtaskKey: string };
  task_subtask_removed: { parentKey: string; subtaskKey: string };
  task_created: { title: string };
  task_updated: {
    fields: string[];
    action?: 'cancelled' | 'reopened';
    previousStatus?: string;
    previousAssignee?: string | null;
    reason?: string;
    /** A stage move waiting for human approval. */
    gateRequest?: { requestId: string; from: string; to: string; inboxItemIds: string[] };
    gateRejected?: { requestId: string; to: string; inboxItemId: string };
    /** Revalidation after approval can fail if the task or pipeline changed. */
    gateBlocked?: {
      to: string;
      reason?: 'unknown_stage';
      unmet?: Array<{ stageId: string; condition: GateCondition }>;
      approvalsStillValid?: boolean;
    };
  };
  task_stage_changed: { from: string; to: string; approvedBy?: string[]; inboxItemIds?: string[] };
  task_assigned: { assignee: string | null; previous?: string | null };
  /** Legacy: checks were replaced by labels; old events keep this shape. */
  task_check_changed: { check: string; from: string | null; to: string };
  /** `reason` names an automatic change: a group swap, the task moving back, a PR update, an approval. */
  task_labels_changed: {
    added: string[];
    removed: string[];
    reason?: 'group' | 'moved_back' | 'pr_updated' | 'pr_merged' | 'approval';
  };
  task_link_added: { kind: string; ref: string; repo?: string };
  task_note: { text: string; mentions?: string[]; importedAuthor?: string; importedAt?: string };
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
