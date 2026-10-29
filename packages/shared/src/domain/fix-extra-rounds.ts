/**
 * The most extra rounds ("one more round") the lead developer may hand out within one count (PM-714): after
 * that, every time the card reaches the limit a person decides. A fixed rule, not a project setting. People
 * may allow more; the stored count is never cut to this value. A leaf module, so `task.ts` and `inbox.ts`
 * can name it without importing the fix limit's rules (PM-1114).
 */
export const MAX_FIX_EXTRA_ROUNDS = 3 as const;
