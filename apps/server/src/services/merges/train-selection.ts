import type { ReviewTestConfig } from '@projectman/shared';
import type { MergeTrainMember } from '../../db';

/** Caller-supplied readiness and source facts, in the repository's queue order. */
export type MergeTrainCandidate = MergeTrainMember & {
  projectKey: string;
  repo: string;
  base: string;
  engineId: string;
  reviewTest?: ReviewTestConfig;
  eligible: boolean;
  solo: boolean;
  diagnostic?: { parentTrainId: string; maxCards: number };
};

function limit(candidate: MergeTrainCandidate): number {
  const max = candidate.diagnostic ? candidate.diagnostic.maxCards : 8;
  return Number.isInteger(max) && max >= 1 && max <= 8 ? max : 0;
}

/** Selects only the compatible prefix; the caller sends a singleton down the individual path. */
export function selectMergeTrain(queued: readonly MergeTrainCandidate[]): string[] {
  const first = queued[0];
  if (!first?.eligible || limit(first) === 0) return [];
  const selected = [first.mergeId];
  if (first.solo || !first.reviewTest) return selected;
  let maxCards = limit(first);
  for (const next of queued.slice(1)) {
    if (selected.length >= maxCards) break;
    if (
      !next.eligible ||
      next.solo ||
      !next.reviewTest ||
      next.projectKey !== first.projectKey ||
      next.repo !== first.repo ||
      next.base !== first.base ||
      next.engineId !== first.engineId ||
      next.reviewTest.command !== first.reviewTest.command ||
      next.reviewTest.maxWorkers !== first.reviewTest.maxWorkers ||
      next.reviewTest.timeoutMinutes !== first.reviewTest.timeoutMinutes ||
      (next.reviewTest.runner ?? 'engine') !== (first.reviewTest.runner ?? 'engine') ||
      Boolean(next.diagnostic) !== Boolean(first.diagnostic) ||
      next.diagnostic?.parentTrainId !== first.diagnostic?.parentTrainId
    )
      break;
    const nextLimit = limit(next);
    if (selected.length >= nextLimit) break;
    maxCards = Math.min(maxCards, nextLimit);
    selected.push(next.mergeId);
  }
  return selected;
}
