import { z } from 'zod';
import { EmailParkReason } from './email-channel';
import { AttachmentId, AttachmentPreview } from './attachment';
import { BoardPlacement } from './board-order';
import { Actor } from './event';
import { ExternalToolOrigin } from './external-tool-origin';
import {
  FixLimitAssessment,
  FixLimitOptionId,
  FixRoundHistoryEntry,
  MAX_FIX_EXTRA_ROUNDS,
} from './fix-limit';
import { LabelId } from './label';
import { OperatorHandoffReason } from './member-queue';
import { MergeBlockReason, MergeFailure } from './merge';
import { AgentProvider, MemberHandle } from './member';
import { ObligationRef } from './obligation';
import { StageId } from './pipeline';
import { ReleaseStep } from './release';
import { TaskRelationKind } from './relations';
import { WorkItemRef } from './session';
import { TaskKey, TaskStartWaiting } from './task';
import { WorkOutage } from './outage';
import { canSeeAllTeamMessages } from './message';
import type { TaskViewer } from './task';

/**
 * Items waiting for a human ("Rád vár" in the UI):
 * - permission: a Claude Code tool permission request (PermissionRequest hook)
 * - decision:   a gate that needs a human approval (merge, release, ...)
 * - question:   an AI member asked a human something (ask_human tool)
 * - approval:   a proposed change (e.g. an email draft or a config change)
 * - boundary:   an external operation a member asked for
 * - alert:      something the owners should notice, with nothing to decide ("Láttam"); see
 *               `AlertPayload`
 */
export const InboxKind = z.enum([
  'permission',
  'decision',
  'question',
  'approval',
  'boundary',
  'alert',
  'hand_on',
  'merge_request',
  /** The approval of a proposed release of the instance itself (PM-491); see `ReleaseApprovalPayload`. */
  'release',
]);
export type InboxKind = z.infer<typeof InboxKind>;

/** Approval options are approve (primary) and reject (danger); a note is optional. */
export const EmailApprovalPayload = z.object({
  emailId: z.string(),
  member: MemberHandle,
  contact: MemberHandle,
  contactName: z.string(),
  taskKey: TaskKey.nullable(),
  subject: z.string(),
  text: z.string(),
});
export type EmailApprovalPayload = z.infer<typeof EmailApprovalPayload>;
export function emailApprovalOf(item: Pick<InboxItem, 'kind' | 'payload'>): EmailApprovalPayload | null {
  if (item.kind !== 'approval') return null;
  const parsed = EmailApprovalPayload.safeParse(item.payload.email);
  return parsed.success ? parsed.data : null;
}

export const EmailParkedAlert = z.object({
  alert: z.literal('email_parked'),
  emailId: z.string(),
  reason: EmailParkReason,
  fromAddress: z.string(),
  subject: z.string().max(200),
  excerpt: z.string().max(1000),
  attachmentNames: z.array(z.string()),
});
export type EmailParkedAlert = z.infer<typeof EmailParkedAlert>;

/**
 * `payload.release` of a `release` item: the release an owner approves or rejects. The options are
 * `approve` (primary) and `reject` (danger); a note is optional.
 */
export const ReleaseApprovalPayload = z.object({
  releaseId: z.string(),
  commit: z.string(),
  baseCommit: z.string().nullable(),
  tasks: z.array(z.object({ key: TaskKey, title: z.string() })),
  summary: z.string(),
});
export type ReleaseApprovalPayload = z.infer<typeof ReleaseApprovalPayload>;
export function releaseApprovalOf(item: Pick<InboxItem, 'kind' | 'payload'>): ReleaseApprovalPayload | null {
  if (item.kind !== 'release') return null;
  const parsed = ReleaseApprovalPayload.safeParse(item.payload.release);
  return parsed.success ? parsed.data : null;
}

export const MergeRequestPayload = z.object({
  taskKey: TaskKey,
  mergeId: z.string(),
  repo: z.string(),
  base: z.string(),
  failure: MergeFailure.optional(),
});
export type MergeRequestPayload = z.infer<typeof MergeRequestPayload>;
export function mergeRequestOf(item: Pick<InboxItem, 'kind' | 'payload'>): MergeRequestPayload | null {
  if (item.kind !== 'merge_request') return null;
  const parsed = MergeRequestPayload.safeParse(item.payload.mergeRequest);
  return parsed.success ? parsed.data : null;
}

export const HandOnPayload = z.object({
  taskKey: TaskKey,
  fromStageId: StageId,
  toStageId: StageId,
  requestedBy: MemberHandle,
});
export type HandOnPayload = z.infer<typeof HandOnPayload>;

export function handOnRequestOf(item: Pick<InboxItem, 'kind' | 'payload'>): HandOnPayload | null {
  if (item.kind !== 'hand_on') return null;
  const parsed = HandOnPayload.safeParse(item.payload.handOn);
  return parsed.success ? parsed.data : null;
}

export const InboxOption = z.object({
  id: z.string(),
  /** Option ids for built-in kinds are fixed ("allow", "allow_session", "deny", "approve", "reject");
   *  free-text labels come from agents (question options) and are data. */
  label: z.string(),
  style: z.enum(['primary', 'secondary', 'danger']),
  /** What happens if the human picks this option, in everyday words (options of questions from AI
   *  members); items from before it existed have none. */
  consequence: z.string().optional(),
});
export type InboxOption = z.infer<typeof InboxOption>;

export const InboxState = z.enum(['open', 'resolved', 'expired', 'cancelled', 'screening']);
export type InboxState = z.infer<typeof InboxState>;

/** A question waits for its answer in these states; screening: the Operator looks at it first (PM-556). */
export const PENDING_INBOX_STATES = ['open', 'screening'] as const;

/** True for a question that still waits for its answer: open, or with the Operator for screening. */
export function isPendingQuestion(
  item: Pick<InboxItem, 'kind' | 'state'> & Partial<Pick<InboxItem, 'payload'>>,
): boolean {
  return (
    item.kind === 'question' &&
    item.payload?.groupWithdrawn !== true &&
    (PENDING_INBOX_STATES as readonly string[]).includes(item.state)
  );
}

/**
 * The rule by which the system resolved an item itself (`resolution.by` is "system"):
 * `command_policy` is the automatic command policy (no publishing from a local-only
 * repository, lockfile installs in a task worktree). The UI names the rule via i18n.
 */
