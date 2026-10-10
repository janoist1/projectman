import { z } from 'zod';
import { Pipeline } from '../domain/pipeline';
import type { ConfigIssue } from './invariants';
import {
  AutoCompactWindowTokens,
  MaxConcurrentAi,
  ProjectConfig,
  TeamLimits,
  WarnAboveSessionTokens,
} from './schema';

const tempWorkersSchema = TeamLimits.shape.tempWorkers.removeDefault();

/** PATCH fields deliberately omit defaults so partial edits retain existing values. */
export const PatchConfigRequest = z
  .object({
    baseVersion: z.string().min(1),
    repoMerge: z
      .array(z.object({ repo: z.string(), mergeOnDone: z.boolean().nullable() }))
      .max(20)
      .optional(),
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
    cardMover: ProjectConfig.shape.team.shape.cardMover,
    boundary: ProjectConfig.shape.team.shape.boundary,
    pipeline: Pipeline.optional(),
  })
  .strict();
export type PatchConfigRequest = z.infer<typeof PatchConfigRequest>;

/** Request invariants that cannot be inferred from the resulting configuration. */
export function configPatchIssues(config: ProjectConfig, patch: PatchConfigRequest): ConfigIssue[] {
  return (patch.repoMerge ?? []).flatMap((edit, index) =>
    config.project.repos.some((repo) => repo.name === edit.repo)
      ? []
      : [{ code: 'unknown_repo' as const, path: `repoMerge.${index}.repo`, detail: edit.repo }],
  );
}

/** Schema failures share the same issue list shape as invariant failures. */
export function configSchemaIssues(issues: readonly { code: string; path: readonly PropertyKey[] }[]) {
  return issues.map(({ code, path }) => ({ code, path: path.map(String).join('.') }));
}

export function applyConfigPatch(config: ProjectConfig, patch: PatchConfigRequest): ProjectConfig {
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
  return {
    ...config,
    project: {
      ...config.project,
      ...patch.project,
      repos: config.project.repos.map((repo) => {
        const next = { ...repo };
        for (const edit of patch.repoMerge ?? [])
          if (edit.repo === repo.name) {
            if (edit.mergeOnDone === null) delete next.mergeOnDone;
            else next.mergeOnDone = edit.mergeOnDone;
          }
        return next;
      }),
    },
    team: {
      ...config.team,
      ...(patch.cardMover !== undefined ? { cardMover: patch.cardMover } : {}),
      ...(patch.roleOverrides !== undefined ? { roleOverrides: patch.roleOverrides } : {}),
      ...(patch.roles !== undefined ? { roles: patch.roles } : {}),
      ...(patch.releaseFourEyes !== undefined ? { releaseFourEyes: patch.releaseFourEyes } : {}),
      ...(patch.boundary !== undefined ? { boundary: patch.boundary } : {}),
      limits,
    },
    pipeline: patch.pipeline ?? config.pipeline,
  };
}
