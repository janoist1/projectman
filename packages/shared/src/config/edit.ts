import { z } from 'zod';
import { FeedbackConfig } from '../domain/feedback';
import { normalizeFeedbackOrigin } from '../domain/feedback-origin';
import { Pipeline } from '../domain/pipeline';
import { BuiltInRoleId, RoleBundle } from '../domain/role';
import { RepoDocs } from './project-docs';
import { OperatorWatch } from './operator-watch';
import {
  AutoCompactWindowTokens,
  MaxConcurrentAi,
  ProjectConfig,
  ReviewTestConfig,
  TeamLimits,
  WarnAboveSessionTokens,
} from './schema';

const tempWorkersSchema = TeamLimits.shape.tempWorkers.removeDefault();

/** A repository's full test as an edit sets it (PM-538): the whole object, the command trimmed, unknown keys refused. */
export const ReviewTestPatch = ReviewTestConfig.extend({
  command: z.string().trim().min(1).max(500),
}).strict();
export type ReviewTestPatch = z.infer<typeof ReviewTestPatch>;

/** PATCH fields deliberately omit defaults so partial edits retain existing values. */
export const PatchConfigRequest = z
  .object({
    baseVersion: z.string().min(1),
    message: z.string().trim().min(1).max(500).optional(),
    project: ProjectConfig.shape.project
      .pick({ name: true, language: true, timezone: true })
      .extend({
        language: ProjectConfig.shape.project.shape.language.removeDefault(),
        timezone: ProjectConfig.shape.project.shape.timezone.removeDefault(),
      })
      .partial()
      .strict()
      .optional(),
    limits: TeamLimits.extend({
      aiEnabled: TeamLimits.shape.aiEnabled.removeDefault(),
      /** null removes the cap (no limit). */
      maxConcurrentAi: MaxConcurrentAi.nullable(),
      /** null removes the warning limit (no warning). */
      warnAboveSessionTokens: WarnAboveSessionTokens.nullable(),
      /** null removes the project's compaction window (the default applies). */
      autoCompactWindowTokens: AutoCompactWindowTokens.nullable(),
      pauseAbovePlanUsagePercent: TeamLimits.shape.pauseAbovePlanUsagePercent.removeDefault(),
      minFreeDiskGb: TeamLimits.shape.minFreeDiskGb.removeDefault(),
      tempWorkers: tempWorkersSchema
        .extend({
          enabled: tempWorkersSchema.shape.enabled.removeDefault(),
          max: tempWorkersSchema.shape.max.removeDefault(),
          role: tempWorkersSchema.shape.role.removeDefault(),
        })
        .partial()
        .strict()
        .optional(),
    })
      .partial()
      .strict()
      .optional(),
    roleOverrides: ProjectConfig.shape.team.shape.roleOverrides,
    roles: ProjectConfig.shape.team.shape.roles.removeDefault().optional(),
    releaseFourEyes: z.boolean().optional(),
    operatorWatch: OperatorWatch.nullable().optional(),
    cardMover: ProjectConfig.shape.team.shape.cardMover,
    merger: ProjectConfig.shape.team.shape.merger,
    /** Per repository: whether a card's work must be merged (`requireMerge`); null removes the explicit value. */
    repoMerge: z
      .array(z.object({ repo: z.string(), requireMerge: z.boolean().nullable() }))
      .max(20)
      .optional(),
    /** Per repository: where the project documents live (PM-494); null removes the setting. */
    repoDocs: z
      .array(z.object({ repo: z.string(), docs: RepoDocs.nullable() }).strict())
      .max(20)
      .optional(),
    /** Per repository: the full test the server runs (`reviewTest`, PM-538); null removes it. Owner-only (`review_test`). */
    repoReviewTest: z
      .array(z.object({ repo: z.string(), reviewTest: ReviewTestPatch.nullable() }).strict())
      .max(20)
      .optional(),
    /** Per repository: whether the full test runs only at the merge (`fullTestAtMerge`, PM-386); null removes it. Owner-only (`review_test`). */
    repoFullTestAtMerge: z
      .array(z.object({ repo: z.string(), fullTestAtMerge: z.boolean().nullable() }).strict())
      .max(20)
      .optional(),
    boundary: ProjectConfig.shape.team.shape.boundary,
    /** The feedback tool (PM-506): each list present replaces the whole list. */
    feedback: z
      .strictObject({
        surfaces: FeedbackConfig.shape.surfaces.removeDefault().optional(),
        blockedMarkers: FeedbackConfig.shape.blockedMarkers.removeDefault().optional(),
      })
      .optional(),
    pipeline: Pipeline.optional(),
  })
  .strict();
export type PatchConfigRequest = z.infer<typeof PatchConfigRequest>;

/** Operator edits replace or explicitly reset only the named built-in roles. */
export const OperatorRoleOverridesPatch = z.partialRecord(BuiltInRoleId, RoleBundle.nullable());
export type OperatorRoleOverridesPatch = z.infer<typeof OperatorRoleOverridesPatch>;

export const OperatorConfigPatch = PatchConfigRequest.omit({ baseVersion: true, message: true }).extend({
  roleOverrides: OperatorRoleOverridesPatch.optional(),
});
export type OperatorConfigPatch = z.infer<typeof OperatorConfigPatch>;

/** Expand against the same configuration version that the normal PATCH will check under its lock. */
export function prepareOperatorConfigPatch(
  config: ProjectConfig,
  baseVersion: string,
  patch: OperatorConfigPatch,
): PatchConfigRequest {
  const { roleOverrides: changes, ...rest } = patch;
  if (!changes || Object.keys(changes).length === 0) return { ...rest, baseVersion };
  const roleOverrides = { ...config.team.roleOverrides };
  for (const role of BuiltInRoleId.options) {
    const bundle = changes[role];
    if (bundle === null) delete roleOverrides[role];
    else if (bundle !== undefined) roleOverrides[role] = bundle;
  }
  return { ...rest, roleOverrides, baseVersion };
}

