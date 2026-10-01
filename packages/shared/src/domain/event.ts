import { z } from 'zod';
import type { LabelChangeReason } from './label';
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
  'attachment_added',
  'attachment_deleted',
  'schedule_started',
  'schedule_skipped',
  'session_started',
  'session_ended',
  'team_message',
  'permission_requested',
  'boundary_changed',
  'permission_resolved',
  'permission_refused',
  'permission_escalated',
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
  boundary_changed: {
    requestId: string;
    operation: string;
    resource: string;
    category: string;
    state: string;
    reason: string | null;
    assignees: string[];
    policyVersion: string;
  };
  task_subtask_added: { parentKey: string; subtaskKey: string };
  task_subtask_removed: { parentKey: string; subtaskKey: string };
  /** `imported`: created from another tracker (the request carried `importedAt`). */
  task_created: { title: string; imported?: boolean };
  task_updated: {
    fields: string[];
    action?: 'cancelled' | 'reopened';
    previousStatus?: string;
    previousAssignee?: string | null;
    /** `fields` names `repo`: the repository it was set to (null: cleared) and the one it had. */
    repo?: string | null;
    previousRepo?: string | null;
    reason?: string;
    /** A linked pull request changed (GitHub sync). */
    pullRequest?: { repo: string; number: number; state: string };
    /** A stage move waiting for human approval. */
    gateRequest?: { requestId: string; from: string; to: string; inboxItemIds: string[] };
    gateRejected?: { requestId: string; to: string; inboxItemId: string };
    /** Revalidation after approval can fail if the task or pipeline changed. */
    gateBlocked?: {
      to: string;
      /** `unknown_stage`, or the error code refusing the approval label named in `label`. */
      reason?: string;
      label?: string;
      unmet?: Array<{ stageId: string; condition: GateCondition }>;
      /** Approvals still missing: the human-only label and who may set it on this task. */
      approvals?: Array<{ stageId: string; label: string; approvers: string[] }>;
      /** Legacy: written before approvals became labels. */
      approvalsStillValid?: boolean;
    };
  };
  task_stage_changed: { from: string; to: string; approvedBy?: string[]; inboxItemIds?: string[] };
  /** `reason`: the assignee left the team, or handed the task over (`from` is the one who left). */
  task_assigned: {
    assignee: string | null;
    previous?: string | null;
    reason?: 'member_removed' | 'handover';
    from?: string;
  };
  /** Legacy: checks were replaced by labels; old events keep this shape. */
  task_check_changed: { check: string; from: string | null; to: string };
  /** `reason` names an automatic change: the task moving back, a PR update or merge, an approval. */
  task_labels_changed: { added: string[]; removed: string[]; reason?: LabelChangeReason };
  task_link_added: { kind: string; ref: string; repo?: string };
  task_note: { text: string; mentions?: string[]; importedAuthor?: string; importedAt?: string };
  /** The file name is the sanitised metadata; the audit keeps it after the attachment is deleted. */
  attachment_added: { attachmentId: string; fileName: string; size: number; mediaType: string };
  /** The actor is who deleted it; the uploader is in the matching `attachment_added`. */
  attachment_deleted: { attachmentId: string; fileName: string; size: number; mediaType: string };
  schedule_started: { runId: string; member: string; scheduledFor: string };
  schedule_skipped: { runId: string; member: string; scheduledFor: string; reason: string };
  session_started: { member: string; resumed: boolean };
  /** `reason`: why the session ended when known (e.g. a lost login). */
  session_ended: { member: string; exitCode: number | null; reason?: string };
  team_message: { messageId: string; from: string; to: string[]; excerpt: string };
  permission_requested: { inboxItemId: string; toolName: string; summary: string };
  /**
   * `delegated`: an AI decider answered (the actor), and `reason` is its explanation (PM-169).
   * Without it the actor is a person, or the system for a rule.
   */
  permission_resolved: {
    inboxItemId: string;
    decision: 'allow' | 'deny';
    optionId?: string;
    delegated?: true;
    reason?: string;
  };
  /**
   * A request that never became an inbox item (PM-165): the member's approver is nobody
   * (`by: 'approver_none'`) or the agent's own auto mode refused it (`by: 'classifier'`). `reason`
   * is the agent's raw (English) explanation, shown behind "Részletek".
   */
  permission_refused: {
    toolName: string;
    summary: string;
    by: 'approver_none' | 'classifier';
    reason?: string;
  };
  /**
   * An AI decider passed a request to a person (PM-169): it chose to (`cause: 'lead'`, with its
   * `reason`) or it did not answer in time (`cause: 'timeout'`, by the system).
   */
  permission_escalated: {
    inboxItemId: string;
    cause: 'lead' | 'timeout';
    assignees: string[];
    reason?: string;
  };
  question_asked: { inboxItemId: string; question: string };
  question_answered: { inboxItemId: string; answer: string };
  member_hired: { handle: string; role: string; temp: boolean; sponsor: string };
  member_retired: { handle: string; handoverTo: string | null };
  config_changed: { version: string; message: string };
}
