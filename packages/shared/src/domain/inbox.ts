import { z } from 'zod';
import { Actor } from './event';
import { LabelId } from './label';
import { MemberHandle } from './member';
import { StageId } from './pipeline';
import { TaskKey } from './task';

/**
 * Items waiting for a human ("Rád vár" in the UI):
 * - permission: a Claude Code tool permission request (PermissionRequest hook)
 * - decision:   a gate that needs a human approval (merge, release, ...)
 * - question:   an AI member asked a human something (ask_human tool)
 * - approval:   a proposed change (e.g. an email draft or a config change)
 */
export const InboxKind = z.enum(['permission', 'decision', 'question', 'approval']);
export type InboxKind = z.infer<typeof InboxKind>;

export const InboxOption = z.object({
  id: z.string(),
  /** Option ids for built-in kinds are fixed ("allow", "allow_session", "deny", "approve", "reject");
   *  free-text labels come from agents (question options) and are data. */
  label: z.string(),
  style: z.enum(['primary', 'secondary', 'danger']),
});
export type InboxOption = z.infer<typeof InboxOption>;

export const InboxState = z.enum(['open', 'resolved', 'expired', 'cancelled']);
export type InboxState = z.infer<typeof InboxState>;

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
      note: z.string().nullable(),
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