export const InboxResolutionRule = z.enum([
  'email_not_allowed',
  'outage_ended',
  'command_policy',
  /** The loop a decision was about ended by itself (PM-261): nothing is left to decide. */
  'loop_ended',
  /** The fix round limit hold a decision was about ended by itself (PM-262): nothing is left to decide. */
  'fix_limit_ended',
  /** A Senior took the card a decision asked about (PM-348): nothing is left to decide. */
  'senior_took',
  /** The card a decision asked about went on another way (PM-348): nothing is left to decide. */
  'senior_wait_ended',
  /** The label a question asked approval for was put on its card (PM-484): nothing is left to answer. */
  'approval_given',
  /** A feedback mark that waited for the owner was handled (PM-506): nothing is left to see. */
  'feedback_handled',
  /** The Operator answered an AI member's question itself while screening it (PM-556). */
  'operator_answered',
  /** The Operator passed a screened question to another member (PM-556). */
  'operator_forwarded',
  /** The Operator found a screened question moot (PM-556): nothing is left to answer. */
  'operator_moot',
  /** The card a question asked about was done (PM-556): nothing is left to answer. */
  'task_done',
  /** The card a question asked about was cancelled (PM-556): nothing is left to answer. */
  'task_cancelled',
  /** The card a question asked about was handed to someone else (PM-556). */
  'handed_off',
  /** The card a question asked about changed assignee (PM-556). */
  'assignee_changed',
  /** The asking member withdrew the question (PM-556). */
  'withdrawn',
  'group_withdrawn',
  /** The obligation an integrator todo asked about was fulfilled or cancelled meanwhile (PM-806). */
  'obligation_closed',
]);
export type InboxResolutionRule = z.infer<typeof InboxResolutionRule>;

/** The rules by which a pending question is closed without an answer (`InboxService.closeQuestion`). */
export const QuestionCloseRule = InboxResolutionRule.extract([
  'task_done',
  'task_cancelled',
  'handed_off',
  'assignee_changed',
  'withdrawn',
  'group_withdrawn',
  'operator_moot',
  'obligation_closed',
]);
export type QuestionCloseRule = z.infer<typeof QuestionCloseRule>;

export const InboxItem = z.object({
  id: z.string(),
  projectKey: z.string(),
  kind: InboxKind,
  /** Human members who may resolve it. */
  assignees: z.array(MemberHandle).min(1),
  /** Member that raised it (usually an AI member). */
  source: MemberHandle,
  sessionId: z.string().nullable(),
  taskKey: TaskKey.nullable(),
  title: z.string(),
  body: z.string().nullable(),
  /** Kind-specific structured data, e.g. { toolName, toolInput } for permissions. */
  payload: z.record(z.string(), z.unknown()),
  options: z.array(InboxOption),
  state: InboxState,
  resolution: z
    .object({
      via: z.literal('integrator').optional(),
      /** The full origin when the Operator's super mode resolved it (PM-757); older resolutions have none. */
      actor: Actor.optional(),
      /** The Operator decided this on the owner's authority (PM-875). */
      superDecision: z.literal(true).optional(),
      /**
       * True when the integrator relayed the owner's answer to a simple information question (PM-762):
       * the owner did not decide this with their own login, so it is no evidence of an owner decision.
       */
      ownerAnswerRelayed: z.literal(true).optional(),
      integratorTodo: z.literal(true).optional(),
      /** The integrator decided a fix round limit item through the dedicated endpoint (PM-714). */
      integratorFixLimit: z.literal(true).optional(),
      /** The Operator closed it from its queue item (PM-885): `by` is the Operator member, no person decided. */
      operatorQueue: z.literal(true).optional(),
      optionId: z.string(),
      by: MemberHandle,
      at: z.string(),
      /** Free text by the human who resolved it (older automatic resolutions kept a note too). */
      note: z.string().nullable(),
      /** Set when the system resolved it by a rule. */
      rule: InboxResolutionRule.optional(),
    })
    .nullable(),
  createdAt: z.string(),
  /**
   * Computed in list responses only, never stored (PM-556): why the asking member's own session has not
   * started again to take the answer.
   */
  askerStart: z.object({ reason: TaskStartWaiting.shape.reason }).optional(),
});
export type InboxItem = z.infer<typeof InboxItem>;

/** Inbox reads, live events and counts share the same privacy boundary. */
export function canSeeInboxItem(
  viewer: TaskViewer & { via?: 'integrator' },
  item: Pick<InboxItem, 'state' | 'assignees' | 'payload'>,
): boolean {
  if (hasIntegratorTodoOrigin(item.payload) && viewer.access !== 'owner') return false;
  // Check the field itself: malformed or historical private proposals must also stay private.
  if (item.payload && 'operatorKnowledge' in item.payload)
    return !viewer.via && canSeeAllTeamMessages(viewer);
  if (item.state === 'screening') return canSeeAllTeamMessages(viewer);
  return true;
}

/**
 * `payload.gate` of a `decision` item: one approval a stage move waits for. A move that needs
 * several approvals opens one item per approval label; they share `requestId`.
 */
export const GateRequestPayload = z.object({
  requestId: z.string(),
  taskKey: TaskKey,
  fromStageId: StageId,
  toStageId: StageId,
  /** Stage whose gate requires the approval (moving forward may enter several gated stages). */
  stageId: StageId,
  /** The human-only label the approver puts on the task by approving; missing on requests from before labels. */
  label: LabelId.optional(),
  requestedBy: Actor,
  /**
   * Where the card goes in the target column when the move comes from the board (PM-118), kept so the
   * wish survives a restart: checked again on approval, the top of the column when the anchor is gone.
   */
  placement: BoardPlacement.optional(),
  /** The merge that follows the approval (PM-484): the move needs the work merged into `base` by `merger`
   *  before the card enters the target. Absent when moveMerge was not `after_gates` with an approval, when
   *  nobody can merge, and on requests from before. */
  merge: z.object({ merger: MemberHandle, base: z.string().min(1) }).optional(),
});
export type GateRequestPayload = z.infer<typeof GateRequestPayload>;

/** The gate request of a decision item, or null when the item has none (or an unreadable one). */
export function gateRequestOf(item: Pick<InboxItem, 'payload'>): GateRequestPayload | null {
  const parsed = GateRequestPayload.safeParse(item.payload.gate);
  return parsed.success ? parsed.data : null;
}

/**
 * `payload.loop` of a `decision` item (PM-261): AI members on card `taskKey` wrote to each other
 * `count` times within `minutes` minutes (since `startedAt`) without progress. `reason`: `no_watcher`
 * nobody holds the scheduling duty as an AI member (or the admission refused it), `continued` the loop
 * went on after `watcher` was told. The item is closed by the system when the loop ends.
 */
export const LoopDecisionPayload = z.object({
  loopId: z.string(),
  taskKey: TaskKey,
  members: z.array(MemberHandle),
  count: z.number().int().positive(),
  minutes: z.number().int().positive(),
  startedAt: z.string(),
  reason: z.enum(['no_watcher', 'continued']),
  watcher: MemberHandle.nullable(),
});
export type LoopDecisionPayload = z.infer<typeof LoopDecisionPayload>;

/** The loop a decision item is about, or null when it is about none (or an unreadable one). */
export function loopDecisionOf(item: Pick<InboxItem, 'kind' | 'payload'>): LoopDecisionPayload | null {
  if (item.kind !== 'decision') return null;
  const parsed = LoopDecisionPayload.safeParse(item.payload.loop);
  return parsed.success ? parsed.data : null;
}

