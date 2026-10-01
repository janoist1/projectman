import { describe, expect, it } from 'vitest';
import {
  CACHE_READ_WEIGHT,
  limitTokens,
  mergeTokenUsage,
  tokenTotal,
  UsageSummary,
  usageTotal,
} from './token-usage';
import type { TokenUsage } from './token-usage';

const row = (model: string, scope: TokenUsage['scope'], n: number): TokenUsage => ({
  model,
  scope,
  input: n,
  output: 2 * n,
  cacheRead: 3 * n,
  cacheWrite: 4 * n,
});

describe('token usage (PM-178)', () => {
  it('adds up rows of the same model and scope: own conversation first, then the subagents', () => {
    expect(
      mergeTokenUsage([
        row('haiku', 'subagent', 1),
        row('opus', 'main', 1),
        row('haiku', 'main', 2),
        row('opus', 'main', 10),
        row('haiku', 'subagent', 5),
      ]),
    ).toEqual([row('haiku', 'main', 2), row('opus', 'main', 11), row('haiku', 'subagent', 6)]);
  });

  it('sums every kind of every row', () => {
    const total = usageTotal([row('opus', 'main', 1), row('haiku', 'subagent', 2)]);
    expect(total).toEqual({ input: 3, output: 6, cacheRead: 9, cacheWrite: 12 });
    expect(tokenTotal(total)).toBe(30);
    expect(usageTotal([])).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('counts cache reads at a tenth toward the warning limit, rounded (PM-187)', () => {
    expect(CACHE_READ_WEIGHT).toBe(0.1);
    expect(limitTokens({ input: 100, output: 20, cacheRead: 1_000, cacheWrite: 3 })).toBe(223);
    expect(limitTokens({ input: 0, output: 0, cacheRead: 15, cacheWrite: 0 })).toBe(2);
    expect(limitTokens({ input: 0, output: 0, cacheRead: 14, cacheWrite: 0 })).toBe(1);
    expect(limitTokens(usageTotal([row('opus', 'main', 10), row('haiku', 'subagent', 10)]))).toBe(
      20 + 40 + 80 + 6,
    );
  });

  it('accepts only whole, non-negative counts', () => {
    expect(UsageSummary.safeParse({ since: '2026-10-01', rows: [row('opus', 'main', 1)] }).success).toBe(
      true,
    );
    expect(UsageSummary.safeParse({ since: '2026-10-01', rows: [row('opus', 'main', -1)] }).success).toBe(
      false,
    );
    expect(UsageSummary.safeParse({ since: '2026-10-01', rows: [row('opus', 'main', 0.5)] }).success).toBe(
      false,
    );
  });
});
