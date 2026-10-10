import { z } from 'zod';
import { BoardPlacement } from './board-order';
import { Actor } from './event';
import { LabelId } from './label';
import { MergeBlockReason, MergeFailure } from './merge';
import { AgentProvider, MemberHandle } from './member';
import { StageId } from './pipeline';
import { TaskRelationKind } from './relations';
import { WorkItemRef } from './session';
import { TaskKey } from './task';
import { WorkOutage } from './outage';

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
]);
export type InboxKind = z.infer<typeof InboxKind>;

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

export const InboxState = z.enum(['open', 'resolved', 'expired', 'cancelled']);
export type InboxState = z.infer<typeof InboxState>;

/**
 * The rule by which the system resolved an item itself (`resolution.by` is "system"):
 * `command_policy` is the automatic command policy (no publishing from a local-only
 * repository, lockfile installs in a task worktree). The UI names the rule via i18n.
 */
export const InboxResolutionRule = z.enum([
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
]);
export type InboxResolutionRule = z.infer<typeof InboxResolutionRule>;

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
});
export type InboxItem = z.infer<typeof InboxItem>;

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
 * again after one more round. The item is closed by the system when the hold ends otherwise.
 */
export const FixLimitDecisionPayload = z.object({
  taskKey: TaskKey,
  rounds: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  changeRequests: z.number().int().nonnegative(),
  designChangeRequests: z.number().int().nonnegative(),
  sendBacks: z.number().int().nonnegative(),
  reason: z.enum(['no_ai_decider', 'passed_on', 'again']),
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

export const AlertPayload = z.discriminatedUnion('alert', [
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
]);
export type AlertPayload = z.infer<typeof AlertPayload>;

/** The alert payload of an item, or null when it is no alert (or an unreadable or unknown one). */
export function alertPayloadOf(item: Pick<InboxItem, 'kind' | 'payload'>): AlertPayload | null {
  if (item.kind !== 'alert') return null;
  const parsed = AlertPayload.safeParse(item.payload);
  return parsed.success ? parsed.data : null;
}

/**
 * `payload` of a `question` item, written by the `ask_human` team tool. The question is also the
 * item's title; what each option leads to is `consequence` on the item's options. Questions from
 * before the plain-language fields carry only `question` and `options`, and stay valid: everything
 * else is optional.
 */
export const QuestionPayload = z.object({
  question: z.string(),
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
});
export type QuestionPayload = z.infer<typeof QuestionPayload>;

/** The question payload of an item, or null when it has none (or an unreadable one). */
export function questionPayloadOf(item: Pick<InboxItem, 'payload'>): QuestionPayload | null {
  const parsed = QuestionPayload.safeParse(item.payload);
  return parsed.success ? parsed.data : null;
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
