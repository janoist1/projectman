import type { Task, TaskLink, TaskPullRequest } from '@projectman/shared';
import type { PullRequestInfo } from '../contracts';
import { isoNow } from './context';
import type { DomainContext } from './context';
import type { ProjectService } from './projects';
import type { TimelineService } from './timeline';
import { SYSTEM_ACTOR } from './util';

/**
 * What GitHub told us about linked pull requests: the latest snapshot of each (kept in memory,
 * shown on the task), and who on the team authored it (matched by GitHub login, stored on the
 * link so it survives reassignment).
 */
export class PullRequestRecords {
  private readonly ctx: DomainContext;
  private readonly timeline: TimelineService;
  private readonly projects: ProjectService;
  private readonly find: (projectKey: string, taskKey: string) => Task | null;
  private readonly publish: (task: Task) => void;
  private readonly authorLogins = new Map<string, string>();
  private readonly snapshots = new Map<string, TaskPullRequest>();

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    find: (projectKey: string, taskKey: string) => Task | null;
    publish: (task: Task) => void;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.find = deps.find;
    this.publish = deps.publish;
  }

  /** The task's pull requests: the known snapshot, else what the link itself says. */
  forTask(task: Task): TaskPullRequest[] {
    return task.links
      .filter((link) => link.kind === 'pull_request')
      .flatMap((link) => {
        const number = Number(link.ref);
        if (!link.repo || !Number.isInteger(number) || number <= 0) return [];
        const known = this.snapshots.get(`${link.repo}#${number}`);
        return [
          known ?? {
            repo: link.repo,
            number,
            url: null,
            title: link.title ?? null,
            state: ['open', 'closed', 'merged', 'draft'].includes(link.state ?? '')
              ? (link.state as TaskPullRequest['state'])
              : null,
            checks: null,
            reviewDecision: null,
            additions: null,
            deletions: null,
          },
        ];
      });
  }

  /** The team member who authored a newly linked pull request, when GitHub told us. */
  authorOf(projectKey: string, link: Pick<TaskLink, 'repo' | 'ref'>): string | undefined {
    return this.memberForGithubLogin(projectKey, this.authorLogins.get(`${link.repo}#${link.ref}`));
  }

  /** Keeps the full snapshot already fetched by GitHub; unknown links remain nullable. */
  record(pr: PullRequestInfo): void {
    const snapshot: TaskPullRequest = {
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      state: pr.state,
      checks:
        pr.checks === 'success'
          ? 'passing'
          : pr.checks === 'failure'
            ? 'failing'
            : pr.checks === 'pending'
              ? 'pending'
              : null,
      reviewDecision: pr.reviewDecision,
      additions: pr.additions,
      deletions: pr.deletions,
    };
    let authorChanged = false;
    if (pr.authorLogin) this.authorLogins.set(`${pr.repo}#${pr.number}`, pr.authorLogin);
    for (const link of this.ctx.repos.tasks.findByPullRequest(pr.repo, pr.number)) {
      const author = this.memberForGithubLogin(link.projectKey, pr.authorLogin);
      if (author)
        authorChanged =
          this.ctx.repos.tasks.attributePullRequestAuthor(
            link.projectKey,
            pr.repo,
            pr.number,
            author,
            isoNow(this.ctx),
          ) || authorChanged;
    }
    const key = `${pr.repo}#${pr.number}`;
    if (!authorChanged && JSON.stringify(this.snapshots.get(key)) === JSON.stringify(snapshot)) return;
    this.snapshots.set(key, snapshot);
    for (const link of this.ctx.repos.tasks.findByPullRequest(pr.repo, pr.number)) {
      const task = this.find(link.projectKey, link.taskKey);
      if (task) this.publish(task);
    }
  }

  /** A watched pull request changed: refresh every task link to it. Returns the tasks linking it. */
  applyUpdate(repo: string, number: number, patch: { state: string; title?: string }): Task[] {
    const changed = this.ctx.repos.tasks.updatePullRequestLinks(repo, number, patch, isoNow(this.ctx));
    const tasks: Task[] = [];
    for (const key of changed) {
      const task = this.ctx.repos.tasks.get(key);
      if (!task) continue;
      this.timeline.append({
        projectKey: task.projectKey,
        taskKey: key,
        actor: SYSTEM_ACTOR,
        type: 'task_updated',
        data: { fields: ['links'], pullRequest: { repo, number, state: patch.state } },
      });
      this.publish(task);
      tasks.push(task);
    }
    return tasks;
  }

  private memberForGithubLogin(projectKey: string, login: string | undefined): string | undefined {
    if (!login) return undefined;
    return this.projects
      .cachedConfig(projectKey)
      ?.team.members.find((member) => member.githubLogin?.toLowerCase() === login.toLowerCase())?.handle;
  }
}
