import type { GithubService, PullRequestInfo } from '../contracts';
import type { DomainContext } from './context';
import { isoNow } from './context';
import { DomainError } from './errors';
import type { ProjectService } from './projects';
import type { TaskService } from './tasks';
import { SYSTEM_ACTOR } from './util';
import {
  isOpenTask,
  isTheme,
  labelDefinition,
  PR_MERGED_LABEL,
  pullRequestsMerged,
  stageIndex,
} from '@projectman/shared';

/**
 * Keeps pull request links up to date: every linked PR that is not merged or closed yet is
 * watched through the GitHub service.
 * - New commits on a PR (its head commit changes) take off the labels that expire then
 *   (`clearedWhen: pr_updated`, e.g. a review or approval of the previous code).
 * - When a PR merges, the system label `pr-merged` goes on the tasks linking it, and tasks
 *   whose next stage is gated by it try to advance (other gate conditions still apply; a human
 *   approval in that gate becomes an inbox decision).
 */
export class GithubSync {
  private readonly ctx: DomainContext;
  private readonly github: GithubService;
  private readonly tasks: TaskService;
  private readonly projects: ProjectService;
  private readonly watches = new Map<string, () => void>();
  private readonly onNewCommits?: (projectKey: string, taskKey: string) => Promise<unknown>;

  constructor(deps: {
    ctx: DomainContext;
    github: GithubService;
    tasks: TaskService;
    projects: ProjectService;
    /** A linked pull request got new commits (called after the labels that expire then came off). */
    onNewCommits?: (projectKey: string, taskKey: string) => Promise<unknown>;
  }) {
    this.onNewCommits = deps.onNewCommits;
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
    if (pr.headSha) await this.clearAfterNewCommits(pr.repo, pr.number, pr.headSha);
    if (pr.state === 'merged' || pr.state === 'closed') this.unwatch(pr.repo, pr.number);
    if (pr.state !== 'merged') return;
    for (const link of this.ctx.repos.tasks.findByPullRequest(pr.repo, pr.number)) {
      await this.advanceAfterMerge(link.projectKey, link.taskKey);
    }
  }

  private async clearAfterNewCommits(repo: string, number: number, headSha: string): Promise<void> {
    const moved = this.ctx.repos.tasks.recordPullRequestHead(repo, number, headSha, isoNow(this.ctx));
    for (const { projectKey, taskKey } of moved) {
      const task = this.tasks.find(projectKey, taskKey);
      if (!task || !isOpenTask(task)) continue;
      await this.tasks.clearLabels(projectKey, taskKey, 'pr_updated');
      // A branch that moved in review is found now, not at the watcher's next round (PM-183).
      await this.onNewCommits?.(projectKey, taskKey);
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
    // A theme does not move: a pull request linked to it advances nothing (PM-192).
    if (!task || task.status !== 'active' || isTheme(task)) return;
    const config = await this.projects.config(projectKey);
    // The system label stands for the merged pull request when the project defines it.
    if (
      labelDefinition(config, PR_MERGED_LABEL) &&
      !task.labels.includes(PR_MERGED_LABEL) &&
      pullRequestsMerged(task)
    )
      await this.tasks.changeLabels(projectKey, taskKey, { add: [PR_MERGED_LABEL] }, SYSTEM_ACTOR, {
        reason: 'pr_merged',
      });
    const index = stageIndex(config.pipeline, task.stageId);
    const next = config.pipeline.stages[index + 1];
    if (!next?.gate?.conditions.some((c) => c.type === 'has_label' && c.label === PR_MERGED_LABEL)) return;
    try {
      await this.tasks.moveToStage(projectKey, taskKey, next.id, SYSTEM_ACTOR);
    } catch (err) {
      if (err instanceof DomainError && (err.code === 'gate_blocked' || err.code === 'handover_uncommitted'))
        return;
      throw err;
    }
  }
}
