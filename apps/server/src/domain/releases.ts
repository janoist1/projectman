import { ALERT_SEEN_OPTION, dutyMembers, releaseApprovalOf, releaseApprovers } from '@projectman/shared';
import type {
  EngineId,
  InboxItem,
  ProjectConfig,
  Release,
  ReleaseFailure,
  ReleaseReport,
  TaskKey,
} from '@projectman/shared';
import type { BranchMerger, EngineDirectory } from '../contracts';
import type { MergeRecord } from '../db';
import { ownerHandles } from './access';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, forbidden, notFound } from './errors';
import type { InboxService, Resolver } from './inbox';
import { DECISION_OPTIONS } from './inbox';
import type { ProjectService } from './projects';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { aiActor, humanActor, KeyedMutex, newId, SYSTEM_ACTOR } from './util';

/** The project and repository that are the instance itself (`PROJECTMAN_RELEASE_TARGET`, `<project key>/<repository>`). */
export interface ReleaseTarget {
  projectKey: string;
  repo: string;
}

/** What a release would contain: the merged cards between the base and the commit. */
export interface ReleaseCandidate {
  repo: string;
  commit: string;
  baseCommit: string | null;
  tasks: { key: TaskKey; title: string }[];
}

export interface ProposeReleaseInput {
  title: string;
  summary: string;
  commit?: string | undefined;
}

type Deps = {
  ctx: DomainContext;
  projects: ProjectService;
  tasks: TaskService;
  inbox: InboxService;
  timeline: TimelineService;
  engines: EngineDirectory;
  /** Null: this instance is not set up for releases; every operation is refused (`release_not_configured`). */
  target: ReleaseTarget | null;
  /** The commit the running server was started from (`resolveAppVersion`); not always a commit id. */
  appVersion: () => string;
  /** The engine that holds the instance's repository. */
  engineId: (projectKey: string) => EngineId;
};

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The release of the instance itself (PM-387, PM-491): the Devops proposes, an owner approves in the
 * inbox, the release watcher claims the approved release over the control socket, deploys it and
 * reports. A release has a theme card; its timeline records every change (`release_changed`).
 */
export class ReleaseService {
  private readonly deps: Deps;
  private readonly proposals = new KeyedMutex();

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** The commit the running server runs: the control socket answers with it. */
  appVersion(): string {
    return this.deps.appVersion();
  }

  /** The releases of the project, newest first. */
  list(projectKey: string): Release[] {
    return this.deps.ctx.repos.releases.list(projectKey);
  }

  get(id: string): Release {
    const release = this.deps.ctx.repos.releases.get(id);
    if (!release) throw notFound('release', id);
    return release;
  }

  /** The project the control socket's operations are about: the release target, or `release_not_configured`. */
  controlProject(): string {
    return this.requireTarget(this.deps.target?.projectKey ?? '').projectKey;
  }

  private requireTarget(projectKey: string): ReleaseTarget {
    const { target } = this.deps;
    if (!target || target.projectKey !== projectKey)
      throw conflict('release_not_configured', `this instance does not release project ${projectKey}`);
    return target;
  }

  private merger(projectKey: string): BranchMerger {
    const engine = this.deps.engines.get(this.deps.engineId(projectKey));
    if (!engine?.merger)
      throw conflict('engine_offline', 'the engine that holds the repository is not connected');
    return engine.merger;
  }

  /** The commit a merge left on the default branch: the merge commit, or the commit that was found merged. */
  private landed(row: MergeRecord): string | null {
    return (row.startedBy ? row.mergeCommit : row.commit) ?? null;
  }

