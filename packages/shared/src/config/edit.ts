import { z } from 'zod';
import { Pipeline } from '../domain/pipeline';
import { ProjectConfig, TeamLimits } from './schema';

const tempWorkersSchema = TeamLimits.shape.tempWorkers.removeDefault();

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
      maxConcurrentAi: TeamLimits.shape.maxConcurrentAi.removeDefault(),
      pauseAbovePlanUsagePercent: TeamLimits.shape.pauseAbovePlanUsagePercent.removeDefault(),
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
    pipeline: Pipeline.optional(),
  })
  .strict();
export type PatchConfigRequest = z.infer<typeof PatchConfigRequest>;

/** Schema failures share the same issue list shape as invariant failures. */
export function configSchemaIssues(issues: readonly { code: string; path: readonly PropertyKey[] }[]) {
  return issues.map(({ code, path }) => ({ code, path: path.map(String).join('.') }));
}

export function applyConfigPatch(config: ProjectConfig, patch: PatchConfigRequest): ProjectConfig {
  return {
    ...config,
    project: { ...config.project, ...patch.project },
    team: {
      ...config.team,
      ...(patch.roleOverrides !== undefined ? { roleOverrides: patch.roleOverrides } : {}),
      ...(patch.roles !== undefined ? { roles: patch.roles } : {}),
      ...(patch.releaseFourEyes !== undefined ? { releaseFourEyes: patch.releaseFourEyes } : {}),
      limits: {
        ...config.team.limits,
        ...patch.limits,
        tempWorkers: { ...config.team.limits.tempWorkers, ...patch.limits?.tempWorkers },
      },
    },
    pipeline: patch.pipeline ?? config.pipeline,
  };
}
