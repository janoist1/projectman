import { resolve } from 'node:path';
import type { RedactionContext } from '@projectman/shared';
import type { SystemFeedbackContextProvider } from '../../../contracts';
import type { DomainContext } from '../../../core/base';
import type { ProjectService } from '../../../core/projects';

/**
 * What the system feedback filter must know about this installation, gathered fresh at every use (PM-479):
 * the projects, members, clients and repositories change while the server runs. It lives only in memory for
 * the one filter run: no answer, log line or error ever holds it.
 */
export class SystemFeedbackContext implements SystemFeedbackContextProvider {
  private readonly ctx: Pick<DomainContext, 'repos' | 'logger'>;
  private readonly projects: Pick<ProjectService, 'summaries' | 'config'>;
  private readonly secrets: () => Promise<readonly (string | null | undefined)[]>;
  private readonly paths: readonly (string | null | undefined)[];

  constructor(deps: {
    ctx: Pick<DomainContext, 'repos' | 'logger'>;
    projects: Pick<ProjectService, 'summaries' | 'config'>;
    /** Known secret values (e.g. a provider key); read on every use, never kept. */
    secrets: () => Promise<readonly (string | null | undefined)[]>;
    /** The installation's home, the user's home and the workspaces root, where the host sets them. */
    paths: readonly (string | null | undefined)[];
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.secrets = deps.secrets;
    this.paths = deps.paths;
  }

  async current(): Promise<RedactionContext> {
    const paths = new Set<string>();
    const projectKeys = new Set<string>();
    const projectNames = new Set<string>();
    const members = new Set<string>();
    const clients = new Set<string>();
    for (const path of this.paths) if (path) paths.add(path);
    for (const summary of this.projects.summaries()) {
      projectKeys.add(summary.key);
      projectNames.add(summary.name);
      // A configuration that does not load still has its key and name from the database row above.
      const config = await this.projects.config(summary.key).catch((error: unknown) => {
        this.ctx.logger.warn(
          { projectKey: summary.key, err: error instanceof Error ? error.message : 'unknown' },
          'system feedback filter: the project configuration could not be read',
        );
        return null;
      });
      if (!config) continue;
      projectNames.add(config.project.name);
      paths.add(config.project.workspacePath);
      for (const repo of config.project.repos) {
        projectNames.add(repo.name);
        paths.add(resolve(config.project.workspacePath, repo.path));
        if (repo.github) for (const part of [repo.github, ...repo.github.split('/')]) projectNames.add(part);
      }
      for (const member of config.team.members) {
        if (member.kind !== 'human') continue;
        const target = member.access === 'client' ? clients : members;
        for (const value of [member.displayName, member.handle, member.email]) if (value) target.add(value);
      }
    }
    for (const user of this.ctx.repos.users.list()) {
      const target = clients.has(user.email) ? clients : members;
      for (const value of [user.name, user.email]) if (value) target.add(value);
    }
    const secrets = (await this.secrets()).filter((value): value is string => Boolean(value));
    return {
      secrets,
      paths: [...paths],
      projectKeys: [...projectKeys],
      projectNames: [...projectNames],
      members: [...members],
      clients: [...clients],
    };
  }
}
