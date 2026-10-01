import { z } from 'zod';
import { Actor } from './event';
import { LabelId } from './label';
import { MemberHandle } from './member';
import { StageId } from './pipeline';
import { WorkItemRef } from './session';
import { TaskKey } from './task';

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
export const InboxKind = z.enum(['permission', 'decision', 'question', 'approval', 'boundary', 'alert']);
export type InboxKind = z.infer<typeof InboxKind>;

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
export const InboxResolutionRule = z.enum(['command_policy']);
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
});
export type GateRequestPayload = z.infer<typeof GateRequestPayload>;

/** The gate request of a decision item, or null when the item has none (or an unreadable one). */
export function gateRequestOf(item: Pick<InboxItem, 'payload'>): GateRequestPayload | null {
  const parsed = GateRequestPayload.safeParse(item.payload.gate);
  return parsed.success ? parsed.data : null;
}

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

export const AlertPayload = z.discriminatedUnion('alert', [SessionTokensAlert]);
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
