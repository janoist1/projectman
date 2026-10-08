import { z } from 'zod';

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
