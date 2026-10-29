import { z } from 'zod';
import { EngineId } from './engine';
import { MemberHandle } from './member';
import { TaskKey } from './task';

/**
 * The release of projectman itself (PM-387, PM-491): the Devops proposes it, an owner approves it in
 * the inbox, the release watcher deploys it and tags it. `proposed` waits for the decision; `approved`
 * and `deploying` are the deploy; `failed` and `rejected` end it; `live` runs the commit and still
 * waits for the tag and the GitHub release; `published` is the end.
 */
export const ReleaseState = z.enum([
  'proposed',
  'approved',
  'rejected',
  'deploying',
  'failed',
  'live',
  'published',
]);
export type ReleaseState = z.infer<typeof ReleaseState>;

/** The step of the deploy (or of the publishing) a release failed in. */
export const ReleaseStep = z.enum([
  'fetch',
  'build',
  'test',
  'config_check',
  'pause',
  'stop',
  'backup',
  'switch',
  'verify',
  'rollback',
  'publish',
]);
export type ReleaseStep = z.infer<typeof ReleaseStep>;

export const ReleaseFailure = z.object({
  step: ReleaseStep,
  message: z.string().max(2000),
  /** The previous commit runs again. */
  rolledBack: z.boolean(),
});
export type ReleaseFailure = z.infer<typeof ReleaseFailure>;

export const Release = z.object({
  /** "rel_...". */
  id: z.string(),
  projectKey: z.string(),
  repo: z.string(),
  /** The release card: a theme listing the cards of the release. */
  taskKey: TaskKey,
  state: ReleaseState,
  commit: z.string(),
  /** The commit the release builds on: the last one that went live; null when nothing is known. */
  baseCommit: z.string().nullable(),
  tasks: z.array(TaskKey),
  /** English markdown: the text of the GitHub release. */
  summary: z.string(),
  proposedBy: MemberHandle,
  proposedAt: z.string(),
  decidedBy: MemberHandle.nullable(),
  decidedAt: z.string().nullable(),
  deployStartedAt: z.string().nullable(),
  /** The commit that ran before the deploy: where a rollback goes back to. */
  previousCommit: z.string().nullable(),
  liveAt: z.string().nullable(),
  tag: z.string().nullable(),
  url: z.string().nullable(),
  publishedAt: z.string().nullable(),
  failure: ReleaseFailure.nullable(),
  /** The tag or the GitHub release failed, after the commit went live. */
  publishError: z.string().nullable(),
});
export type Release = z.infer<typeof Release>;

/** `vYYYY.M.D`, with `.N` when the day has more than one release. */
export const RELEASE_TAG_PATTERN = /^v\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/;

/**
 * The tag of a release made on `date` (UTC): `vYYYY.M.D`; when that exists, `vYYYY.M.D.N`, N being the
 * smallest free number from 2.
 */
export function releaseTagName(date: Date, existing: readonly string[]): string {
  const base = `v${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}.${n}`)) n++;
  return `${base}.${n}`;
}

/** What the release watcher reports on the control socket. */
export const ReleaseReport = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('live') }),
  z.object({ outcome: z.literal('failed'), failure: ReleaseFailure }),
  z.object({
    outcome: z.literal('published'),
    tag: z.string().regex(RELEASE_TAG_PATTERN),
    url: z.string(),
  }),
  z.object({ outcome: z.literal('publish_failed'), message: z.string().max(2000) }),
]);
export type ReleaseReport = z.infer<typeof ReleaseReport>;

// ---------------------------------------------------------------------------------------------
// The hybrid release (PM-752): one approved release updates the cloud server and a remote engine, and
// can go back to the previous program version. The cloud holds the durable deployment of an attempt; the
// local coordinator (PM-751) drives it over the protected admin channel. All objects here are strict.
// ---------------------------------------------------------------------------------------------

/** A full git commit id (40 lowercase hex). */
export const ReleaseCommitSha = z.string().regex(/^[0-9a-f]{40}$/);
export type ReleaseCommitSha = z.infer<typeof ReleaseCommitSha>;

/** A SHA-256 digest (64 lowercase hex). */
export const ReleaseHash = z.string().regex(/^[0-9a-f]{64}$/);
export type ReleaseHash = z.infer<typeof ReleaseHash>;

/** The program image of a commit as the Docker daemon names it. */
export const ReleaseImageRef = z.strictObject({
  commit: ReleaseCommitSha,
  imageId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  platform: z.literal('linux/arm64'),
});
export type ReleaseImageRef = z.infer<typeof ReleaseImageRef>;

