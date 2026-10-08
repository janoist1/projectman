import { z } from 'zod';
import { AgentProvider, MemberHandle } from './member';

/** The most characters of a conversation summary that cross a module (or the engine) boundary (PM-342). */
export const HANDOFF_SUMMARY_MAX = 8000;

/** Why a handover took the transcript summary and not the handing-over member's note (PM-342). */
export const HandoffFallbackReason = z.enum([
  'on_leave',
  'member_removed',
  'no_conversation',
  'provider_changed',
  'provider_limited',
  'not_startable',
  'timeout',
]);
export type HandoffFallbackReason = z.infer<typeof HandoffFallbackReason>;

/**
 * What a conversation's transcript says about where it stood (PM-342): the CLI's own compaction
 * summary and the replies after it (`compact`), or the last replies when there is no compaction
 * (`last_replies`). `at` is the time of the last entry used, when the transcript says.
 */
export const HandoffSummary = z.object({
  source: z.enum(['compact', 'last_replies']),
  text: z.string(),
  at: z.string().nullable(),
});
export type HandoffSummary = z.infer<typeof HandoffSummary>;

/** Why a member's new conversation replaces one that could not go on (PM-342). */
export const PreviousConversationReason = z.enum(['provider_changed', 'lost', 'relocated']);
export type PreviousConversationReason = z.infer<typeof PreviousConversationReason>;

/** How long the new assignee waits for the old one's note before the transcript summary stands in (PM-342, K1). */
export const HANDOFF_TIMEOUT_MS = 10 * 60_000;
/** After the note, the old session has this long to close before it is stopped by force. */
export const HANDOFF_CLOSE_GRACE_MS = 2 * 60_000;
/** The most characters of a handoff note. */
export const HANDOFF_NOTE_MAX = 10_000;

/** What set a handoff off: a person's change, the fix round limit, a removed member, or an automatic assignment. */
export const HandoffReason = z.enum(['manual', 'fix_limit_reassign', 'member_removed', 'auto_assign']);
export type HandoffReason = z.infer<typeof HandoffReason>;

/**
 * Where an open handoff stands: `waiting_point` the old session runs to a safe point, `writing` it was told
 * to write its note, `paused` the team is paused (no deadline runs), `closing` the note (or the fallback)
 * is recorded and the old session closes.
 */
export const HandoffStep = z.enum(['waiting_point', 'writing', 'paused', 'closing']);
export type HandoffStep = z.infer<typeof HandoffStep>;

/** The open handoff of a card (PM-342). Hidden from clients. */
export const TaskHandoff = z.object({
  id: z.string(),
  from: MemberHandle,
  to: MemberHandle.nullable(),
  fromProvider: AgentProvider,
  toProvider: AgentProvider.nullable(),
  reason: HandoffReason,
  step: HandoffStep,
  /** `closing` with the transcript summary standing in for a note. */
  fallbackReason: HandoffFallbackReason.optional(),
  startedAt: z.string(),
  /** Null while it is paused or closing. */
  deadlineAt: z.string().nullable(),
});
export type TaskHandoff = z.infer<typeof TaskHandoff>;

/** The latest closed handoff of a card (PM-342), while the card is still with its receiver. Hidden from clients. */
export const TaskHandoffRef = z.object({
  id: z.string(),
  from: MemberHandle,
  to: MemberHandle.nullable(),
  fromProvider: AgentProvider,
  toProvider: AgentProvider.nullable(),
  outcome: z.enum(['note', 'fallback']),
  fallbackReason: HandoffFallbackReason.optional(),
  endedAt: z.string(),
});
export type TaskHandoffRef = z.infer<typeof TaskHandoffRef>;

/** A closed handoff with its note or summary and the state of the worktree (PM-342). */
export const TaskHandoffRecord = TaskHandoffRef.extend({
  reason: HandoffReason,
  startedAt: z.string(),
  note: z.string().nullable(),
  branch: z.string().nullable(),
  lastCommit: z.string().nullable(),
  uncommitted: z.boolean().nullable(),
  summary: HandoffSummary.nullable(),
});
export type TaskHandoffRecord = z.infer<typeof TaskHandoffRecord>;

/** What a request that changed the assignee started (PM-342): `live` the old session is asked for a note. */
export const HandoffStart = z.object({
  mode: z.enum(['live', 'fallback']),
  from: MemberHandle,
  /** `fallback`: why there is no note. */
  reason: HandoffFallbackReason.optional(),
});
export type HandoffStart = z.infer<typeof HandoffStart>;

/** What `planHandoff` needs to know about the old assignee and their conversation. */
export interface HandoffFacts {
  /** The old assignee now; null when they were removed. */
  from: { kind: 'human' | 'ai'; provider: AgentProvider; onLeave: boolean } | null;
  /** The old assignee's session line on the card; null when they never worked on it. */
  conversation: { provider: AgentProvider; transcript: boolean } | null;
}

export type HandoffPlan = { mode: 'live' } | { mode: 'fallback'; reason: HandoffFallbackReason } | null;

/**
 * How a card changing its assignee is handed over (PM-342): null when there is nothing to hand over,
 * `live` when the old session can be asked for a note, `fallback` with the reason it cannot.
 */
export function planHandoff(facts: HandoffFacts): HandoffPlan {
  if (!facts.conversation) return null;
  if (!facts.from) return { mode: 'fallback', reason: 'member_removed' };
  if (facts.from.kind === 'human') return null;
  if (facts.from.onLeave) return { mode: 'fallback', reason: 'on_leave' };
  if (facts.conversation.provider !== facts.from.provider)
    return { mode: 'fallback', reason: 'provider_changed' };
  if (!facts.conversation.transcript) return { mode: 'fallback', reason: 'no_conversation' };
  return { mode: 'live' };
}

/** Whether an open handoff holds back the start of `handle` (PM-342): the receiver waits for the old session. */
export function handoffBlocksStart(open: Pick<TaskHandoff, 'to'> | undefined, handle: string): boolean {
  return open?.to === handle;
}
