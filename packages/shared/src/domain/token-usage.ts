import { z } from 'zod';

/**
 * Token usage of AI sessions (PM-178), read by the runner from the agent CLI's transcript: per
 * model, with what the session's subagents used on rows of their own. Counts only, no money.
 */

/** Whose calls the tokens went to: the session's own conversation, or one of its subagents. */
export const TokenUsageScope = z.enum(['main', 'subagent']);
export type TokenUsageScope = z.infer<typeof TokenUsageScope>;

const Count = z.number().int().nonnegative();

/**
 * Tokens of the four kinds: uncached input, output, input read from the prompt cache and input
 * written to it. Codex counts cached input inside its input: here it is only in `cacheRead`.
 */
export const TokenCounts = z.object({
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
});
export type TokenCounts = z.infer<typeof TokenCounts>;

/** Tokens one model used in one scope. */
export const TokenUsage = TokenCounts.extend({
  model: z.string(),
  scope: TokenUsageScope,
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** What a session used since its usage is measured. */
export const UsageSummary = z.object({
  /**
   * Since when the session's usage is counted (ISO time): its start, or, for a session from before
   * the measurement existed that was resumed later, that resume. Earlier usage is not included.
   */
  since: z.string(),
  rows: z.array(TokenUsage),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

/** What a member's sessions used in the last 24 hours and the last 7 days (hourly granularity). */
export const MemberUsage = z.object({
  lastDay: z.array(TokenUsage),
  lastWeek: z.array(TokenUsage),
});
export type MemberUsage = z.infer<typeof MemberUsage>;

export const EMPTY_TOKEN_COUNTS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** All four kinds together. */
export function tokenTotal(counts: TokenCounts): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

/**
 * What a token read from the prompt cache counts in `limitTokens`: a tenth, as it is priced at a
 * tenth of uncached input by both Anthropic and OpenAI.
 */
export const CACHE_READ_WEIGHT = 0.1;

/**
 * The tokens a session's warning limit (PM-187) is measured in: input, output and cache writes in
 * full, cache reads at `CACHE_READ_WEIGHT`. A long session re-reads its whole conversation from the
 * cache every turn: in full those reads would drown the rest, left out they would hide a session
 * whose context grew large.
 */
export function limitTokens(counts: TokenCounts): number {
  return counts.input + counts.output + counts.cacheWrite + Math.round(counts.cacheRead * CACHE_READ_WEIGHT);
}

/** The sum of usage rows, of every model and scope. */
export function usageTotal(rows: readonly TokenCounts[]): TokenCounts {
  return rows.reduce<TokenCounts>(addTokenCounts, EMPTY_TOKEN_COUNTS);
}

/**
 * Adds up rows of the same model and scope: the main conversation first, then the subagents,
 * each by model name.
 */
export function mergeTokenUsage(rows: readonly TokenUsage[]): TokenUsage[] {
  const merged = new Map<string, TokenUsage>();
  for (const row of rows) {
    const key = `${row.scope}\u0000${row.model}`;
    const before = merged.get(key);
    merged.set(key, before ? { ...before, ...addTokenCounts(before, row) } : { ...row });
  }
  return [...merged.values()].sort(
    (a, b) =>
      (a.scope === b.scope ? 0 : a.scope === 'main' ? -1 : 1) ||
      (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
  );
}
