import type { FastifyBaseLogger } from 'fastify';
import { DAILY_WORKER_SCHEDULE, migrateLegacyConfig } from '@projectman/templates';

export interface MigrationContext {
  projectKey: string;
  logger: Pick<FastifyBaseLogger, 'warn'>;
}

/** The removed `scheduled` AI role: such members become maintainers with the daily worker schedule. */
function migrateScheduledRole(raw: unknown, { projectKey, logger }: MigrationContext): unknown {
  if (!raw || typeof raw !== 'object' || !('team' in raw)) return raw;
  const team = raw.team;
  if (!team || typeof team !== 'object' || !('members' in team) || !Array.isArray(team.members)) return raw;
  for (const member of team.members) {
    if (!member || typeof member !== 'object' || member.kind !== 'ai' || member.role !== 'scheduled')
      continue;
    member.role = 'maintainer';
    if (member.schedule === undefined) member.schedule = { ...DAILY_WORKER_SCHEDULE };
    logger.warn({ projectKey, member: member.handle }, 'Migrated legacy scheduled role to maintainer');
  }
  return raw;
}

/**
 * Upgrades a merged, not yet validated project configuration of an older shape, in memory: the
 * customization files keep their content until the next save. Used wherever the store reads
 * a configuration (the working tree and earlier versions alike).
 *   - the removed `scheduled` AI role becomes `maintainer` (above);
 *   - gate conditions from before labels (check_passed, pr_merged, human_approval) become label
 *     conditions with the labels they need (`migrateLegacyConfig`, @projectman/templates).
 * Stage kinds from before decision 18 (review, deploy, …) are read by the pipeline schema
 * itself (packages/shared/src/domain/pipeline.ts).
 */
export function migrateProjectConfig(raw: unknown, context: MigrationContext): unknown {
  return migrateLegacyConfig(migrateScheduledRole(raw, context));
}
