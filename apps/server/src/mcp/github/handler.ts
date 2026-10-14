import type { Task } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type { GithubService, GithubToolsHandler, ToolContext } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { TaskService } from '../../core/tasks';
import { aiActor } from '../../kernel';
import type { GithubSync } from '../../services/github';
import type { ToolCaller } from '../caller';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export class GithubTools implements GithubToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: DomainContext;
  private readonly github: Pick<GithubService, 'getPullRequest'>;
  private readonly tasks: Pick<TaskService, 'recordPullRequest' | 'addLink'>;
  private readonly sync: Pick<GithubSync, 'watch'>;

  constructor(deps: {
    calls: ToolCaller;
    ctx: DomainContext;
    github: Pick<GithubService, 'getPullRequest'>;
    tasks: Pick<TaskService, 'recordPullRequest' | 'addLink'>;
    sync: Pick<GithubSync, 'watch'>;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.github = deps.github;
    this.tasks = deps.tasks;
    this.sync = deps.sync;
  }
  async linkPullRequest(
    ctx: ToolContext,
    args: { taskKey: string; repo: string; number: number },
  ): Promise<{ task: Task }> {
    return this.calls.guard(async () => {
      const who = await this.calls.callerWithRequest(ctx, 'link_pull_request');
      return this.calls.recorded(who, { action: 'task_update', taskKey: args.taskKey }, async () => {
        const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
        if (!REPO_RE.test(args.repo))
          throw new TeamToolError('invalid', 'repo must look like "owner/name" (the GitHub repository).');
        if (!Number.isInteger(args.number) || args.number <= 0)
          throw new TeamToolError('invalid', 'number must be the positive number of the pull request.');
        let title: string | undefined;
        let state: string | undefined;
        try {
          const pr = await this.github.getPullRequest(args.repo, args.number);
          this.tasks.recordPullRequest(pr);
          title = pr.title;
          state = pr.state;
        } catch (err) {
          this.ctx.logger.warn(
            { err, repo: args.repo, number: args.number },
            'could not fetch the pull request',
          );
        }
        const task = this.tasks.addLink(
          ctx.projectKey,
          taskKey,
          { kind: 'pull_request', ref: String(args.number), repo: args.repo, title, state },
          aiActor(ctx.member),
          ctx.sessionId,
        );
        if (state !== 'merged' && state !== 'closed') this.sync.watch(args.repo, args.number);
        return { task };
      });
    });
  }
}
