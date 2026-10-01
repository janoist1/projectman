import { checkPublishTarget, effectiveRepo, memberOf, repoOf } from '@projectman/shared';
import type { PublishRefusal } from '@projectman/shared';
import { PublishError, TeamToolError } from '../contracts';
import type {
  GithubPublisher,
  MemberWorkspaceManager,
  PublishedTaskBranch,
  PublishedTaskState,
  ToolContext,
} from '../contracts';
import type { DomainContext } from './context';
import type { GithubSync } from './github-sync';
import type { ProjectService } from './projects';
import type { TaskService } from './tasks';
import { aiActor } from './util';

/** Refusals that are the caller's own doing read as `forbidden`; the rest as `invalid`. */
const FORBIDDEN: ReadonlySet<PublishRefusal> = new Set([
  'not_available',
  'protected_branch',
  'foreign_branch',
]);

function toToolError(err: unknown): unknown {
  if (err instanceof PublishError)
    return new TeamToolError(FORBIDDEN.has(err.code) ? 'forbidden' : 'invalid', err.message);
  return err;
}

/**
 * The publishing gate (PM-142, decision 26): the one way a member's task branch leaves the managed
 * VM. It is a team tool, so the caller is the session the server authenticated, and everything that
 * says what may go where comes from the server's records, never from the caller:
 *
 * - member and project: the MCP session; the session must have run in the managed VM profile;
 * - task: the task of that session (naming another is refused);
 * - repository: the task's own, or the project's only one; it must have a GitHub name (a local-only
 *   or repository-less task cannot publish);
 * - branch: the member's own work binding of this task in its workspace (so another member's
 *   branch, `main` or any other name is not even reachable);
 * - commit: named by the caller and checked against the branch tip by the publisher;
 * - refspec and token: the publisher's (`checkPublishTarget`, the VM identity), never the caller's.
 *
 * Provenance: the authenticated member becomes the durable author of the pull request link, so
 * a pull request opened under the shared bot login still counts as that member's for no-self-review.
 */