/** The options of a loop decision: stop the card's AI work, or let the loop run. The web app translates the ids. */
export const LOOP_STOP_OPTION: InboxOption = { id: 'stop_work', label: 'stop_work', style: 'danger' };
export const LOOP_LET_RUN_OPTION: InboxOption = { id: 'let_run', label: 'let_run', style: 'secondary' };

/**
 * `payload.fixLimit` of a `decision` item (PM-262): card `taskKey` reached the limit of `limit` fix rounds
 * (`rounds`: `changeRequests` of the code review, `designChangeRequests` of the UI/UX review, `sendBacks`)
 * and a person decides how it goes on. `reason`: `no_ai_decider` no AI lead developer could be asked,
 * `passed_on` the lead (`decider`) gave it to a person (`note` is its reason), `again` it reached the limit
 * again after one more round (items from before PM-714 only), `extra_exhausted` the lead had already given
 * all of its extra rounds. The item is closed by the system when the hold ends otherwise.
 *
 * PM-714 adds, all optional so that older items still parse: `history` the counted rounds (and the extra
 * rounds given) at the moment the item opened, `testsFailed` the failed full tests inside `sendBacks`,
 * `extraRounds` the extra rounds given so far (more than the limit when people allowed more),
 * `remainingExtraRounds`, `extraRoundLimit` and `assessment` the lead's judgement of a `passed_on` item.
 */
export const FixLimitDecisionPayload = z.object({
  taskKey: TaskKey,
  rounds: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  changeRequests: z.number().int().nonnegative(),
  designChangeRequests: z.number().int().nonnegative(),
  sendBacks: z.number().int().nonnegative(),
  testsFailed: z.number().int().nonnegative().optional(),
  extraRounds: z.number().int().nonnegative().optional(),
  remainingExtraRounds: z.number().int().nonnegative().optional(),
  extraRoundLimit: z.literal(MAX_FIX_EXTRA_ROUNDS).optional(),
  history: z.array(FixRoundHistoryEntry).optional(),
  assessment: FixLimitAssessment.optional(),
  reason: z.enum(['no_ai_decider', 'passed_on', 'again', 'extra_exhausted', 'decider_timeout']),
  decider: MemberHandle.nullable(),
  note: z.string().nullable(),
});
export type FixLimitDecisionPayload = z.infer<typeof FixLimitDecisionPayload>;

/** The fix round limit a decision item is about, or null when it is about none (or an unreadable one). */
export function fixLimitDecisionOf(
  item: Pick<InboxItem, 'kind' | 'payload'>,
): FixLimitDecisionPayload | null {
  if (item.kind !== 'decision') return null;
  const parsed = FixLimitDecisionPayload.safeParse(item.payload.fixLimit);
  return parsed.success ? parsed.data : null;
}

/**
 * The options of a fix limit decision: a more exact plan first (only when someone can make it), another
 * implementer (only when another AI member owns the work stage), one more round (always). The web app
 * translates the ids.
 */
export const FIX_REPLAN_OPTION: InboxOption = { id: 'replan', label: 'replan', style: 'secondary' };
export const FIX_REASSIGN_OPTION: InboxOption = { id: 'reassign', label: 'reassign', style: 'secondary' };
export const FIX_ANOTHER_ROUND_OPTION: InboxOption = {
  id: 'another_round',
  label: 'another_round',
  style: 'primary',
};

/**
 * `payload.seniorWait` of a `decision` item (PM-348): card `taskKey`, recommended for the Senior, has
 * waited `minutes` minutes (since `since`) for one of the `seniors`, who are busy or away. `reason` is
 * the reason of the recommendation. The item is closed by the system when the card goes on without an answer.
 */
export const SeniorWaitDecisionPayload = z.object({
  taskKey: TaskKey,
  since: z.string(),
  minutes: z.number().int(),
  seniors: z.array(MemberHandle),
  reason: z.string().nullable(),
});
export type SeniorWaitDecisionPayload = z.infer<typeof SeniorWaitDecisionPayload>;

/** The Senior wait a decision item asks about, or null when it is about none (or an unreadable one). */
export function seniorWaitDecisionOf(
  item: Pick<InboxItem, 'kind' | 'payload'>,
): SeniorWaitDecisionPayload | null {
  if (item.kind !== 'decision') return null;
  const parsed = SeniorWaitDecisionPayload.safeParse(item.payload.seniorWait);
  return parsed.success ? parsed.data : null;
}

/** The options of a Senior wait decision: wait on for the Senior, or let a free developer take the card. */
export const SENIOR_WAIT_OPTION_WAIT = 'wait_for_senior';
export const SENIOR_WAIT_OPTION_ANY = 'any_developer';
export const SENIOR_WAIT_OPTIONS: InboxOption[] = [
  { id: SENIOR_WAIT_OPTION_WAIT, label: SENIOR_WAIT_OPTION_WAIT, style: 'secondary' },
  { id: SENIOR_WAIT_OPTION_ANY, label: SENIOR_WAIT_OPTION_ANY, style: 'primary' },
];

/** The one option of an `alert` item: the owner has seen it. The web app translates the id. */
export const ALERT_SEEN_OPTION: InboxOption = { id: 'seen', label: 'seen', style: 'primary' };

/**
 * `payload` of an `alert` item: `alert` names what happened. `session_tokens` (PM-187): a session's
 * usage reached the project's warning limit (`countedTokens` as `limitTokens` counts them, and
 * `limitTokens` the limit then); the item's `source` is the member and its `sessionId` the session.
 */
export const SessionTokensAlert = z.object({
  alert: z.literal('session_tokens'),
  countedTokens: z.number().int().nonnegative(),
  limitTokens: z.number().int().positive(),
  workItem: WorkItemRef,
  /** When the session started (ISO time). */
  sessionStartedAt: z.string(),
});
export type SessionTokensAlert = z.infer<typeof SessionTokensAlert>;

/**
 * `message_burst` (PM-186): `count` team messages and notes landed on card `taskKey` within
 * `minutes` minutes (the threshold the project set then). `members` are those who wrote or were
 * written to; `at` is when the alert was raised (ISO time), which decides when a later storm on the
 * card may raise the next one.
 */
export const MessageBurstAlert = z.object({
  alert: z.literal('message_burst'),
  taskKey: TaskKey,
  count: z.number().int().positive(),
  minutes: z.number().int().positive(),
  members: z.array(MemberHandle),
  at: z.string(),
});
export type MessageBurstAlert = z.infer<typeof MessageBurstAlert>;

/**
 * `session_input` (PM-199): a session has waited for input at its terminal for `minutes` minutes
 * (`since`, ISO time) and no inbox item of it shows a question, so nobody knows it waits: messages for
 * it are held back until it carries on. `activity` is what the runner saw (a tool, a dialog), when it
 * knew; the item's `source` is the member and its `sessionId` the session.
 */