  /**
   * What a release of `commit` (default: the head of the default branch) would contain. Only a commit a
   * merge of a card recorded is a release; the base is the last release that went live, else the version the
   * server runs. The ancestry questions go to the engine that holds the repository.
   */
  async candidate(projectKey: string, commit?: string): Promise<ReleaseCandidate> {
    const { ctx } = this.deps;
    const target = this.requireTarget(projectKey);
    const rows = ctx.repos.taskMerges.mergedOf(projectKey, target.repo);
    const landed = rows.flatMap((row) => {
      const id = this.landed(row);
      return id ? [{ taskKey: row.taskKey, commit: id }] : [];
    });
    const merger = this.merger(projectKey);
    const ref = { projectKey, repo: target.repo };
    let chosen = commit;
    if (!chosen) {
      const newest = landed.at(-1);
      if (!newest) throw conflict('release_empty', 'no merged card has landed in the repository yet');
      const config = await this.deps.projects.config(projectKey);
      const base = config.project.repos.find((repo) => repo.name === target.repo)?.defaultBranch;
      if (!base)
        throw conflict('release_not_configured', `project ${projectKey} has no repository ${target.repo}`);
      chosen = (await merger.prepare(ref, { base, commit: newest.commit })).local;
    }
    if (!landed.some((entry) => entry.commit === chosen))
      throw conflict('release_commit_unknown', `${chosen} is not the result of a recorded merge of a card`, {
        commit: chosen,
      });
    const latest = ctx.repos.releases.latestLive(projectKey);
    const running = this.deps.appVersion();
    const baseCommit = latest?.commit ?? (COMMIT_ID.test(running) ? running : null);
    const keys: TaskKey[] = [];
    for (const entry of landed) {
      if (keys.includes(entry.taskKey)) continue;
      if (!(await merger.isAncestor(ref, { ancestor: entry.commit, commit: chosen }))) continue;
      if (baseCommit && (await merger.isAncestor(ref, { ancestor: entry.commit, commit: baseCommit })))
        continue;
      keys.push(entry.taskKey);
    }
    if (keys.length === 0) throw conflict('release_empty', 'there is nothing new to release');
    return {
      repo: target.repo,
      commit: chosen,
      baseCommit,
      tasks: keys.map((key) => ({ key, title: ctx.repos.tasks.get(key)?.title ?? key })),
    };
  }

  /** Whoever holds the deployment duty may propose; a release already in progress refuses another. */
  private requireProposer(config: ProjectConfig, projectKey: string, by: string): void {
    if (!dutyMembers(config, 'deployment').some((member) => member.handle === by))
      throw forbidden('insufficient_access', 'only a member with the deployment duty may propose a release');
    const open = this.deps.ctx.repos.releases.open(projectKey);
    if (open)
      throw conflict('release_open', `release ${open.id} is ${open.state}`, {
        id: open.id,
        state: open.state,
      });
  }

  /** The candidate the same checks as a proposal, with no record made. */
  async preview(projectKey: string, by: string, commit?: string): Promise<ReleaseCandidate> {
    this.requireTarget(projectKey);
    this.requireProposer(await this.deps.projects.config(projectKey), projectKey, by);
    return this.candidate(projectKey, commit);
  }