/** The built image bundle of the release commit: what the coordinator carries to the cloud. */
export const ReleaseArtifact = ReleaseImageRef.extend({
  manifestSha256: ReleaseHash,
  archiveSha256: ReleaseHash,
  archiveBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ReleaseArtifact = z.infer<typeof ReleaseArtifact>;

export const HybridPhase = z.enum([
  'preparing',
  'prepared',
  'quiescing',
  'switching',
  'live',
  'failed',
  'published',
  'recovery_required',
]);
export type HybridPhase = z.infer<typeof HybridPhase>;

/** The phases that hold the instance's one deployment slot (with the maintenance bit, see `isDeploymentActive`). */
const ACTIVE_HYBRID_PHASES: readonly HybridPhase[] = [
  'preparing',
  'prepared',
  'quiescing',
  'switching',
  'recovery_required',
];

/**
 * The codes a recovery may carry: the domain's own refusals and the coordinator's fixed failure kinds. A
 * recovery never carries a raw error, a stack or a secret.
 */
export const HYBRID_RECOVERY_CODES = [
  'release_deployment_conflict',
  'release_target_mismatch',
  'release_pause_conflict',
  'release_not_drained',
  'release_recovery_required',
  'release_protocol_unavailable',
  'release_artifact_changed',
  'release_engine_mismatch',
  'cloud_transport_failed',
  'engine_switch_failed',
  'rollback_failed',
  'database_incompatible',
] as const;
export const HybridRecoveryCode = z.enum(HYBRID_RECOVERY_CODES);
export type HybridRecoveryCode = z.infer<typeof HybridRecoveryCode>;

const HybridRecovery = z.strictObject({
  code: HybridRecoveryCode,
  message: z.string().max(2000),
});
type HybridRecovery = z.infer<typeof HybridRecovery>;

/** The durable deployment of one release attempt (`release_deployments`). */
export const HybridDeployment = z.strictObject({
  version: z.literal(1),
  releaseId: z.string(),
  attemptId: z.uuid(),
  controllerId: z.uuid(),
  targetHash: ReleaseHash,
  engineId: EngineId,
  /** Every accepted change adds one. */
  revision: z.number().int().nonnegative(),
  phase: HybridPhase,
  previousImage: ReleaseImageRef,
  /** The engine's version when the attempt began: the server's own observation, not the caller's word. */
  previousEngineCommit: ReleaseCommitSha,
  previousSchemaVersion: z.number().int().nonnegative(),
  artifact: ReleaseArtifact.nullable(),
  pauseId: z.string().nullable(),
  /** The fence: no new work starts while it is true. */
  maintenance: z.boolean(),
  recovery: HybridRecovery.nullable(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type HybridDeployment = z.infer<typeof HybridDeployment>;

/** Whether the deployment holds the slot: an unfinished phase, or the fence still up. */
export function isDeploymentActive(deployment: Pick<HybridDeployment, 'phase' | 'maintenance'>): boolean {
  return deployment.maintenance || ACTIVE_HYBRID_PHASES.includes(deployment.phase);
}

/** What the drain check counts as still pending, by kind of work. */
export const ReleaseDrainPending = z.strictObject({
  sessions: z.number().int().nonnegative(),
  merges: z.number().int().nonnegative(),
  documentWrites: z.number().int().nonnegative(),
  fullTests: z.number().int().nonnegative(),
  screenshots: z.number().int().nonnegative(),
});
export type ReleaseDrainPending = z.infer<typeof ReleaseDrainPending>;

export const ReleaseDrainStatus = z.strictObject({
  observedAt: z.iso.datetime(),
  /** Nothing is pending, nothing is uncertain and the engine is online. */
  ready: z.boolean(),
  /** Work the server cannot prove finished (an earlier process's run, an engine that is offline). */
  uncertain: z.boolean(),
  engineOnline: z.boolean(),
  pending: ReleaseDrainPending,
});
export type ReleaseDrainStatus = z.infer<typeof ReleaseDrainStatus>;

/** A report names the image that runs afterwards: the new one when it went live, the old one after a rollback. */
const reportImageRule = (
  change: { report: ReleaseReport; image?: ReleaseImageRef | undefined },
  context: z.RefinementCtx,
) => {
  const { report, image } = change;
  const needsImage =
    report.outcome === 'live' || (report.outcome === 'failed' && report.failure.rolledBack === true);
  if (needsImage && !image)
    context.addIssue({ code: 'custom', path: ['image'], message: 'the report needs the image that runs' });
  if (!needsImage && image)
    context.addIssue({ code: 'custom', path: ['image'], message: 'this report takes no image' });
};

/** One accepted change of a deployment (`release_deploy_change`). */
export const ReleaseDeploymentChange = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared'), artifact: ReleaseArtifact }),
  z.strictObject({ kind: z.literal('quiesce') }),
  z.strictObject({ kind: z.literal('switch') }),
  z
    .strictObject({
      kind: z.literal('report'),
      report: ReleaseReport,
      image: ReleaseImageRef.optional(),
    })
    .superRefine(reportImageRule),
  z.strictObject({ kind: z.literal('resume'), pauseId: z.string() }),
  z.strictObject({ kind: z.literal('recovery'), code: HybridRecoveryCode, message: z.string().max(2000) }),
]);
export type ReleaseDeploymentChange = z.infer<typeof ReleaseDeploymentChange>;

/** `release_deploy_begin` without its `op`. */
export const ReleaseDeployBegin = z.strictObject({
  releaseId: z.string(),
  attemptId: z.uuid(),
  controllerId: z.uuid(),
  requestId: z.uuid(),
  targetHash: ReleaseHash,
  engineId: EngineId,
  previousImage: ReleaseImageRef,
});
export type ReleaseDeployBegin = z.infer<typeof ReleaseDeployBegin>;

/** `release_deploy_change` without its `op`. */
export const ReleaseDeployChange = z.strictObject({
  releaseId: z.string(),
  attemptId: z.uuid(),
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  change: ReleaseDeploymentChange,
});
export type ReleaseDeployChange = z.infer<typeof ReleaseDeployChange>;

/** The configured hybrid binding of an instance (`PROJECTMAN_RELEASE_ENGINE_ID`, `PROJECTMAN_RELEASE_TARGET_HASH`). */
export const HybridReleaseTarget = z.strictObject({
  /** A remote engine only. */
  engineId: EngineId.refine((id) => id !== 'local', 'a remote engine is needed'),
  targetHash: ReleaseHash,
});
export type HybridReleaseTarget = z.infer<typeof HybridReleaseTarget>;