export const SessionInputAlert = z.object({
  alert: z.literal('session_input'),
  workItem: WorkItemRef,
  since: z.string(),
  minutes: z.number().int().positive(),
  activity: z.string().nullable(),
});
export type SessionInputAlert = z.infer<typeof SessionInputAlert>;

/**
 * `disk_low` (PM-243): the free disk space (`freeBytes`) fell below the project's limit
 * (`thresholdBytes`); no new AI session starts until there is room again. One open alert per project.
 */
export const DiskLowAlert = z.object({
  alert: z.literal('disk_low'),
  freeBytes: z.number().int().nonnegative(),
  thresholdBytes: z.number().int().positive(),
});
export type DiskLowAlert = z.infer<typeof DiskLowAlert>;

/**
 * `worktree_kept` (PM-243): the cleanup of the worktrees of closed cards left the worktree of card
 * `taskKey` (`changes` uncommitted files) in place, because removing it would lose that work. Raised
 * once per closing of the card.
 */
export const WorktreeKeptAlert = z.object({
  alert: z.literal('worktree_kept'),
  taskKey: TaskKey,
  path: z.string(),
  changes: z.number().int().nonnegative(),
});
export type WorktreeKeptAlert = z.infer<typeof WorktreeKeptAlert>;

/**
 * `refinement` (PM-254, decision 31): the refinement of card `taskKey` needs a person. `label` is the
 * label the step lacks (null for `done`). `manual_step`: no AI member may set it, so the people who may
 * should write what the step asks for and set it; `stalled`: the member whose turn it was finished
 * without setting it and no blocking label holds the card; `done`: every step is done, the card is
 * worked out (and was moved on when the pipeline had a stage for it).
 */
export const RefinementAlert = z.object({
  alert: z.literal('refinement'),
  taskKey: TaskKey,
  label: LabelId.nullable(),
  reason: z.enum(['manual_step', 'stalled', 'done']),
});
export type RefinementAlert = z.infer<typeof RefinementAlert>;

/**
 * `relation_check` (PM-421): new relations of card `taskKey` may change its work (a prerequisite or a
 * duplicate), the card has members working on it, and no analyst can check them. `relations` are the
 * new ones as the card sees them.
 */
export const RelationCheckAlert = z.object({
  alert: z.literal('relation_check'),
  taskKey: TaskKey,
  relations: z.array(z.object({ kind: TaskRelationKind, key: TaskKey })).min(1),
});
export type RelationCheckAlert = z.infer<typeof RelationCheckAlert>;

/** `parts_left` (PM-480): parts of card `taskKey` that `member` created are still left in the first stage after a reminder. */
export const PartsLeftAlert = z.object({
  alert: z.literal('parts_left'),
  taskKey: TaskKey,
  member: MemberHandle,
  parts: z.array(TaskKey).min(1),
});
export type PartsLeftAlert = z.infer<typeof PartsLeftAlert>;

/** `feedback_forwarded` (PM-506): the processor passed feedback mark `markId` of `author` on to the owners with a `reason`. */
export const FeedbackForwardedAlert = z.object({
  alert: z.literal('feedback_forwarded'),
  markId: z.string(),
  author: MemberHandle,
  excerpt: z.string().max(200),
  reason: z.string(),
});
export type FeedbackForwardedAlert = z.infer<typeof FeedbackForwardedAlert>;

/** A provider quota stopped a session; the owners are told once per hold (PM-377). */
export const ProviderRateLimitAlert = z.object({
  alert: z.literal('provider_rate_limited'),
  provider: AgentProvider,
  until: z.string().nullable(),
  weeklyPercent: z.number().nullable(),
  message: z.string(),
  workItem: WorkItemRef,
});
export type ProviderRateLimitAlert = z.infer<typeof ProviderRateLimitAlert>;

export const MergeBlockedAlert = z.object({
  alert: z.literal('merge_blocked'),
  taskKey: TaskKey,
  mergeId: z.string(),
  reason: MergeBlockReason,
  message: z.string(),
});
export type MergeBlockedAlert = z.infer<typeof MergeBlockedAlert>;
export const WorkOutageAlert = z.object({
  alert: z.literal('work_outage'),
  outage: WorkOutage,
  members: z.array(MemberHandle),
  tasks: z.array(TaskKey),
  checkedAt: z.string(),
});
export type WorkOutageAlert = z.infer<typeof WorkOutageAlert>;

/** `release_failed` (PM-491): the deploy of release `releaseId` failed in `step`; `rolledBack`: the previous commit runs again. */
export const ReleaseFailedAlert = z.object({
  alert: z.literal('release_failed'),
  releaseId: z.string(),
  taskKey: TaskKey,
  commit: z.string(),
  step: ReleaseStep,
  message: z.string(),
  rolledBack: z.boolean(),
});
export type ReleaseFailedAlert = z.infer<typeof ReleaseFailedAlert>;

export const AlertPayload = z.discriminatedUnion('alert', [
  EmailParkedAlert,
  ReleaseFailedAlert,
  WorkOutageAlert,
  MergeBlockedAlert,
  SessionTokensAlert,
  MessageBurstAlert,
  SessionInputAlert,
  DiskLowAlert,
  WorktreeKeptAlert,
  RefinementAlert,
  ProviderRateLimitAlert,
  RelationCheckAlert,
  PartsLeftAlert,
  FeedbackForwardedAlert,
]);
export type AlertPayload = z.infer<typeof AlertPayload>;

/** The alert payload of an item, or null when it is no alert (or an unreadable or unknown one). */
export function alertPayloadOf(item: Pick<InboxItem, 'kind' | 'payload'>): AlertPayload | null {
  if (item.kind !== 'alert') return null;
  const parsed = AlertPayload.safeParse(item.payload);
  return parsed.success ? parsed.data : null;
}

/** Legacy completion notices require no decision or action on their card. */
export function isInformationalAlert(item: Pick<InboxItem, 'kind' | 'payload'>): boolean {
  const alert = alertPayloadOf(item);
  return alert?.alert === 'refinement' && alert.reason === 'done';
}

/** At most this many files on one question (PM-498). */
export const MAX_QUESTION_ATTACHMENTS = 6;

/** A file a question names (PM-498): a snapshot taken when it was asked, so it still shows after a deletion. */
export const QuestionAttachment = z.object({
  id: AttachmentId,
  /** The card the file is on: the question's card or its parent. */
  taskKey: TaskKey,
  fileName: z.string(),
  size: z.number().int().nonnegative(),
  mediaType: z.string(),
  preview: AttachmentPreview,
  /** When the file was deleted from its card after the question was asked; absent while it is there. */
  goneAt: z.string().optional(),
});
export type QuestionAttachment = z.infer<typeof QuestionAttachment>;

/** How long the Operator may screen a question before it goes to the people (PM-556). */
export const QUESTION_SCREENING_MINUTES = 10;

/** What the Operator decided about a screened question: it answered, passed it on, found it moot, or asked a person. */
export const ScreeningOutcome = z.enum(['answered', 'forwarded', 'moot', 'decision', 'todo']);
export type ScreeningOutcome = z.infer<typeof ScreeningOutcome>;

