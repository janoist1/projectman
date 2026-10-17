import { createHash } from 'node:crypto';
import type {
  HybridDeployment,
  HybridPhase,
  HybridRecoveryCode,
  Release,
  ReleaseArtifact,
  ReleaseDeploymentChange,
  ReleaseFailure,
  ReleaseImageRef,
  ReleaseStep,
} from '@projectman/shared';
import { conflict } from '../../kernel';

/** JSON with sorted keys: the same value always has the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What identifies a request: a repeat with the same id must carry the same payload. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function sameImage(a: ReleaseImageRef, b: ReleaseImageRef): boolean {
  return a.commit === b.commit && a.imageId === b.imageId && a.platform === b.platform;
}

export function sameArtifact(a: ReleaseArtifact, b: ReleaseArtifact): boolean {
  return (
    sameImage(a, b) &&
    a.manifestSha256 === b.manifestSha256 &&
    a.archiveSha256 === b.archiveSha256 &&
    a.archiveBytes === b.archiveBytes
  );
}

/** The phases a deployment ended in; only the fence (`maintenance`) keeps one of them active. */
export const SETTLED_PHASES: readonly HybridPhase[] = ['live', 'failed', 'published'];

export function phaseConflict(deployment: HybridDeployment, what: string) {
  return conflict(
    'release_deployment_conflict',
    `cannot ${what}: the deployment of release ${deployment.releaseId} is ${deployment.phase}`,
    { releaseId: deployment.releaseId, phase: deployment.phase, revision: deployment.revision },
  );
}

/**
 * Which program must run on both targets for a state to be accepted: the release's own commit after a switch,
 * the previous one after a rollback or before anything was switched. The cloud server and the remote engine
 * are two separate facts, checked separately.
 */
export interface ExpectedTargets {
  which: 'new' | 'previous';
  cloudCommit: string;
  engineCommit: string;
}

export function expectedTargets(
  deployment: HybridDeployment,
  release: Pick<Release, 'commit'>,
  which: 'new' | 'previous',
): ExpectedTargets {
  return which === 'new'
    ? { which, cloudCommit: release.commit, engineCommit: release.commit }
    : { which, cloudCommit: deployment.previousImage.commit, engineCommit: deployment.previousEngineCommit };
}

/** What the end of a settled phase stands for: a live or published release runs the new program, a failed one the old. */
export function settledTargets(
  deployment: HybridDeployment,
  release: Pick<Release, 'commit'>,
): ExpectedTargets {
  return expectedTargets(deployment, release, deployment.phase === 'failed' ? 'previous' : 'new');
}

/** What the approvers read when a deployment needs recovery: the step the code stands for, never a raw error. */
export function recoveryFailure(code: HybridRecoveryCode, message: string): ReleaseFailure {
  const step: ReleaseStep =
    code === 'rollback_failed'
      ? 'rollback'
      : code === 'engine_switch_failed' || code === 'cloud_transport_failed'
        ? 'switch'
        : 'verify';
  return { step, message, rolledBack: false };
}

/** The phase a change leads to, or null when the change is not allowed from the deployment's phase. */
export function nextPhase(
  deployment: Pick<HybridDeployment, 'phase' | 'maintenance'>,
  change: ReleaseDeploymentChange,
): HybridPhase | null {
  const { phase } = deployment;
  switch (change.kind) {
    case 'prepared':
      return phase === 'preparing' ? 'prepared' : null;
    case 'quiesce':
      return phase === 'prepared' ? 'quiescing' : null;
    case 'switch':
      return phase === 'quiescing' ? 'switching' : null;
    case 'recovery':
      // Only an attempt that reached the pause can need one: before it a failure ends the attempt (`failed`). A live
      // deployment qualifies while its fence is up; once resumed it has left the slot.
      if (phase === 'quiescing' || phase === 'switching' || phase === 'recovery_required')
        return 'recovery_required';
      return phase === 'live' && deployment.maintenance ? 'recovery_required' : null;
    case 'resume':
      return SETTLED_PHASES.includes(phase) && deployment.maintenance ? phase : null;
    case 'report': {
      const { report } = change;
      switch (report.outcome) {
        case 'live':
          // A deployment in recovery_required is settled by a person, not by a report of the coordinator.
          return phase === 'switching' ? 'live' : null;
        case 'failed':
          // Before the pause nothing was touched: the attempt just ends. From the pause on, without a confirmed
          // rollback the previous program is not known to run, and a person has to look.
          if (phase === 'preparing' || phase === 'prepared') return 'failed';
          if (phase === 'quiescing' || phase === 'switching')
            return report.failure.rolledBack ? 'failed' : 'recovery_required';
          return null;
        case 'published':
          return phase === 'live' ? 'published' : null;
        case 'publish_failed':
          return phase === 'live' ? 'live' : null;
      }
    }
  }
}
