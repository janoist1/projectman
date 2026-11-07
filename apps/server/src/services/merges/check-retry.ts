import type { CheckInfraCause, MergeCheckRunner } from '@projectman/shared';
import type { FullTestResult } from '../../contracts';

const MERGE_CHECK_ATTEMPTS = 4;
const MERGE_CHECK_RETRY_DELAYS_MS = [5, 15, 30].map((minutes) => minutes * 60_000);
export const GITHUB_RUNNER_OUTAGE_MS = 30 * 60_000;

export interface MergeCheckRetry {
  attempt: number;
  cause: CheckInfraCause;
  at: string;
  runner: MergeCheckRunner;
  lastRunId: string;
  lastUrl?: string;
}

export function nextCheckAttempt(input: {
  previous: MergeCheckRetry | undefined;
  result: Pick<FullTestResult, 'outcome' | 'infra'>;
  ranOn: MergeCheckRunner;
  runId: string;
  url?: string;
  fallback: boolean;
  now: Date;
}):
  | { kind: 'retry'; retry: MergeCheckRetry }
  | { kind: 'exhausted'; attempts: number; cause: CheckInfraCause }
  | null {
  if (input.result.outcome !== 'error' || !input.result.infra) return null;
  const attempt = (input.previous?.attempt ?? 1) + 1;
  if (attempt > MERGE_CHECK_ATTEMPTS)
    return { kind: 'exhausted', attempts: attempt - 1, cause: input.result.infra };
  const fallback = input.ranOn === 'github_actions' && input.fallback;
  return {
    kind: 'retry',
    retry: {
      attempt,
      cause: input.result.infra,
      at: new Date(
        input.now.getTime() + (fallback ? 0 : MERGE_CHECK_RETRY_DELAYS_MS[attempt - 2]!),
      ).toISOString(),
      runner: fallback ? 'engine' : input.ranOn,
      lastRunId: input.runId,
      ...(input.url ? { lastUrl: input.url } : {}),
    },
  };
}

export function githubRunnerOutage(
  latest: { infra: CheckInfraCause | null; finishedAt: string | null } | null,
  now: Date,
): boolean {
  if (
    !latest?.finishedAt ||
    (latest.infra !== 'runner_not_acquired' && latest.infra !== 'service_unreachable')
  )
    return false;
  const age = now.getTime() - Date.parse(latest.finishedAt);
  return age >= 0 && age < GITHUB_RUNNER_OUTAGE_MS;
}

export function waitingForRetry(row: { retry?: Pick<MergeCheckRetry, 'at'> }, now: Date): boolean {
  return !!row.retry && Date.parse(row.retry.at) > now.getTime();
}

export function checkRetryNote(retry: MergeCheckRetry): string {
  const where = retry.runner === 'engine' ? "the card engine's sandbox" : 'GitHub Actions';
  return `Merge check ${retry.lastRunId} could not run (${retry.cause}: ${retry.lastUrl ?? retry.lastRunId}); attempt ${retry.attempt} of ${MERGE_CHECK_ATTEMPTS} starts at ${retry.at} on ${where}.`;
}

export function checkInfraMessage(attempts: number, cause: CheckInfraCause, lastRun: string): string {
  return `the merge check's runner stayed unavailable after ${attempts} attempts (${cause}); last run: ${lastRun}`;
}

export function checkFallbackNote(
  runId: string,
  repo: string,
  latest: { id: string; url: string | null; finishedAt: string | null },
): string {
  return `Merge check ${runId} runs on the card engine's sandbox: GitHub Actions had no runner for ${repo} (run ${latest.url ?? latest.id}, ${latest.finishedAt}).`;
}
