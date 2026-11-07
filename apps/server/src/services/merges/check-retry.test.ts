import { describe, expect, it } from 'vitest';
import type { CheckInfraCause } from '@projectman/shared';
import { githubRunnerOutage, nextCheckAttempt, GITHUB_RUNNER_OUTAGE_MS } from './check-retry';
import type { MergeCheckRetry } from './check-retry';

const now = new Date('2026-11-06T21:00:00Z');
const input = {
  previous: undefined,
  result: { outcome: 'error' as const, infra: 'runner_not_acquired' as const },
  ranOn: 'github_actions' as const,
  runId: 'run',
  fallback: false,
  now,
};

describe('merge check retry policy', () => {
  it.each(['passed', 'failed'] as const)('does not retry a %s verdict even with infra', (outcome) => {
    expect(nextCheckAttempt({ ...input, result: { ...input.result, outcome } })).toBeNull();
  });
  it('does not retry an error without a classified infrastructure cause', () => {
    expect(nextCheckAttempt({ ...input, result: { outcome: 'error' } })).toBeNull();
  });
  it('immediately requests the engine sandbox after a GitHub infrastructure fault', () => {
    expect(nextCheckAttempt({ ...input, fallback: true })).toMatchObject({
      kind: 'retry',
      retry: { attempt: 2, runner: 'engine', at: now.toISOString(), lastRunId: 'run' },
    });
  });
  it.each([
    [undefined, 2, 5],
    [2, 3, 15],
    [3, 4, 30],
  ] as const)('delays attempt after %s by %s / %s minutes', (previousAttempt, attempt, minutes) => {
    const previous = previousAttempt ? ({ attempt: previousAttempt } as MergeCheckRetry) : undefined;
    expect(nextCheckAttempt({ ...input, previous })).toMatchObject({
      kind: 'retry',
      retry: {
        attempt,
        runner: 'github_actions',
        at: new Date(now.getTime() + minutes * 60_000).toISOString(),
      },
    });
  });
  it('exhausts after four attempts even with a fallback', () => {
    expect(
      nextCheckAttempt({ ...input, previous: { attempt: 4 } as MergeCheckRetry, fallback: true }),
    ).toEqual({ kind: 'exhausted', attempts: 4, cause: 'runner_not_acquired' });
  });
  it.each(['runner_not_acquired', 'service_unreachable'] as CheckInfraCause[])(
    'opens the breaker for %s until its deadline',
    (infra) => {
      const latest = { infra, finishedAt: now.toISOString() };
      expect(githubRunnerOutage(latest, now)).toBe(true);
      expect(githubRunnerOutage(latest, new Date(now.getTime() + GITHUB_RUNNER_OUTAGE_MS))).toBe(false);
    },
  );
  it.each([null, 'verdict_missing'] as const)('keeps the breaker closed for %s', (infra) => {
    expect(githubRunnerOutage({ infra, finishedAt: now.toISOString() }, now)).toBe(false);
  });
  it('keeps the breaker closed without a finished check', () => {
    expect(githubRunnerOutage(null, now)).toBe(false);
    expect(githubRunnerOutage({ infra: 'runner_not_acquired', finishedAt: null }, now)).toBe(false);
  });
});