export const QuestionRecipient = z.enum(['owner', 'integrator']);
export type QuestionRecipient = z.infer<typeof QuestionRecipient>;
export const QuestionRecipientRefusal = z.enum(['protected_question', 'integrator_unavailable']);
export type QuestionRecipientRefusal = z.infer<typeof QuestionRecipientRefusal>;

/** A task for a person that the Operator made out of a question: what to do, where, and what is expected. */
export const QuestionTodo = z.object({
  what: z.string().min(1).max(2000),
  where: z.string().min(1).max(500),
  expected: z.string().min(1).max(1000),
  recipient: QuestionRecipient.optional(),
});
export type QuestionTodo = z.infer<typeof QuestionTodo>;
export const ScreeningTodo = QuestionTodo.extend({ recipient: QuestionRecipient });
export type ScreeningTodo = z.infer<typeof ScreeningTodo>;

/** The whole screening window in milliseconds (`QUESTION_SCREENING_MINUTES`). */
export const QUESTION_SCREENING_MS = QUESTION_SCREENING_MINUTES * 60_000;

/**
 * The question waits for the machine its project manager runs on (PM-708): the human fallback clock is
 * frozen at `remainingMs` and starts again when the machine is back.
 */
export const QuestionScreeningQueue = z.object({
  reason: z.literal('engine_offline'),
  /** ISO: when the question was put on hold. */
  since: z.string().datetime(),
  remainingMs: z.number().int().min(0).max(QUESTION_SCREENING_MS),
});
export type QuestionScreeningQueue = z.infer<typeof QuestionScreeningQueue>;

/** `payload.screening` of a question: the Operator looks at it first (PM-556). */
export const QuestionScreening = z.object({
  /**
   * ISO: when it was asked plus `QUESTION_SCREENING_MINUTES`; set again from the delivery receipt. While
   * `queue` is present it is not an active deadline (it stays as the historical value).
   */
  until: z.string(),
  /** Present while the question waits for an offline machine; the fallback clock does not run (PM-708). */
  queue: QuestionScreeningQueue.optional(),
  /** The Operator got it. */
  deliveredAt: z.string().optional(),
  outcome: ScreeningOutcome.optional(),
  /** The Operator's handle. */
  by: z.string().optional(),
  at: z.string().optional(),
  /** The Operator's reason or background. */
  note: z.string().max(2000).optional(),
  /** Outcome `forwarded`. */
  forwardedTo: z.string().optional(),
  /** Outcome `todo`. */
  todo: QuestionTodo.optional(),
  recipientRefusal: QuestionRecipientRefusal.optional(),
  /** Released to the people with no outcome. */
  fallback: z.enum(['timeout', 'unavailable']).optional(),
  /** The feedback item (PM-472) of a todo. */
  feedbackId: z.string().optional(),
});
export type QuestionScreening = z.infer<typeof QuestionScreening>;

const clampScreeningMs = (ms: number): number =>
  Number.isFinite(ms) ? Math.max(0, Math.min(QUESTION_SCREENING_MS, Math.floor(ms))) : 0;

/**
 * Whether a screened question's ten minutes are up (PM-708); the server and the web fake use this one rule.
 * The clock runs only for a question the Operator got (`deliveredAt`), while its machine is online and the
 * question is not held in a `queue`; otherwise it is stopped and `remainingMs` is what is left of it. An
 * unreadable `until` counts as no time left, so a broken record goes to the people and never waits unseen.
 */
export function screeningDeadline(input: {
  until: string;
  deliveredAt: string | null;
  queue: { remainingMs: number } | null;
  now: string;
  engineOnline: boolean;
}): { timeout: boolean; remainingMs: number } {
  if (input.queue) return { timeout: false, remainingMs: clampScreeningMs(input.queue.remainingMs) };
  if (!input.deliveredAt) return { timeout: false, remainingMs: QUESTION_SCREENING_MS };
  const remainingMs = clampScreeningMs(Date.parse(input.until) - Date.parse(input.now));
  return { timeout: input.engineOnline && remainingMs === 0, remainingMs };
}

/**
 * What is left of a delivered question's ten minutes when its machine went away (PM-708): the time up to
 * `until` counted from the last moment the machine was confirmed online. No such moment: nothing is left, the
 * running time is not guessed.
 */
export function screeningFrozenRemainingMs(until: string, lastConfirmedOnlineAt: string | null): number {
  if (!lastConfirmedOnlineAt) return 0;
  return clampScreeningMs(Date.parse(until) - Date.parse(lastConfirmedOnlineAt));
}

/** Whether the answer reached the asking member: it waits for the member's session, or it was delivered. */
export const AnswerDelivery = z.discriminatedUnion('state', [
  z.object({ state: z.literal('waiting'), reason: TaskStartWaiting.shape.reason, since: z.string() }),
  z.object({ state: z.literal('delivered'), at: z.string() }),
]);
export type AnswerDelivery = z.infer<typeof AnswerDelivery>;

/** The options of a todo the Operator made out of a question. The web app translates the ids. */
export const TODO_DONE_OPTION: InboxOption = { id: 'todo_done', label: 'Done', style: 'primary' };
export const TODO_CANNOT_OPTION: InboxOption = {
  id: 'todo_cannot',
  label: 'Cannot do it',
  style: 'secondary',
};

/** The questions the Operator screened, newest first, and how many of them today. */
export const ScreenedQuestionsResponse = z.object({
  items: z.array(InboxItem),
  today: z.number().int().nonnegative(),
});
export type ScreenedQuestionsResponse = z.infer<typeof ScreenedQuestionsResponse>;

/**
 * `payload` of a `question` item, written by the `ask_human` team tool. The question is also the
 * item's title; what each option leads to is `consequence` on the item's options. Questions from
 * before the plain-language fields carry only `question` and `options`, and stay valid: everything
 * else is optional.
 */
export const QuestionGroup = z.object({
  primaryItemId: z.string(),
  itemIds: z.array(z.string()),
  combinedQuestion: z.string(),
  originalQuestion: z.string(),
  primaryTaskKey: TaskKey.nullable().optional(),
  note: z.string().min(1).max(2000).optional(),
  answeredCount: z.number().int().min(0).max(10).optional(),
  sources: z
    .array(
      z.object({
        itemId: z.string(),
        taskKey: TaskKey.nullable(),
        taskTitle: z.string().nullable(),
        asker: MemberHandle,
        question: z.string().nullable(),
        createdAt: z.string().datetime({ offset: true }),
        state: z.enum(['live', 'withdrawn', 'deleted']),
      }),
    )
    .optional(),
});
export type QuestionGroup = z.infer<typeof QuestionGroup>;

/** Withdrawn and deleted originals do not receive the shared answer. */
export function questionGroupLiveItemIds(group: QuestionGroup): string[] {
  return group.sources
    ? group.sources.filter((source) => source.state === 'live').map((source) => source.itemId)
    : group.itemIds;
}

