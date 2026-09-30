import type { Task } from '../domain/task';
import { roleUsesWorktree } from './duties';
import type { ProjectConfig, RepoConfig } from './schema';

/**
 * Which repository a task's work happens in (PM-68). One rule for the server (session placement,
 * the command policy, the context pack, the team tools) and for the web, so that they never
 * disagree about where a task without a `repo` of its own works.
 */

type ProjectRepos = Pick<ProjectConfig, 'project'>;
type TaskRepo = Pick<Task, 'repo'> | null | undefined;

/** The configured repository with this name. */
export function repoOf(config: ProjectRepos, name: string | null | undefined): RepoConfig | undefined {
  return name ? config.project.repos.find((repo) => repo.name === name) : undefined;
}

/**
 * The name of the repository a task's work happens in: the task's own `repo`; else the project's
 * only repository, because a task of a one-repository project has nothing to choose; else none.
 * Work that is not a task (a general chat, a meeting, a scheduled run) has none. A `repo` that the
 * configuration no longer knows is returned as it is, so that whoever needs the repository can
 * refuse it instead of quietly working elsewhere.
 */
export function effectiveRepo(config: ProjectRepos, task: TaskRepo): string | null {
  if (!task) return null;
  if (task.repo) return task.repo;
  const { repos } = config.project;
  return repos.length === 1 ? repos[0]!.name : null;
}

/**
 * Whether a person still has to choose the task's repository: the project has several and the
 * task names none. A project without repositories has nothing to choose from: its tasks work in
 * the workspace root.
 */
export function needsRepoChoice(config: ProjectRepos, task: TaskRepo): boolean {
  return !!task && !task.repo && config.project.repos.length > 1;
}

/**
 * Whether a session of `role` may not start on the task yet: the role changes files, which it does
 * in a git worktree of the task's repository, and a person has not chosen that repository. Such a
 * session would otherwise work in the workspace root, which may be a checkout somebody uses.
 * Roles that only read (reviewers, research) may run in the workspace root.
 */
export function repoRequired(
  config: Pick<ProjectConfig, 'project' | 'team'>,
  role: string,
  task: TaskRepo,
): boolean {
  return needsRepoChoice(config, task) && roleUsesWorktree(config, role);
}
