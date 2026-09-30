import type { FastifyBaseLogger } from 'fastify';
import {
  AgentProvider,
  DEFAULT_AGENT_PROVIDER,
  FALLBACK_PERMISSION_MODE,
  LabelDefinition,
  PermissionMode,
  permissionModeFitsProvider,
  ProjectConfig,
  releaseApprovalSetBy,
  releaseApprovers,
  releaseGateAccepts,
} from '@projectman/shared';
import { DAILY_WORKER_SCHEDULE, migrateLegacyConfig } from '@projectman/templates';

export interface MigrationContext {
  projectKey: string;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

/** The AI member objects of a raw configuration. */
function rawAiMembers(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || !('team' in raw)) return [];
  const team = raw.team;
  if (!team || typeof team !== 'object' || !('members' in team) || !Array.isArray(team.members)) return [];
  return team.members.filter(
    (member): member is Record<string, unknown> =>
      Boolean(member) && typeof member === 'object' && member.kind === 'ai',
  );
}

/** The removed `scheduled` AI role: such members become maintainers with the daily worker schedule. */
function migrateScheduledRole(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  for (const member of rawAiMembers(raw)) {
    if (member.role !== 'scheduled') continue;
    member.role = 'maintainer';
    if (member.schedule === undefined) member.schedule = { ...DAILY_WORKER_SCHEDULE };
    logger.warn({ projectKey, member: member.handle }, 'Migrated legacy scheduled role to maintainer');
  }
  return raw;
}

/**
 * A Codex member in `bypassPermissions` (decision 19 forbids it): such a member reads as
 * `acceptEdits`, so the configuration still loads. A mode that is not a permission mode at all is
 * left for the schema to refuse.
 */
function migrateCodexBypass(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  for (const member of rawAiMembers(raw)) {
    const provider = AgentProvider.safeParse(member.provider ?? DEFAULT_AGENT_PROVIDER);
    const mode = PermissionMode.safeParse(member.permissionMode);
    if (!provider.success || !mode.success || permissionModeFitsProvider(provider.data, mode.data)) continue;
    member.permissionMode = FALLBACK_PERMISSION_MODE;
    logger.warn(
      { projectKey, member: member.handle },
      `Migrated ${provider.data} member from ${mode.data} to ${FALLBACK_PERMISSION_MODE}`,
    );
  }
  return raw;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** For each label that gates require (has_label): the release stages and the other stages that do. */
function gateRequirements(stages: unknown[]): Map<string, { release: string[]; other: string[] }> {
  const required = new Map<string, { release: string[]; other: string[] }>();
  for (const entry of stages) {
    const stage = asRecord(entry);
    const conditions = asRecord(stage?.gate)?.conditions;
    if (!stage || !Array.isArray(conditions)) continue;
    for (const condition of conditions.map(asRecord)) {
      if (condition?.type !== 'has_label' || typeof condition.label !== 'string') continue;
      const gates = required.get(condition.label) ?? { release: [], other: [] };
      gates[stage.kind === 'release' ? 'release' : 'other'].push(String(stage.id));
      required.set(condition.label, gates);
    }
  }
  return required;
}

/**
 * A release approval that more than the holders of the release approval duty may give (decision
 * 19: a label any human may set let clients and viewers approve a release): the label a release
 * gate requires is narrowed to that duty, humans only. It is fail-closed: whoever approved by
 * another right loses it unless they hold the duty. A label that another stage's gate requires too
 * is narrowed for both. Nobody holding the duty would leave the release without an approver and
 * the project without a load, so such a label stays as it is, with a warning: the project loads
 * with the rule still broken (`isToleratedOnLoad`) until the owner grants the duty in settings.
 * Runs after the conversion of legacy gates, which defines labels of this kind too.
 */
function migrateReleaseApproval(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  const pipeline = asRecord(asRecord(raw)?.pipeline);
  if (!Array.isArray(pipeline?.stages) || !Array.isArray(pipeline.labels)) return raw;
  const required = gateRequirements(pipeline.stages);
  const tooWide = pipeline.labels.map(asRecord).filter((label): label is Record<string, unknown> => {
    const setBy = LabelDefinition.shape.setBy.safeParse(label?.setBy);
    return (
      typeof label?.id === 'string' &&
      (required.get(label.id)?.release.length ?? 0) > 0 &&
      setBy.success &&
      !releaseGateAccepts({ setBy: setBy.data })
    );
  });
  if (tooWide.length === 0) return raw;
  // Who holds the duty is only known from the whole configuration; an unreadable one fails its load anyway.
  const config = ProjectConfig.safeParse(raw);
  if (!config.success) return raw;
  const approvable = releaseApprovers(config.data).length > 0;
  for (const label of tooWide) {
    const gates = required.get(String(label.id));
    const details = {
      projectKey,
      label: label.id,
      releaseStages: gates?.release,
      otherStages: gates?.other,
      setBy: label.setBy,
    };
    if (approvable) {
      label.setBy = releaseApprovalSetBy();
      logger.warn(details, 'Narrowed release approval label to the release approval duty');
    } else {
      logger.warn(
        details,
        'Release approval label is not limited to the release approval duty, and nobody holds the duty; grant it in settings',
      );
    }
  }
  return raw;
}

/**
 * Upgrades a merged, not yet validated project configuration of an older shape, in memory: the
 * customization files keep their content until the next save. Used wherever the store reads
 * a configuration (the working tree and earlier versions alike).
 *   - the removed `scheduled` AI role becomes `maintainer` (above);
 *   - a Codex member in `bypassPermissions` becomes `acceptEdits` (above);
 *   - gate conditions from before labels (check_passed, pr_merged, human_approval) become label
 *     conditions with the labels they need (`migrateLegacyConfig`, @projectman/templates);
 *   - a label a release gate requires that more than the release approval duty's holders may set
 *     is narrowed to that duty (above), after the conversion of legacy gates.
 * Stage kinds from before decision 18 (review, deploy, …) are read by the pipeline schema
 * itself (packages/shared/src/domain/pipeline.ts).
 */
export function migrateProjectConfig(raw: unknown, context: MigrationContext): unknown {
  return migrateReleaseApproval(
    migrateLegacyConfig(migrateCodexBypass(migrateScheduledRole(raw, context), context)),
    context,
  );
}