export const CombineQuestionsRequest = z.object({
  itemIds: z
    .array(z.string().min(1))
    .min(2)
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, 'Question ids must be unique'),
  question: z.string().trim().min(1).max(2000),
  note: z.string().trim().min(1).max(2000),
});
export type CombineQuestionsRequest = z.infer<typeof CombineQuestionsRequest>;
export interface CombineQuestionsResult {
  primaryItemId: string;
  linkedItemIds: string[];
}

/** Compatibility is structural; the PM must also establish that the decisions mean the same thing. */
export function questionGroupCompatible(a: InboxItem, b: InboxItem): boolean {
  // A question the integrator asked through the bearer MCP (PM-784) never joins a member's group.
  if (questionPayloadOf(a)?.externalQuestion || questionPayloadOf(b)?.externalQuestion) return false;
  const signature = (item: InboxItem) => {
    const p = questionPayloadOf(item);
    return JSON.stringify({
      project: item.projectKey,
      assignees: [...item.assignees].sort(),
      options: item.options.map(({ id, label, consequence }) => ({ id, label, consequence })),
      recommended: p?.recommended ?? null,
      attachments: (p?.attachments ?? []).map((file) => file.id).sort(),
      approval: p?.approvalLabel ?? null,
      // An information question and an owner decision never share a group (PM-762): one answer closes all.
      purpose: p?.responsePurpose ?? 'owner_decision',
    });
  };
  return signature(a) === signature(b);
}

export function isLinkedQuestion(item: Pick<InboxItem, 'id' | 'payload'>): boolean {
  const group = questionPayloadOf(item)?.group;
  return !!group && group.primaryItemId !== item.id;
}

/** The same group projection is used for REST, live events and the web fake. */
export function visibleQuestionItem(
  _viewer: TaskViewer,
  item: InboxItem,
  canSeeKey: (key: string) => boolean,
): InboxItem {
  const { groupWithdrawn: _withdrawn, ...publicPayload } = item.payload;
  const group = questionPayloadOf(item)?.group;
  if (!group) return 'groupWithdrawn' in item.payload ? { ...item, payload: publicPayload } : item;
  if (group.primaryItemId !== item.id)
    return {
      ...item,
      payload: {
        ...publicPayload,
        group: {
          primaryItemId: group.primaryItemId,
          itemIds: [],
          combinedQuestion: '',
          originalQuestion: group.originalQuestion,
          primaryTaskKey:
            group.primaryTaskKey && canSeeKey(group.primaryTaskKey) ? group.primaryTaskKey : null,
        },
      },
    };
  return {
    ...item,
    payload: {
      ...publicPayload,
      group: {
        ...group,
        primaryTaskKey: group.primaryTaskKey && canSeeKey(group.primaryTaskKey) ? group.primaryTaskKey : null,
        ...(group.sources
          ? {
              sources: group.sources.map((source) =>
                source.taskKey && !canSeeKey(source.taskKey)
                  ? { ...source, taskKey: null, taskTitle: null, question: null }
                  : source,
              ),
            }
          : {}),
      },
    },
  };
}

/** What a question's answer is for (PM-762). */
export const QuestionResponsePurpose = z.enum(['information', 'owner_decision']);
export type QuestionResponsePurpose = z.infer<typeof QuestionResponsePurpose>;

/** What the owner's question about a super operation carries, so the answer binds exactly one operation and version. */
export const SuperOperationQuestionPayload = z.strictObject({
  operationId: z.string(),
  commandHash: z.string(),
  expectedConfigVersion: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});
export type SuperOperationQuestionPayload = z.infer<typeof SuperOperationQuestionPayload>;

/**
 * True when the answer to this question may be relayed by the integrator: an explicit information question
 * only. A question that asks for an approval label, or that the Operator made a todo of, is an owner's
 * action whatever its declared purpose, and so is one bound to a super operation.
 */
export function isRelayableQuestion(
  payload: Pick<
    QuestionPayload,
    'responsePurpose' | 'superOperation' | 'approvalLabel' | 'screening' | 'externalQuestion'
  >,
) {
  return (
    payload.responsePurpose === 'information' &&
    !payload.externalQuestion &&
    !payload.superOperation &&
    !payload.approvalLabel &&
    !payload.screening?.todo &&
    payload.screening?.outcome !== 'todo'
  );
}

/** The payload keys of the approvals the server builds; an item that carries one is never a plain question. */
export const APPROVAL_PAYLOAD_KEYS = [
  'email',
  'gate',
  'release',
  'permission',
  'boundary',
  'approval',
  'operatorApproval',
  'operatorKnowledge',
] as const;

/** The whole-item form of `isRelayableQuestion`: also looks at the approval payload keys and the todo options. */
export function isRelayableQuestionItem(item: Pick<InboxItem, 'kind' | 'payload' | 'options'>): boolean {
  if (item.kind !== 'question') return false;
  const payload = questionPayloadOf(item);
  if (!payload || !isRelayableQuestion(payload)) return false;
  if (APPROVAL_PAYLOAD_KEYS.some((key) => key in item.payload)) return false;
  return !item.options.some(
    (option) => option.id === TODO_DONE_OPTION.id || option.id === TODO_CANNOT_OPTION.id,
  );
}

/** `payload.operatorHandoff` of an item the Operator passed on (PM-885). */
export const OperatorHandoff = z.object({
  queueItemId: z.string(),
  reason: OperatorHandoffReason,
  action: z.string().max(300),
  detail: z.string().max(2000).nullable(),
  operationId: z.string().nullable(),
});
export type OperatorHandoff = z.infer<typeof OperatorHandoff>;

