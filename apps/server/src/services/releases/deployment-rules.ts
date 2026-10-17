import { createHash } from 'node:crypto';
import { ACTIVE_HYBRID_PHASES } from '@projectman/shared';
import type {
  HybridDeployment,
  HybridPhase,
  Release,
  ReleaseArtifact,
  ReleaseDeploymentChange,
  ReleaseImageRef,
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

/** The phase a change leads to, or null when the change is not allowed from the deployment's phase. */
export function nextPhase(
  deployment: Pick<HybridDeployment, 'phase' | 'maintenance'>,
  change: ReleaseDeploymentChange,
  release: Pick<Release, 'state'>,
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
      return phase === 'live' || phase === 'failed' || phase === 'published' ? null : 'recovery_required';
    case 'resume':
      return SETTLED_PHASES.includes(phase) && deployment.maintenance ? phase : null;
    case 'report': {
      const { report } = change;
      switch (report.outcome) {
        case 'live':
          if (phase === 'switching') return 'live';
          // A recovery that was opened by hand (the release is still deploying) may end with the new program running.
          return phase === 'recovery_required' && release.state === 'deploying' ? 'live' : null;
        case 'failed':
          // Without a confirmed rollback the previous program is not known to run: a person has to look.
          return ACTIVE_HYBRID_PHASES.includes(phase)
            ? report.failure.rolledBack
              ? 'failed'
              : 'recovery_required'
            : null;
        case 'published':
          return phase === 'live' ? 'published' : null;
        case 'publish_failed':
          return phase === 'live' ? 'live' : null;
      }
    }
  }
}
