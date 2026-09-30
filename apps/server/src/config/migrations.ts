import type { FastifyBaseLogger } from 'fastify';
import {
  AgentProvider,
  DEFAULT_AGENT_PROVIDER,
  FALLBACK_PERMISSION_MODE,
  PermissionMode,
  permissionModeFitsProvider,
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

/**
 * Upgrades a merged, not yet validated project configuration of an older shape, in memory: the
 * customization files keep their content until the next save. Used wherever the store reads
 * a configuration (the working tree and earlier versions alike).
 *   - the removed `scheduled` AI role becomes `maintainer` (above);
 *   - a Codex member in `bypassPermissions` becomes `acceptEdits` (above);
 *   - gate conditions from before labels (check_passed, pr_merged, human_approval) become label
 *     conditions with the labels they need (`migrateLegacyConfig`, @projectman/templates).
 * Stage kinds from before decision 18 (review, deploy, …) are read by the pipeline schema
 * itself (packages/shared/src/domain/pipeline.ts).
 */
export function migrateProjectConfig(raw: unknown, context: MigrationContext): unknown {
  return migrateLegacyConfig(migrateCodexBypass(migrateScheduledRole(raw, context), context));
}