export class PublishingGate {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly githubSync: GithubSync;
  private readonly publisher: GithubPublisher | undefined;
  private readonly memberWorkspaces: MemberWorkspaceManager | undefined;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    githubSync: GithubSync;
    publisher?: GithubPublisher;
    /** Hands the branch over from the member's workspace (a worker's bundle behind the VM boundary). */
    memberWorkspaces?: MemberWorkspaceManager;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.githubSync = deps.githubSync;
    this.publisher = deps.publisher;
    this.memberWorkspaces = deps.memberWorkspaces;
  }

  /** Whether this installation can publish at all (the tools say so in their refusal otherwise). */
  get available(): boolean {
    return this.publisher !== undefined;
  }

  async publish(
    ctx: ToolContext,
    args: { taskKey?: string; commit: string; title?: string; body?: string },
  ): Promise<PublishedTaskBranch> {
    try {
      const publisher = this.requirePublisher();
      const config = await this.projects.config(ctx.projectKey);
      if (memberOf(config, ctx.member)?.kind !== 'ai')
        throw new TeamToolError('forbidden', `${ctx.member} is not an AI member of this team.`);
      this.requireVmSession(ctx);
      const taskKey = args.taskKey ?? ctx.taskKey;
      if (!taskKey || taskKey !== ctx.taskKey)
        throw new TeamToolError(
          'forbidden',
          `You can publish only the task your session works on (${ctx.taskKey ?? 'none'}), not ${taskKey ?? 'a task of your choice'}.`,
        );
      const task = this.tasks.get(ctx.projectKey, taskKey);
      const repoName = effectiveRepo(config, task);
      const repo = repoOf(config, repoName);
      const binding = repo
        ? this.ctx.repos.memberWorkspaces
            .bindingsOfTask(ctx.projectKey, taskKey)
            .find((b) => b.member === ctx.member && b.kind === 'work')
        : undefined;
      const workspace = binding ? this.ctx.repos.memberWorkspaces.get(binding.workspaceId) : null;
      const decision = checkPublishTarget({
        taskKey,
        github: repo?.github,
        defaultBranch: repo?.defaultBranch ?? 'main',
        branch: workspace && workspace.repo === repoName ? (binding?.branch ?? null) : null,
        commit: args.commit,
      });
      if (!decision.ok) throw new PublishError(decision.code, decision.message);
      const title = args.title?.trim() || `${taskKey}: ${task.title}`;
      const body =
        args.body?.trim() ||
        `${task.title}\n\nTask ${taskKey}, published by ${ctx.member} (AI member) from its own workspace.`;
      const workspaces = this.requireWorkspaces();
      // The server never runs git in the member's workspace itself: behind the VM boundary the
      // member's worker bundles the branch and the server publishes from that copy (PM-140).
      const source = await workspaces.exportBranch(
        { project: config, repoName: repoName!, member: ctx.member },
        decision.branch,
      );
      let result: Awaited<ReturnType<GithubPublisher['publish']>>;
      try {
        result = await publisher.publish({
          repo: repo!.github!,
          branch: decision.branch,
          baseBranch: repo!.defaultBranch,
          commit: decision.commit,
          sourcePath: source.path,
          sourceKind: source.bundle ? 'bundle' : 'repository',
          title,
          body,
          taskKey,
        });
      } finally {
        await source.done().catch(() => undefined);
      }
      // The author is the authenticated member, whoever the pull request's GitHub login is.
      const recorded = this.tasks.recordPublication(
        ctx.projectKey,
        taskKey,
        { repo: result.repo, branch: result.branch, pullRequest: result.pullRequest },
        ctx.member,
        aiActor(ctx.member),
        ctx.sessionId,
      );
      this.tasks.recordPullRequest(result.pullRequest);
      if (result.pullRequest.state === 'open') this.githubSync.watch(result.repo, result.pullRequest.number);
      return {
        repo: result.repo,
        branch: result.branch,
        commit: result.commit,
        alreadyPublished: result.alreadyPublished,
        pullRequest: result.pullRequest,
        pullRequestCreated: result.pullRequestCreated,
        task: recorded,
      };
    } catch (err) {
      throw toToolError(err);
    }
  }

  /**
   * The remote's state for a task: for the integrator and the review stage, read through the server
   * so that no session holds a credential. Any AI member of the project may ask; the branch is the
   * one the task published (its branch link), else the assignee's task branch.
   */
  async remoteState(ctx: ToolContext, args: { taskKey: string }): Promise<PublishedTaskState> {
    try {
      const publisher = this.requirePublisher();
      const config = await this.projects.config(ctx.projectKey);
      if (memberOf(config, ctx.member)?.kind !== 'ai')
        throw new TeamToolError('forbidden', `${ctx.member} is not an AI member of this team.`);
      const task = this.tasks.find(ctx.projectKey, args.taskKey);
      if (!task) throw new TeamToolError('not_found', `Task ${args.taskKey} does not exist in this project.`);
      const repo = repoOf(config, effectiveRepo(config, task));
      if (!repo?.github)
        throw new PublishError('local_only', `${task.key} has no GitHub repository, so there is no remote.`);
      const linked = task.links.find((link) => link.kind === 'branch' && link.repo === repo.github);
      const worked = this.ctx.repos.memberWorkspaces
        .bindingsOfTask(ctx.projectKey, task.key)
        .find((b) => b.kind === 'work' && b.branch && (!task.assignee || b.member === task.assignee));
      const branch = linked?.ref ?? worked?.branch ?? null;
      if (!branch)
        throw new PublishError(
          'no_task_branch',
          `${task.key} has no task branch yet (nothing was published).`,
        );
      const state = await publisher.remoteState(repo.github, repo.defaultBranch, branch);
      const pullRequestLink = task.links.find(
        (link) => link.kind === 'pull_request' && link.repo === repo.github,
      );
      return { ...state, taskKey: task.key, publishedBy: pullRequestLink?.author ?? null };
    } catch (err) {
      throw toToolError(err);
    }
  }

  private requirePublisher(): GithubPublisher {
    if (!this.publisher)
      throw new PublishError(
        'not_available',
        'This installation has no GitHub publishing identity, so nothing can be published from here. ' +
          'Commit on the task branch and hand it over as usual.',
      );
    return this.publisher;
  }

  private requireWorkspaces(): MemberWorkspaceManager {
    if (!this.memberWorkspaces)
      throw new PublishError(
        'not_available',
        'This installation has no member workspaces, so there is no task branch to publish.',
      );
    return this.memberWorkspaces;
  }

  /** Publishing exists only for sessions the server started in the managed VM profile. */
  private requireVmSession(ctx: ToolContext): void {
    const session = this.ctx.repos.sessions.get(ctx.sessionId);
    if (
      !session ||
      session.projectKey !== ctx.projectKey ||
      session.member !== ctx.member ||
      this.ctx.repos.sessions.executionProfile(ctx.sessionId) !== 'managed_vm'
    )
      throw new PublishError(
        'not_available',
        'Publishing is available only to sessions of the managed VM profile.',
      );
  }
}