  /**
   * The Devops proposes a release: the release card (a theme), the record and the owners' approval
   * request are made together.
   */
  async propose(
    projectKey: string,
    by: string,
    input: ProposeReleaseInput,
  ): Promise<{ release: Release; candidate: ReleaseCandidate }> {
    this.requireTarget(projectKey);
    return this.proposals.run(projectKey, async () => {
      const { ctx, tasks, inbox, timeline } = this.deps;
      const config = await this.deps.projects.config(projectKey);
      this.requireProposer(config, projectKey, by);
      const candidate = await this.candidate(projectKey, input.commit);
      const description = [
        input.summary,
        '',
        '## Cards',
        ...candidate.tasks.map((task) => `- ${task.key} ${task.title}`),
        '',
        `Commit: ${candidate.commit}`,
        `Base: ${candidate.baseCommit ?? 'unknown'}`,
      ].join('\n');
      const card = await tasks.create(
        projectKey,
        { title: input.title, description, kind: 'theme' },
        aiActor(by),
      );
      try {
        const at = isoNow(ctx);
        const release: Release = {
          id: newId('rel'),
          projectKey,
          repo: candidate.repo,
          taskKey: card.key,
          state: 'proposed',
          commit: candidate.commit,
          baseCommit: candidate.baseCommit,
          tasks: candidate.tasks.map((task) => task.key),
          summary: input.summary,
          proposedBy: by,
          proposedAt: at,
          decidedBy: null,
          decidedAt: null,
          deployStartedAt: null,
          previousCommit: null,
          liveAt: null,
          tag: null,
          url: null,
          publishedAt: null,
          failure: null,
          publishError: null,
        };
        ctx.unitOfWork(() => {
          ctx.repos.releases.insert(release, at);
          inbox.create({
            projectKey,
            kind: 'release',
            assignees: this.approvers(config),
            source: by,
            taskKey: card.key,
            title: input.title,
            body: input.summary,
            payload: {
              release: {
                releaseId: release.id,
                commit: release.commit,
                baseCommit: release.baseCommit,
                tasks: candidate.tasks,
                summary: release.summary,
              },
            },
            options: DECISION_OPTIONS,
          });
          this.record(release, null, aiActor(by));
        });
        await ctx.events.emit('release_proposed', { release });
        return { release, candidate };
      } catch (err) {
        // The card of a release that could not be recorded would stay behind with nothing to show for it.
        ctx.unitOfWork(() => tasks.closeThemeBySystem(projectKey, card.key, SYSTEM_ACTOR));
        throw err;
      }
    });
  }

  /** The people who approve a release: the holders of the approval duty; else the owners. */
  private approvers(config: ProjectConfig): string[] {
    const approvers = releaseApprovers(config);
    return approvers.length > 0 ? approvers : ownerHandles(config);
  }

  /**
   * A person decided the approval item (the inbox calls this inside its resolution, the item is closed
   * here): `approve` lets the watcher deploy, `reject` ends the release and its card. Only a release
   * that still waits for the decision can be decided.
   */
  decide(item: InboxItem, by: Resolver, optionId: string, note: string | null): void {
    const { ctx, tasks, inbox } = this.deps;
    const payload = releaseApprovalOf(item);
    const release = payload ? ctx.repos.releases.get(payload.releaseId) : null;
    if (!release || release.state !== 'proposed')
      throw conflict('inbox_item_closed', 'the release is no longer waiting for a decision', { id: item.id });
    const at = isoNow(ctx);
    const approved = optionId === 'approve';
    const next: Release = {
      ...release,
      state: approved ? 'approved' : 'rejected',
      decidedBy: by.handle,
      decidedAt: at,
    };
    ctx.unitOfWork(() => {
      ctx.repos.releases.save(next, at);
      this.record(next, release.state, humanActor(by.handle), approved ? undefined : note);
      if (!approved) tasks.closeThemeBySystem(release.projectKey, release.taskKey, humanActor(by.handle));
      inbox.resolveRelease(item.id, by.handle, optionId, note);
    });
  }

  /** The release the watcher has something to do with: the oldest that is approved, deploying, or live without a tag. */
  next(): Release | null {
    return this.deps.ctx.repos.releases.next(this.controlProject());
  }

  /** The watcher starts the deploy of an approved release; `previousCommit` is where a rollback goes. */
  claim(id: string, previousCommit: string | null): Release {
    this.controlProject();
    const { ctx } = this.deps;
    const release = this.get(id);
    this.requireState(release, ['approved'], 'claim');
    const at = isoNow(ctx);
    const next: Release = { ...release, state: 'deploying', deployStartedAt: at, previousCommit };
    ctx.unitOfWork(() => {
      ctx.repos.releases.save(next, at);
      this.record(next, release.state, SYSTEM_ACTOR);
    });
    return next;
  }

