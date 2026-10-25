import type { ProjectConfig } from '@projectman/shared';
import type { ProjectService } from '../../core/projects';

/** The configuration of every project: the members' addresses share one domain, so they are unique across projects. */
export async function projectConfigs(projects: ProjectService): Promise<ProjectConfig[]> {
  const configs = await Promise.all(
    projects.summaries().map((project) => projects.config(project.key).catch(() => null)),
  );
  return configs.filter((config): config is ProjectConfig => config !== null);
}