export const QuestionPayload = z.object({
  requestedRecipient: QuestionRecipient.optional(),
  recipient: QuestionRecipient.optional(),
  integratorOpenedAt: z.iso.datetime().optional(),
  integratorEscalatedAt: z.iso.datetime().optional(),
  group: QuestionGroup.optional(),
  question: z.string(),
  /** The approval this question appears to request. An answer never sets it; setting it closes the question (approval_given). */
  approvalLabel: LabelId.optional(),
  /** The suggested answers as plain labels; the item's options (`option_1`, ...) repeat them. */
  options: z.array(z.string()).optional(),
  /** Id of the option (in the item's `options`) the asking member recommends. */
  recommended: z.string().optional(),
  /** One sentence: why the member recommends that option. */
  recommendationReason: z.string().optional(),
  /** Markdown technical background for whoever wants to dig in; shown folded. */
  details: z.string().optional(),
  /**
   * True when the system put the waiting label on the card for this question, so it takes the label
   * off when the last such question closes; absent when a person had put it on, or it was not set.
   */
  autoLabel: z.boolean().optional(),
  /** The files the question names (PM-498); absent on older questions and on questions without files. */
  attachments: z.array(QuestionAttachment).optional(),
  /** Present while the Operator screens the question and after it did (PM-556). */
  screening: QuestionScreening.optional(),
  /** The question was asked again without screening: why, and the item it replaces (PM-556). */
  unscreened: z.object({ reason: z.string().min(1).max(1000), previousItemId: z.string() }).optional(),
  /** Whether the answer reached the asking member (PM-556). */
  answerDelivery: AnswerDelivery.optional(),
  /**
   * What the answer is for (PM-762): `information` may be relayed by the super-mode integrator, an
   * `owner_decision` only the owner's own login answers. A missing value counts as `owner_decision`.
   */
  responsePurpose: QuestionResponsePurpose.optional(),
  /** Binds the question to one durable super operation (PM-762); such a question is always an owner decision. */
  superOperation: SuperOperationQuestionPayload.optional(),
  /**
   * Present when the integrator asked this question through the bearer MCP (PM-784): who it came from. It
   * is provenance only; such a question is answered by a person's own login, never by a token.
   */
  externalQuestion: ExternalToolOrigin.optional(),
  /** The durable message that carries the answer of an `externalQuestion` (PM-784); no session reads it. */
  externalAnswerMessageId: z.string().optional(),
  /** The obligation this integrator todo hands over (PM-806): the system opened it, no member asked. */
  obligation: ObligationRef.optional(),
  /** Why the Operator gave this item to the owner (PM-885): its queue item, the reason and the action left for the owner. */
  operatorHandoff: OperatorHandoff.optional(),
});
export type QuestionPayload = z.infer<typeof QuestionPayload>;

/**
 * Why a token (the integrator in any mode, or a person through a key) may not answer an integrator-asked
 * question (PM-784), or null when the answerer is not one. The question's own answer is never relayed
 * (`super_relay_refused`); a decision needs the owner's own login (`owner_approval_required`).
 */
export function externalQuestionAnswerRefusal(
  payload: Pick<QuestionPayload, 'externalQuestion' | 'responsePurpose'>,
  by: { via?: unknown; superActor?: unknown },
): 'super_relay_refused' | 'owner_approval_required' | null {
  if (!payload.externalQuestion || (!by.via && !by.superActor)) return null;
  return payload.responsePurpose === 'information' ? 'super_relay_refused' : 'owner_approval_required';
}

/** Decisions reserved to a person's own login, even on the owner's authority (PM-883). */
export function superDecisionRefusal(
  item: Pick<InboxItem, 'kind' | 'payload' | 'source'>,
  facts: { operatorHandle: string | null; sessionMember?: string | null },
): 'owner_approval_required' | null {
  if (
    !facts.operatorHandle ||
    item.kind === 'permission' ||
    item.kind === 'boundary' ||
    ['superOperation', 'operatorApproval', 'operatorKnowledge'].some((key) => key in item.payload) ||
    (item.kind === 'approval' && ('operator' in item.payload || 'email' in item.payload)) ||
    item.source === facts.operatorHandle ||
    facts.sessionMember === facts.operatorHandle
  )
    return 'owner_approval_required';
  return null;
}

/** The question payload of an item, or null when it has none (or an unreadable one). */
export function questionPayloadOf(item: Pick<InboxItem, 'payload'>): QuestionPayload | null {
  const parsed = QuestionPayload.safeParse(item.payload);
  return parsed.success ? parsed.data : null;
}

/** Protected fields are checked before parsing: even a null approval is never delegated. */
export function hasProtectedQuestionPayload(item: Pick<InboxItem, 'kind' | 'payload'>): boolean {
  if (!item.payload || typeof item.payload !== 'object') return true;
  return (
    item.kind !== 'question' ||
    ['approvalLabel', 'superOperation', ...APPROVAL_PAYLOAD_KEYS].some((key) => key in item.payload)
  );
}

function hasIntegratorTodoOrigin(payload: InboxItem['payload']): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const screening = payload.screening;
  const todo = screening && typeof screening === 'object' && 'todo' in screening ? screening.todo : null;
  return (
    payload.recipient === 'integrator' ||
    'integratorOpenedAt' in payload ||
    'integratorEscalatedAt' in payload ||
    !!(todo && typeof todo === 'object' && 'recipient' in todo && todo.recipient === 'integrator')
  );
}

export function selectTodoRecipient(
  item: InboxItem,
  requested: QuestionRecipient,
  integratorAvailable: boolean,
): { recipient: QuestionRecipient; recipientRefusal?: QuestionRecipientRefusal } {
  if (requested === 'owner') return { recipient: 'owner' };
  if (hasProtectedQuestionPayload(item) || !questionPayloadOf(item) || 'group' in item.payload)
    return { recipient: 'owner', recipientRefusal: 'protected_question' };
  if (!integratorAvailable) return { recipient: 'owner', recipientRefusal: 'integrator_unavailable' };
  return { recipient: 'integrator' };
}

/** State and authentication are checked by the operation, independently of durable addressing. */
export function isIntegratorTodo(item: InboxItem): boolean {
  const p = questionPayloadOf(item);
  return (
    !hasProtectedQuestionPayload(item) &&
    !!p &&
    p.recipient === 'integrator' &&
    p.screening?.outcome === 'todo' &&
    p.screening.todo?.recipient === 'integrator' &&
    !!p.integratorOpenedAt &&
    !('integratorEscalatedAt' in item.payload) &&
    !('group' in item.payload) &&
    item.options.length === 2 &&
    new Set(item.options.map((o) => o.id)).size === 2 &&
    item.options.every((o) => o.id === TODO_DONE_OPTION.id || o.id === TODO_CANNOT_OPTION.id)
  );
}

export function questionRecipientOf(item: InboxItem): QuestionRecipient {
  return isIntegratorTodo(item) ? 'integrator' : 'owner';
}

export function wasIntegratorTodo(item: InboxItem): boolean {
  return item.kind === 'question' && !!questionPayloadOf(item)?.integratorOpenedAt;
}

/** Why a fix limit decision item went from the integrator to the owners (PM-714). */
export const IntegratorEscalationReason = z.enum([
  'integrator_timeout',
  'integrator_passed_on',
  // The Operator cannot process its queue any more (on leave, AI off, role gone): the item goes to the owners (PM-885).
  'integrator_unavailable',
]);
export type IntegratorEscalationReason = z.infer<typeof IntegratorEscalationReason>;

/**
 * The payload keys a fix limit decision item may carry to be delegated to the integrator (PM-714). An allow
 * list on purpose: a payload with any other key (an approval, a loop, a Senior wait, a structural review, a
 * gate, anything mixed in) is never delegated.
 */
const FIX_LIMIT_ITEM_PAYLOAD_KEYS: readonly string[] = [
  'fixLimit',
  'recipient',
  'recipientRefusal',
  'integratorOpenedAt',
  'integratorEscalatedAt',
  'integratorEscalationReason',
  'operatorHandoff',
];

const FIX_LIMIT_OPTION_IDS: readonly string[] = FixLimitOptionId.options;