  /** The watcher's result: live, failed, published or the failure to publish. */
  async report(id: string, report: ReleaseReport): Promise<Release> {
    const projectKey = this.controlProject();
    const config = await this.deps.projects.config(projectKey);
    const { ctx, tasks } = this.deps;
    const release = this.get(id);
    const at = isoNow(ctx);
    switch (report.outcome) {
      case 'live': {
        this.requireState(release, ['deploying'], 'report live');
        const running = this.deps.appVersion();
        if (running !== release.commit)
          throw conflict(
            'release_state_conflict',
            `the server runs ${running}, not the release's commit ${release.commit}`,
            { appVersion: running, commit: release.commit },
          );
        const next: Release = { ...release, state: 'live', liveAt: at, failure: null };
        ctx.unitOfWork(() => {
          ctx.repos.releases.save(next, at);
          this.record(next, release.state, SYSTEM_ACTOR);
        });
        return next;
      }
      case 'failed': {
        this.requireState(release, ['deploying'], 'report a failure');
        const next: Release = { ...release, state: 'failed', failure: report.failure };
        ctx.unitOfWork(() => {
          ctx.repos.releases.save(next, at);
          this.record(next, release.state, SYSTEM_ACTOR);
          tasks.closeThemeBySystem(release.projectKey, release.taskKey, SYSTEM_ACTOR);
          this.alert(config, next, report.failure);
        });
        return next;
      }
      case 'published': {
        this.requireState(release, ['live'], 'report published');
        const next: Release = {
          ...release,
          state: 'published',
          tag: report.tag,
          url: report.url,
          publishedAt: at,
          publishError: null,
        };
        ctx.unitOfWork(() => {
          ctx.repos.releases.save(next, at);
          this.record(next, release.state, SYSTEM_ACTOR);
          // The outcome is the release record and its events; the card ends as every theme does.
          tasks.closeThemeBySystem(release.projectKey, release.taskKey, SYSTEM_ACTOR);
        });
        return next;
      }
      case 'publish_failed': {
        this.requireState(release, ['live'], 'report a publishing failure');
        const next: Release = { ...release, publishError: report.message };
        ctx.unitOfWork(() => {
          ctx.repos.releases.save(next, at);
          this.record(next, release.state, SYSTEM_ACTOR);
          // The watcher retries the publishing: the owners are told about the first failure only.
          if (release.publishError === null)
            this.alert(config, next, { step: 'publish', message: report.message, rolledBack: false });
        });
        return next;
      }
    }
  }

  private requireState(release: Release, allowed: Release['state'][], what: string): void {
    if (!allowed.includes(release.state))
      throw conflict('release_state_conflict', `cannot ${what}: release ${release.id} is ${release.state}`, {
        id: release.id,
        state: release.state,
      });
  }

  /** `release_changed` on the release card. */
  private record(
    release: Release,
    previousState: Release['state'] | null,
    actor: Parameters<TimelineService['append']>[0]['actor'],
    /** The reason a person gave when they rejected the release; left out when empty. */
    note?: string | null,
  ): void {
    this.deps.timeline.append({
      projectKey: release.projectKey,
      taskKey: release.taskKey,
      actor,
      type: 'release_changed',
      data: {
        releaseId: release.id,
        state: release.state,
        previousState,
        commit: release.commit,
        ...(release.tag ? { tag: release.tag } : {}),
        ...(release.url ? { url: release.url } : {}),
        ...(release.failure ? { failure: release.failure } : {}),
        ...(release.publishError ? { publishError: release.publishError } : {}),
        ...(release.state === 'rejected' && note?.trim() ? { note: note.trim() } : {}),
      },
    });
  }

  private alert(config: ProjectConfig, release: Release, failure: ReleaseFailure): void {
    this.deps.inbox.create({
      projectKey: release.projectKey,
      kind: 'alert',
      assignees: this.approvers(config),
      source: 'system',
      taskKey: release.taskKey,
      title: `Release ${release.commit.slice(0, 8)} failed in ${failure.step}`,
      body: failure.message,
      payload: {
        alert: 'release_failed',
        releaseId: release.id,
        taskKey: release.taskKey,
        commit: release.commit,
        step: failure.step,
        message: failure.message,
        rolledBack: failure.rolledBack,
      },
      options: [ALERT_SEEN_OPTION],
    });
  }
}
