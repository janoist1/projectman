import { memberDuties } from './duties';
import { isProjectManager } from './project-manager';
import type { AiMemberConfig, ProjectConfig, PrioritySetter } from './schema';
import { teamSettingOf } from './team-settings';

/** Who besides people and the connected owner may set a card's priority. */
export function prioritySettersOf(config: Pick<ProjectConfig, 'team'>): readonly PrioritySetter[] {
  return teamSettingOf(config, 'prioritySetters');
}

/**
 * The AI members one source covers, in team order: a temp worker never counts, leave does not
 * matter. The source need not be switched on, so a settings page can show who a choice would reach.
 */
export function prioritySetterCandidates(
  config: Pick<ProjectConfig, 'team'>,
  setter: PrioritySetter,
): AiMemberConfig[] {
  return config.team.members.filter(
    (m): m is AiMemberConfig =>
      m.kind === 'ai' &&
      !m.temp &&
      (setter === 'project_manager'
        ? isProjectManager(m)
        : memberDuties(config, m).includes('prioritization')),
  );
}

/** The AI members who may set a card's priority, in team order. */
export function prioritySetterMembers(config: Pick<ProjectConfig, 'team'>): AiMemberConfig[] {
  const covered = prioritySettersOf(config).flatMap((setter) => prioritySetterCandidates(config, setter));
  return config.team.members.filter((m): m is AiMemberConfig => m.kind === 'ai' && covered.includes(m));
}
