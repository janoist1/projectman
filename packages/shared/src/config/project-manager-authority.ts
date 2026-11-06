import type { ProjectConfig, ProjectManagerAuthority } from './schema';
import { teamSettingOf } from './team-settings';

export function projectManagerAuthorityOf(config: Pick<ProjectConfig, 'team'>): ProjectManagerAuthority {
  return teamSettingOf(config, 'projectManagerAuthority');
}
