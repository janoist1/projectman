import { z } from 'zod';
import type { LabelChangeReason } from './label';
import { MemberHandle } from './member';
import type { PauseScopeKind, PauseSource } from './pause';
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
  'task_relation_added',
  'task_relation_removed',
  'task_theme_changed',
  'task_prerequisite_closed',
  'task_note',
  'attachment_added',
  'attachment_deleted',
  'schedule_started',
  'schedule_skipped',
  'session_started',
  'session_ended',
  'session_permission_changed',
  'team_message',
  'permission_requested',
  'boundary_changed',
  'permission_resolved',
  'permission_refused',
  'permission_escalated',
  'question_asked',
  'question_answered',
  'refinement_turn',
  'task_loop',
  'task_fix_limit',
  'member_hired',
  'member_retired',
  'config_changed',
  'team_paused',
  'team_resumed',
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
    /** `closed`: a theme was closed (PM-192); it is closed like a cancelled card, and reopened the same way. */
    action?: 'cancelled' | 'reopened' | 'closed';
    previousStatus?: string;
    previousAssignee?: string | null;
    /** `fields` names `repo`: the repository it was set to (null: cleared) and the one it had. */
    repo?: string | null;
    previousRepo?: string | null;
    reason?: string;
    /** `action` is `cancelled`: the card was marked as a duplicate of this card (PM-192); `reason` says so too. */
    duplicateOf?: string;
    /** A linked pull request changed (GitHub sync). */
    pullRequest?: { repo: string; number: number; state: string };
    /** `fields` names `reviewPin`: the developer asked for a new review round, which pins the new head. */
    reviewPin?: { commit: string; branch: string; previous: string };
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
  /**
   * `reviewPin`: the commit of the developer's branch handed over with the move (PM-183).
   * `branchMoved`: the system sent the task back because the branch moved after that hand-over
   * (`pinned` is the commit handed over, `head` the branch's commit now).
   */
  task_stage_changed: {
    from: string;
    to: string;
    approvedBy?: string[];
    inboxItemIds?: string[];
    reviewPin?: { commit: string; branch: string };
    branchMoved?: { branch: string; pinned: string; head: string };
  };
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
  /**
   * A relation to another card was added or removed (PM-192). Recorded on both cards, each from its
   * own side: `kind` is a `TaskRelationKind` as this card sees it (`prerequisite_of: PM-2` on the card
   * that is the prerequisite, `prerequisite: PM-1` on the one that needs it), `ref` the other card.
   * Setting or removing a card's parent is recorded as `task_subtask_added/removed`.
   */
  task_relation_added: { kind: string; ref: string };
  task_relation_removed: { kind: string; ref: string };
  /**
   * A card was put into, moved between or taken out of themes (PM-192). Recorded on the card, on the
   * theme it left (`previous`) and on the one it joined (`themeKey`); null: none. A card that became a
   * subtask loses its own theme this way (it reads its parent's from then on).
   */
  task_theme_changed: { themeKey: string | null; previous: string | null };
  /**
   * A prerequisite of this card closed (PM-204): `ref` is the prerequisite, `status` how it closed
   * (`done` or `cancelled`), `remaining` the prerequisites still open (none: the card is free).
   * Recorded on every open card that needed it.
   */
  task_prerequisite_closed: { ref: string; status: string; remaining: string[] };
  task_note: { text: string; mentions?: string[]; importedAuthor?: string; importedAt?: string };
  /** The file name is the sanitised metadata; the audit keeps it after the attachment is deleted. */
  attachment_added: { attachmentId: string; fileName: string; size: number; mediaType: string };
  /** The actor is who deleted it; the uploader is in the matching `attachment_added`. */
  attachment_deleted: { attachmentId: string; fileName: string; size: number; mediaType: string };
  schedule_started: { runId: string; member: string; scheduledFor: string };
  schedule_skipped: { runId: string; member: string; scheduledFor: string; reason: string };
  /**
   * The team was paused (PM-219, project-level, internal): `scope` the instance or this project,
   * `source` where the request came from. The actor is the person in this project, or the system for
   * the control command. A `shutdown` pause writes no event.
   */
  team_paused: {
    pauseId: string;
    scope: PauseScopeKind;
    source: PauseSource;
    reason: string | null;
    forceAfterMs: number;
  };
  team_resumed: { pauseId: string; scope: PauseScopeKind; source: PauseSource };
  session_started: { member: string; resumed: boolean };
  /** `reason`: why the session ended when known (e.g. a lost login). */
  session_ended: { member: string; exitCode: number | null; reason?: string };
  /**
   * An owner changed one permission setting of a session (PM-170); the actor is that owner. `from`
   * and `to` are the values that apply (a mode, or an approver), `reset` that the session went back
   * to its member's setting. `restart`: the new mode waits for the session's restart at its next
   * idle moment.
   */
  session_permission_changed: {
    member: string;
    field: 'mode' | 'approver';
    from: string | null;
    to: string | null;
    reset?: true;
    restart?: true;
  };
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
  /**
   * The turn on a card that is being refined changed (PM-254): `label` is the label the step lacks
   * and `member` the AI member started for it (null: nobody, the people who may set it were told, or
   * `done`). `reason`: `started` the first step of this refinement, `label_set` the previous step's
   * label is on, `label_removed` a label came off and the card went back a step, `done` the last label
   * is on and the card was worked out (`label` is null then).
   */
  refinement_turn: {
    label: string | null;
    member: string | null;
    reason: 'started' | 'label_set' | 'label_removed' | 'done';
  };
  /**
   * A loop on the card (PM-261, actor system): `raised` it was found and `notified` was told (null when
   * nobody was; `deciders` are the people it went to then); `escalated` it went to the `deciders` for
   * `reason`; `let_run` `by` let it run; `ended` for `endReason` (`stopped`: `by` stopped the card's work;
   * `closed`: the card closed). `count` messages in `minutes` minutes among `members`.
   */
  task_loop: {
    loopId: string;
    phase: 'raised' | 'escalated' | 'let_run' | 'ended';
    members: string[];
    count: number;
    minutes: number;
    notified?: string | null;
    deciders?: string[];
    reason?: 'no_watcher' | 'continued';
    endReason?: 'commit' | 'stage' | 'label' | 'quiet' | 'stopped' | 'disabled' | 'closed';
    by?: string;
  };
  /**
   * The fix round limit of the card (PM-262, actor system unless `by`): `reached` the card was held at
   * `rounds` of `limit` (`decider` the AI member who decides, `deciders` the people, `reason` why people
   * decide); `passed_on` the lead gave it to the people; `decided` `by` chose `decision` (`continue` the
   * card goes on, `replan` the planner makes the plan more exact, `another_round` one more round,
   * `reassign` another implementer; `note` is the reason); `ended` the hold is over for `endReason`.
   */
  task_fix_limit: {
    phase: 'reached' | 'passed_on' | 'decided' | 'ended';
    rounds: number;
    limit: number;
    changeRequests: number;
    designChangeRequests: number;
    sendBacks: number;
    decider?: string | null;
    deciders?: string[];
    reason?: 'no_ai_decider' | 'passed_on' | 'again';
    decision?: 'continue' | 'replan' | 'another_round' | 'reassign';
    by?: string;
    note?: string;
    endReason?: 'decided' | 'assignee_changed' | 'closed';
  };
  member_hired: { handle: string; role: string; temp: boolean; sponsor: string };
  member_retired: { handle: string; handoverTo: string | null };
  config_changed: { version: string; message: string };
}
