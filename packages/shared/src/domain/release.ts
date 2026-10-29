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

// Retired cloud configuration is still accepted for compatibility; deployment ignores this binding.
export const HybridReleaseTarget = z.strictObject({
  /** A remote engine only. */
  engineId: EngineId.refine((id) => id !== 'local', 'a remote engine is needed'),
  targetHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type HybridReleaseTarget = z.infer<typeof HybridReleaseTarget>;
