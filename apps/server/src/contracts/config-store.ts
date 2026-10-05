import type { ConfigVersionEntry, ProjectConfig } from '@projectman/shared';

/**
 * The customization repository: a separate git repo (independent from the app source)
 * holding every project's configuration as YAML. Each save is a commit; admins can
 * revert to any earlier version. Layout:
 *   projects/<KEY>/project.yaml   project, repos, limits
 *   projects/<KEY>/team.yaml      members, custom roles
 *   projects/<KEY>/pipeline.yaml  columns and stages
 * Owned by src/config.
 */
export interface ConfigStore {
  /** Project keys present in the repository. */
  list(): Promise<string[]>;
  /**
   * The working tree, migrated and validated. A project that breaks a rule added after its
   * configuration was written (`isToleratedOnLoad`) still loads, with a logged warning.
   */
  load(projectKey: string): Promise<{ config: ProjectConfig; version: string }>;
  /** Validates schema and invariants (only introduced errors when previous is supplied), writes and commits. */
  save(
    projectKey: string,
    config: ProjectConfig,
    meta: { author: { name: string; email: string }; message: string; previous?: ProjectConfig },
  ): Promise<{ version: string }>;
  history(projectKey: string, limit?: number): Promise<ConfigVersionEntry[]>;
  /** The configuration as of `version` (migrated and validated), without changing anything. */
  loadVersion(projectKey: string, version: string): Promise<ProjectConfig>;
  /** Restores the project's files as of `version` in a new commit. */
  revertTo(
    projectKey: string,
    version: string,
    meta: { author: { name: string; email: string } },
  ): Promise<{ version: string }>;
}