/** Schema failures share the same issue list shape as invariant failures. */
export function configSchemaIssues(issues: readonly { code: string; path: readonly PropertyKey[] }[]) {
  return issues.map(({ code, path }) => ({ code, path: path.map(String).join('.') }));
}

/**
 * The first repository of `repoMerge`, `repoDocs`, `repoReviewTest` or `repoFullTestAtMerge` (in this order)
 * that the configuration does not know (the edit answers `unknown_repo`); null: none.
 */
export function unknownPatchRepo(
  config: Pick<ProjectConfig, 'project'>,
  patch: PatchConfigRequest,
): string | null {
  const known = new Set(config.project.repos.map((repo) => repo.name));
  return (
    patch.repoMerge?.find((entry) => !known.has(entry.repo))?.repo ??
    patch.repoDocs?.find((entry) => !known.has(entry.repo))?.repo ??
    patch.repoReviewTest?.find((entry) => !known.has(entry.repo))?.repo ??
    patch.repoFullTestAtMerge?.find((entry) => !known.has(entry.repo))?.repo ??
    null
  );
}

export function applyConfigPatch(config: ProjectConfig, patch: PatchConfigRequest): ProjectConfig {
  const team = { ...config.team };
  if (patch.operatorWatch === null) delete team.operatorWatch;
  else if (patch.operatorWatch !== undefined) team.operatorWatch = patch.operatorWatch;
  const { maxConcurrentAi, warnAboveSessionTokens, autoCompactWindowTokens, ...limitChanges } =
    patch.limits ?? {};
  const limits: TeamLimits = {
    ...config.team.limits,
    ...limitChanges,
    tempWorkers: { ...config.team.limits.tempWorkers, ...patch.limits?.tempWorkers },
  };
  if (maxConcurrentAi === null) delete limits.maxConcurrentAi;
  else if (maxConcurrentAi !== undefined) limits.maxConcurrentAi = maxConcurrentAi;
  if (warnAboveSessionTokens === null) delete limits.warnAboveSessionTokens;
  else if (warnAboveSessionTokens !== undefined) limits.warnAboveSessionTokens = warnAboveSessionTokens;
  if (autoCompactWindowTokens === null) delete limits.autoCompactWindowTokens;
  else if (autoCompactWindowTokens !== undefined) limits.autoCompactWindowTokens = autoCompactWindowTokens;
  // The last entry for a repository wins.
  const repoMerge = patch.repoMerge && new Map(patch.repoMerge.map((e) => [e.repo, e.requireMerge] as const));
  const repoDocs = patch.repoDocs && new Map(patch.repoDocs.map((e) => [e.repo, e.docs] as const));
  const repoReviewTest =
    patch.repoReviewTest && new Map(patch.repoReviewTest.map((e) => [e.repo, e.reviewTest] as const));
  const repoFullTestAtMerge =
    patch.repoFullTestAtMerge &&
    new Map(patch.repoFullTestAtMerge.map((e) => [e.repo, e.fullTestAtMerge] as const));
  const feedback = patch.feedback
    ? {
        surfaces: (patch.feedback.surfaces ?? config.project.feedback?.surfaces ?? []).map((surface) => ({
          ...surface,
          origin: normalizeFeedbackOrigin(surface.origin) ?? surface.origin,
        })),
        blockedMarkers: patch.feedback.blockedMarkers ?? config.project.feedback?.blockedMarkers ?? [],
      }
    : undefined;
  return {
    ...config,
    project: {
      ...config.project,
      ...patch.project,
      ...(feedback ? { feedback } : {}),
      repos:
        repoMerge || repoDocs || repoReviewTest || repoFullTestAtMerge
          ? config.project.repos.map((repo) => {
              let changed = repo;
              const merge = repoMerge?.get(repo.name);
              if (merge !== undefined) {
                const { requireMerge: _previous, ...rest } = changed;
                changed = merge === null ? rest : { ...rest, requireMerge: merge };
              }
              const docs = repoDocs?.get(repo.name);
              if (docs !== undefined) {
                const { docs: _previous, ...rest } = changed;
                changed = docs === null ? rest : { ...rest, docs };
              }
              const reviewTest = repoReviewTest?.get(repo.name);
              if (reviewTest !== undefined) {
                const { reviewTest: _previous, ...rest } = changed;
                changed = reviewTest === null ? rest : { ...rest, reviewTest };
              }
              const fullTestAtMerge = repoFullTestAtMerge?.get(repo.name);
              if (fullTestAtMerge !== undefined) {
                const { fullTestAtMerge: _previous, ...rest } = changed;
                changed = fullTestAtMerge === null ? rest : { ...rest, fullTestAtMerge };
              }
              return changed;
            })
          : config.project.repos,
    },
    team: {
      ...team,
      ...(patch.cardMover !== undefined ? { cardMover: patch.cardMover } : {}),
      ...(patch.merger !== undefined ? { merger: patch.merger } : {}),
      ...(patch.roleOverrides !== undefined ? { roleOverrides: patch.roleOverrides } : {}),
      ...(patch.roles !== undefined ? { roles: patch.roles } : {}),
      ...(patch.releaseFourEyes !== undefined ? { releaseFourEyes: patch.releaseFourEyes } : {}),
      ...(patch.boundary !== undefined ? { boundary: patch.boundary } : {}),
      limits,
    },
    pipeline: patch.pipeline ?? config.pipeline,
  };
}
