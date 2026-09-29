import type { GithubService, PullRequestInfo } from '../contracts';
import type { DomainContext } from './context';
import { DomainError } from './errors';
import type { ProjectService } from './projects';
import type { TaskService } from './tasks';
import { SYSTEM_ACTOR } from './util';

/**
 * Keeps pull request links up to date: every linked PR that is not merged or closed yet is
 * watched through the GitHub service. When a PR merges, tasks whose next stage is gated by
 * `pr_merged` try to advance (other gate conditions still apply; a human approval in that
 * gate becomes an inbox decision).
 */
export class GithubSync {
  private readonly ctx: DomainContext;
  private readonly github: GithubService;
  private readonly tasks: TaskService;
  private readonly projects: ProjectService;
  private readonly watches = new Map<string, () => void>();

  constructor(deps: {
    ctx: DomainContext;
    github: GithubService;
    tasks: TaskService;
    projects: ProjectService;
  }) {
    this.ctx = deps.ctx;
    this.github = deps.github;
    this.tasks = deps.tasks;
    this.projects = deps.projects;
  }

  /** Startup: watch every open pull request link. */
  start(): void {
    for (const link of this.ctx.repos.tasks.listWatchablePullRequests()) this.watch(link.repo, link.number);
  }

  stop(): void {
    for (const unwatch of this.watches.values()) {
      try {
        unwatch();
      } catch {
        // ignore
      }
    }
    this.watches.clear();
  }

  watch(repo: string, number: number): void {
    const key = `${repo}#${number}`;
    if (this.watches.has(key)) return;
    try {
      const unwatch = this.github.watch([{ repo, number }], (pr) => {
        this.handleChange(pr).catch((err: unknown) =>
          this.ctx.logger.error({ err, repo, number }, 'pull request update failed'),
        );
      });
      this.watches.set(key, unwatch);
    } catch (err) {
      this.ctx.logger.warn({ err, repo, number }, 'could not watch the pull request');
    }
  }

  async handleChange(pr: PullRequestInfo): Promise<void> {
    this.tasks.recordPullRequest(pr);
    this.tasks.applyPullRequestUpdate(pr.repo, pr.number, { state: pr.state, title: pr.title });
    if (pr.state === 'merged' || pr.state === 'closed') this.unwatch(pr.repo, pr.number);
    if (pr.state !== 'merged') return;
    for (const link of this.ctx.repos.tasks.findByPullRequest(pr.repo, pr.number)) {
      await this.advanceAfterMerge(link.projectKey, link.taskKey);
    }
  }

  private unwatch(repo: string, number: number): void {
    const key = `${repo}#${number}`;
    const unwatch = this.watches.get(key);
    this.watches.delete(key);
    try {
      unwatch?.();
    } catch {
      // ignore
    }
  }

  private async advanceAfterMerge(projectKey: string, taskKey: string): Promise<void> {
    const task = this.tasks.find(projectKey, taskKey);
    if (!task || task.status !== 'active') return;
    const config = await this.projects.config(projectKey);
    const index = config.pipeline.stages.findIndex((s) => s.id === task.stageId);
    const next = config.pipeline.stages[index + 1];
    if (!next?.gate?.conditions.some((c) => c.type === 'pr_merged')) return;
    try {
      await this.tasks.moveToStage(projectKey, taskKey, next.id, SYSTEM_ACTOR);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'gate_blocked') return;
      throw err;
    }
  }
}