/**
 * Whether `item` is a fix round limit decision of the system that an integrator may be given at all (PM-714):
 * the shape only, not the addressing. A `decision` item of source `system` whose `payload.fixLimit` is valid
 * and about the item's own card, whose payload has no key beyond the fix limit's and the addressing's, and
 * whose options are unique and all one of the three fix limit outcomes. Null, mixed or approval payloads fail.
 */
export function isDelegableFixLimitDecision(
  item: Pick<InboxItem, 'kind' | 'source' | 'taskKey' | 'payload' | 'options'>,
): boolean {
  if (item.kind !== 'decision' || item.source !== 'system') return false;
  if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) return false;
  if (Object.keys(item.payload).some((key) => !FIX_LIMIT_ITEM_PAYLOAD_KEYS.includes(key))) return false;
  const fixLimit = fixLimitDecisionOf(item);
  if (!fixLimit || !item.taskKey || fixLimit.taskKey !== item.taskKey) return false;
  const ids = item.options.map((option) => option.id);
  return (
    ids.length > 0 && new Set(ids).size === ids.length && ids.every((id) => FIX_LIMIT_OPTION_IDS.includes(id))
  );
}

/**
 * A fix round limit decision currently addressed to the integrator (PM-714): the narrow shape and
 * `recipient: 'integrator'` with a valid `integratorOpenedAt` and no `integratorEscalatedAt`. State and
 * authentication are checked by the operation, independently of this durable addressing.
 */
export function isIntegratorFixLimitDecision(item: InboxItem): boolean {
  if (!isDelegableFixLimitDecision(item)) return false;
  const { recipient, integratorOpenedAt } = item.payload;
  return (
    recipient === 'integrator' &&
    typeof integratorOpenedAt === 'string' &&
    z.iso.datetime().safeParse(integratorOpenedAt).success &&
    !('integratorEscalatedAt' in item.payload)
  );
}

/** An item the integrator is the recipient of: an integrator todo, or the narrow fix limit decision. */
export function isIntegratorInboxItem(item: InboxItem): boolean {
  return isIntegratorTodo(item) || isIntegratorFixLimitDecision(item);
}

/** The Operator still owes this open integrator item: it has not handed it to the super side (PM-1003). */
export function operatorOwesInboxItem(item: InboxItem): boolean {
  return item.state === 'open' && isIntegratorInboxItem(item) && !('operatorHandoff' in item.payload);
}

/** Whether the item was ever opened to the integrator, whatever happened to it since (PM-714). */
export function wasIntegratorInboxItem(item: InboxItem): boolean {
  if (wasIntegratorTodo(item)) return true;
  return (
    item.kind === 'decision' &&
    !!item.payload &&
    typeof item.payload === 'object' &&
    'integratorOpenedAt' in item.payload
  );
}

/** Who an item is for: the integrator for `isIntegratorInboxItem`, else the owners. */
export function inboxRecipientOf(item: InboxItem): QuestionRecipient {
  return isIntegratorInboxItem(item) ? 'integrator' : 'owner';
}

/** The recipient a new fix limit decision goes to: the integrator when one is available and the shape is delegable. */
export function selectFixLimitRecipient(
  item: Pick<InboxItem, 'kind' | 'source' | 'taskKey' | 'payload' | 'options'>,
  integratorAvailable: boolean,
): { recipient: QuestionRecipient; recipientRefusal?: QuestionRecipientRefusal } {
  if (!isDelegableFixLimitDecision(item))
    return { recipient: 'owner', recipientRefusal: 'protected_question' };
  if (!integratorAvailable) return { recipient: 'owner', recipientRefusal: 'integrator_unavailable' };
  return { recipient: 'integrator' };
}

export function humanInboxAssignment(item: InboxItem, handle: string | null): boolean {
  return inboxRecipientOf(item) === 'owner' && (handle === null || item.assignees.includes(handle));
}

/**
 * The change that gives an open integrator item to the owners (PM-714), or null when it stays. An open
 * Operator todo or a fix limit decision held by the Operator goes at once, when the Operator passes it on
 * (`integrator_passed_on`) or does not work its queue (`integrator_unavailable`); there is no clock. The payload
 * and options are kept, only the addressing changes, so no second decision item is made. `assignees` are the
 * people who then decide.
 */
export function planIntegratorInboxEscalation(
  item: InboxItem,
  now: string,
  owners: readonly string[],
  reason: 'integrator_passed_on' | 'integrator_unavailable',
): Pick<InboxItem, 'payload' | 'assignees'> | null {
  if (item.state !== 'open' || !owners.length) return null;
  if (!isIntegratorTodo(item) && !isIntegratorFixLimitDecision(item)) return null;
  return {
    payload: {
      ...item.payload,
      recipient: 'owner',
      integratorEscalatedAt: now,
      integratorEscalationReason: reason,
    },
    assignees: [...owners],
  };
}

/**
 * The files a question names, or an empty list when the item is not a question, has none, or the
 * field is unreadable. The field is parsed on its own so one bad entry does not make the whole
 * question unreadable.
 */
export function questionAttachmentsOf(item: Pick<InboxItem, 'kind' | 'payload'>): QuestionAttachment[] {
  if (item.kind !== 'question') return [];
  const raw = (item.payload as Record<string, unknown> | null | undefined)?.attachments;
  const parsed = z.array(QuestionAttachment).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/**
 * A copy of a question payload in which the named file is marked deleted at `at`. Null when the
 * payload has no such file or it is already marked. The server and the web's test backend both
 * call this.
 */
export function withQuestionAttachmentGone(
  payload: Record<string, unknown>,
  attachmentId: string,
  at: string,
): Record<string, unknown> | null {
  const list = payload.attachments;
  if (!Array.isArray(list)) return null;
  let changed = false;
  const next = list.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return entry;
    const record = entry as Record<string, unknown>;
    if (record.id !== attachmentId || record.goneAt !== undefined) return entry;
    changed = true;
    return { ...record, goneAt: at };
  });
  return changed ? { ...payload, attachments: next } : null;
}

/**
 * One suggested answer of an `ask_human` question as the asking member wrote it: a label, or a
 * label with what happens if it is picked.
 */
export type QuestionOptionInput = string | { label: string; consequence?: string };

/** A suggested answer, normalized. */
export interface QuestionChoice {
  label: string;
  consequence?: string;
}

/**
 * The choices a question offers: trimmed, without empty labels, and without repeats (the first
 * occurrence of a label wins). The team tool checks a recommendation against these labels and the
 * domain stores them, so both read the same list.
 */
export function questionChoices(options: readonly QuestionOptionInput[] | undefined): QuestionChoice[] {
  const choices: QuestionChoice[] = [];
  for (const option of options ?? []) {
    const label = (typeof option === 'string' ? option : option.label).trim();
    if (!label || choices.some((choice) => choice.label === label)) continue;
    const consequence = typeof option === 'string' ? '' : (option.consequence ?? '').trim();
    choices.push(consequence ? { label, consequence } : { label });
  }
  return choices;
}
