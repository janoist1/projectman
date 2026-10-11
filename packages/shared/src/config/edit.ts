import { z } from 'zod';
import { Pipeline } from '../domain/pipeline';
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
    merger: ProjectConfig.shape.team.shape.merger,
    /** Per repository: whether a card's work must be merged (`requireMerge`); null removes the explicit value. */
    repoMerge: z
      .array(z.object({ repo: z.string(), requireMerge: z.boolean().nullable() }))
      .max(20)
      .optional(),
    boundary: ProjectConfig.shape.team.shape.boundary,
    pipeline: Pipeline.optional(),
  })
  .strict();
export type PatchConfigRequest = z.infer<typeof PatchConfigRequest>;

/** Schema failures share the same issue list shape as invariant failures. */
export function configSchemaIssues(issues: readonly { code: string; path: readonly PropertyKey[] }[]) {
  return issues.map(({ code, path }) => ({ code, path: path.map(String).join('.') }));
}

/** The first repository of `repoMerge` that the configuration does not know (the edit answers `unknown_repo`); null: none. */
export function unknownPatchRepo(
  config: Pick<ProjectConfig, 'project'>,
  patch: PatchConfigRequest,
): string | null {
  const known = new Set(config.project.repos.map((repo) => repo.name));
  return patch.repoMerge?.find((entry) => !known.has(entry.repo))?.repo ?? null;
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
  // The last entry for a repository wins.
  const repoMerge = patch.repoMerge && new Map(patch.repoMerge.map((e) => [e.repo, e.requireMerge] as const));
  return {
    ...config,
    project: {
      ...config.project,
      ...patch.project,
      repos: repoMerge
        ? config.project.repos.map((repo) => {
            const change = repoMerge.get(repo.name);
            if (change === undefined) return repo;
            const { requireMerge: _previous, ...rest } = repo;
            return change === null ? rest : { ...rest, requireMerge: change };
          })
        : config.project.repos,
    },
    team: {
      ...config.team,
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
