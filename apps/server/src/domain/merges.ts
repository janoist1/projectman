import path from 'node:path';
import {
  ALERT_SEEN_OPTION,
  alertPayloadOf,
  mergeRequestOf,
  cardMerger,
  mergeReadiness,
  mergeRepoOf,
  mergeTargetOf,
  memberOf,
  stageOwners,
  isCodeReviewStage,
  isOpenTask,
} from '@projectman/shared';
import type { Actor, MergeBlockReason, MergeFailure, ProjectConfig, Task } from '@projectman/shared';
import type { BranchMerger, EngineDirectory, GithubService } from '../contracts';
import { mergedState } from '../db';
import type { MergeRecord } from '../db';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, DomainError, forbidden } from './errors';
import type { InboxService } from './inbox';
import type { Messaging } from './messaging';
import type { ProjectService } from './projects';
import { fullTestSandbox } from './session-policy';
import type { SessionOrchestrator } from './sessions';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { actorHandle, newId, SYSTEM_ACTOR, KeyedMutex } from './util';

type Deps = {
  ctx: DomainContext;
  projects: ProjectService;
  tasks: TaskService;
  sessions: SessionOrchestrator;
  messaging: Messaging;
  timeline: TimelineService;
  engines: EngineDirectory;
  github: GithubService;
  inbox: InboxService;
  afterMerge: (task: Task) => Promise<void>;
};
type Active = { row: MergeRecord; controller: AbortController; pushing: boolean; promise: Promise<void> };

/** Durable FIFO per project/repository; all git and sandbox work stays on the card's engine. */
export class Merges {
  private readonly active = new Map<string, Active>();
  private stopped = false;
  private readonly cards = new KeyedMutex();
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  private reviewer(config: ProjectConfig, task: Task): string | null {
    const target = mergeTargetOf(config);
    const stages = config.pipeline.stages.slice(
      0,
      config.pipeline.stages.findIndex((s) => s.id === target?.id),
    );
    const review = stages.reverse().find((s) => isCodeReviewStage(config, s));
    if (!review) return null;
    const owners = stageOwners(config, review);
    const events = this.deps.ctx.repos.timeline.listOfTypes(
      task.projectKey,
      task.key,
      ['task_labels_changed'],
      200,
    );
    for (const event of [...events].reverse())
      if (
        event.actor.handle &&
        owners.includes(event.actor.handle) &&
        Array.isArray(event.data.added) &&
        event.data.added.length
      )
        return event.actor.handle;
    return null;
  }

  async source(
    config: ProjectConfig,
    task: Task,
    allowDirty = false,
  ): Promise<{ commit: string; branch: string } | null> {
    const handed = this.deps.ctx.repos.taskHandovers.get(task.projectKey, task.key) ?? task.reviewPin;
    if (handed) return { commit: handed.commit, branch: handed.branch };
    const head = await this.deps.sessions.sourceHead(config, task, { strict: true });
    if (head?.dirty && !allowDirty)
      throw conflict('handover_uncommitted', 'commit the task work before merging');
    return head ? { commit: head.commit, branch: head.branch } : null;
  }

  async reconcile(projectKey: string, taskKey: string): Promise<void> {
    await this.cards.run(`${projectKey}:${taskKey}`, () => this.reconcileCard(projectKey, taskKey));
  }
  private async reconcileCard(projectKey: string, taskKey: string): Promise<void> {
    const { ctx, tasks, projects } = this.deps;
    const task = tasks.find(projectKey, taskKey);
    if (!task) return;
    const config = await projects.config(projectKey);
    const ready = isOpenTask(task) ? mergeReadiness(config, task) : { ready: false as const };
    const merger = cardMerger(config, task, this.reviewer(config, task));
    const existing = ctx.repos.taskMerges.open(projectKey, taskKey);
    if (existing) {
      if (existing.state === 'queued' || existing.state === 'running') return;
      const cancel =
        existing.merger !== merger ||
        (!ready.ready &&
          (existing.state !== 'blocked' || task.stageId !== existing.fromStageId || !isOpenTask(task)));
      if (!cancel) {
        await this.notify(existing, config);
        return;
      }
      ctx.unitOfWork(() => {
        this.save(existing, { state: 'cancelled', finishedAt: isoNow(ctx) });
        this.clearAlert(existing);
      });
      await this.release(existing, this.engine(task)?.merger);
    }
    if (!ready.ready || !merger) return;
    let source;
    try {
      source = await this.source(config, task, true);
    } catch (err) {
      ctx.logger.warn({ err, taskKey }, 'could not read a merge request source');
      return;
    }
    if (!source || (task.merged?.commit === source.commit && task.merged.repo === ready.repo.name)) return;
    let row: MergeRecord | undefined;
    ctx.unitOfWork(() => {
      const current = tasks.get(projectKey, taskKey);
      if (!mergeReadiness(config, current).ready || ctx.repos.taskMerges.open(projectKey, taskKey)) return;
      const at = isoNow(ctx);
      row = {
        id: newId('merge'),
        projectKey,
        taskKey,
        repo: ready.repo.name,
        base: ready.repo.defaultBranch,
        fromStageId: current.stageId,
        toStageId: ready.target.id,
        merger,
        requestedAt: at,
        state: 'requested',
        landed: 'nowhere',
        createdAt: at,
        updatedAt: at,
      };
      ctx.repos.taskMerges.save(row);
      tasks.publish(current);
      this.deps.timeline.append({
        projectKey,
        taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_merge_requested',
        data: { mergeId: row.id, merger, repo: row.repo, base: row.base, toStageId: row.toStageId },
      });
    });
    if (row) await this.notify(row, config);
  }

  async start(projectKey: string, taskKey: string, actor: Actor): Promise<Task> {
    return this.cards.run(`${projectKey}:${taskKey}`, async () => {
      await this.reconcileCard(projectKey, taskKey);
      const { ctx, tasks, projects } = this.deps;
      const task = tasks.get(projectKey, taskKey),
        config = await projects.config(projectKey);
      const row = ctx.repos.taskMerges.open(projectKey, taskKey);
      const merger = row?.merger ?? cardMerger(config, task, this.reviewer(config, task));
      if (!merger || actorHandle(actor) !== merger)
        throw forbidden('merge_not_merger', 'only the card merger may start the merge');
      const readiness = mergeReadiness(config, task);
      if (!readiness.ready)
        throw conflict('merge_not_ready', 'the card is not ready to merge', { reason: readiness.reason });
      if (row?.state === 'queued' || row?.state === 'running') return task;
      if (!row) throw conflict('merge_not_ready', 'the card has no work to merge', { reason: 'no_merge' });
      const source = await this.source(config, task);
      if (!source) throw conflict('merge_not_ready', 'the card has no commit', { reason: 'no_merge' });
      ctx.unitOfWork(() => {
        const current = tasks.get(projectKey, taskKey),
          ready = mergeReadiness(config, current);
        if (!ready.ready)
          throw conflict('merge_not_ready', 'the card is no longer ready', { reason: ready.reason });
        const persisted = ctx.repos.taskMerges.open(projectKey, taskKey);
        if (persisted?.id !== row.id || current.stageId !== row.fromStageId)
          throw conflict('merge_not_ready', 'the merge request changed while reading the source', {
            reason: 'not_before_target',
          });
        this.save(row, {
          ...(row.landed === 'remote' ? {} : source),
          state: 'queued',
          step: 'queued',
          startedBy: actorHandle(actor),
          startedAt: isoNow(ctx),
          block: undefined,
          failure: undefined,
          finishedAt: undefined,
          ...(row.landed === 'remote'
            ? {}
            : { mergeCommit: undefined, check: undefined, pushed: undefined, pullRequests: undefined }),
        });
        this.clearAlert(row, actorHandle(actor));
      });
      this.pump();
      return tasks.get(projectKey, taskKey);
    });
  }

  private engine(task: Task) {
    return this.deps.engines.get(this.deps.sessions.cardEngineId(task.projectKey, task));
  }

  async checkGate(config: ProjectConfig, task: Task, targetId: string): Promise<void> {
    const repo = mergeRepoOf(config, task, task.stageId, targetId);
    if (!repo) return;
    let source;
    try {
      source = await this.source(config, task);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'handover_uncommitted') throw err;
      await this.reconcile(task.projectKey, task.key);
      throw conflict('task_not_merged', 'could not read the approved source commit', {
        reason: 'engine_unavailable',
        merger: cardMerger(config, task, this.reviewer(config, task)),
        base: repo.defaultBranch,
      });
    }
    if (!source) return;
    if (task.merged?.commit === source.commit && task.merged.repo === repo.name) return;
    const merger = this.engine(task)?.merger;
    let reason: 'not_merged' | 'not_on_remote' | 'engine_unavailable' = 'engine_unavailable';
    if (merger) {
      try {
        const base = await merger.prepare(
          { projectKey: task.projectKey, repo: repo.name },
          { base: repo.defaultBranch, commit: source.commit },
        );
        if (base.contains.local && base.contains.remote !== false) {
          if (this.deps.ctx.repos.taskHandovers.get(task.projectKey, task.key))
            this.deps.ctx.unitOfWork(() => {
              this.cancel(task.projectKey, task.key);
              const at = isoNow(this.deps.ctx);
              const row: MergeRecord = {
                id: newId('merge'),
                projectKey: task.projectKey,
                taskKey: task.key,
                ...source,
                repo: repo.name,
                base: repo.defaultBranch,
                fromStageId: task.stageId,
                toStageId: mergeTargetOf(config)!.id,
                merger: cardMerger(config, task, this.reviewer(config, task)) ?? 'system',
                requestedAt: at,
                state: 'merged',
                landed: 'nowhere',
                createdAt: at,
                updatedAt: at,
                finishedAt: at,
              };
              this.deps.ctx.repos.taskMerges.save(row);
              this.deps.timeline.append({
                projectKey: task.projectKey,
                taskKey: task.key,
                actor: SYSTEM_ACTOR,
                type: 'task_merged',
                data: mergedState(row)!,
              });
              this.deps.tasks.publish(task);
            });
          return;
        }
        reason = base.contains.local && base.contains.remote === false ? 'not_on_remote' : 'not_merged';
      } catch (err) {
        this.deps.ctx.logger.warn({ err, taskKey: task.key }, 'could not check the merge target');
      }
    }
    await this.reconcile(task.projectKey, task.key);
    throw conflict('task_not_merged', 'the approved commit is not on the default branch', {
      reason,
      merger: cardMerger(config, task, this.reviewer(config, task)),
      base: repo.defaultBranch,
    });
  }

  async init(): Promise<void> {
    this.stopped = false;
    const { ctx } = this.deps;
    for (const row of ctx.repos.taskMerges.list('running'))
      this.save(row, { state: 'queued', step: 'queued' });
    // Known abandoned check worktrees are released before any new check is made.
    for (const state of ['queued', 'blocked'] as const) {
      for (const row of ctx.repos.taskMerges.list(state)) {
        const task = this.deps.tasks.find(row.projectKey, row.taskKey);
        if (!task) continue;
        const engine = this.deps.engines.get(this.deps.sessions.cardEngineId(row.projectKey, task));
        await this.release(row, engine?.merger);
      }
    }
    for (const project of this.deps.projects.summaries())
      for (const task of this.deps.tasks.list(project.key))
        if (isOpenTask(task)) await this.reconcile(project.key, task.key);
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const running of this.active.values()) if (!running.pushing) running.controller.abort();
    await Promise.all([...this.active.values()].map((running) => running.promise));
  }

  pump(): void {
    if (this.stopped) return;
    for (const row of this.deps.ctx.repos.taskMerges.list('queued')) {
      const key = `${row.projectKey}:${row.repo}`;
      if (this.active.has(key)) continue;
      const running: Active = {
        row,
        controller: new AbortController(),
        pushing: row.landed === 'remote',
        promise: Promise.resolve(),
      };
      this.active.set(key, running);
      running.promise = this.execute(row, running)
        .catch(async (err: unknown) => {
          if (!this.continue(row, running)) return;
          await this.block(row, 'merge_error', err instanceof Error ? err.message : 'merge failed');
        })
        .finally(async () => {
          const task = this.deps.tasks.find(row.projectKey, row.taskKey);
          const engine = task
            ? this.deps.engines.get(this.deps.sessions.cardEngineId(row.projectKey, task))
            : null;
          await this.release(row, engine?.merger);
          this.active.delete(key);
          this.pump();
        });
    }
  }

  cancel(projectKey: string, taskKey: string, effects?: (() => Promise<void>)[]): void {
    const row = this.deps.ctx.repos.taskMerges.open(projectKey, taskKey);
    if (!row) return;
    const running = this.active.get(`${row.projectKey}:${row.repo}`);
    const afterCommit = (effect: () => Promise<void>) => {
      if (effects) effects.push(effect);
      else void effect();
    };
    if (running?.row.id === row.id && !running.pushing)
      afterCommit(async () => {
        running.controller.abort();
      });
    if (row.state === 'running') {
      return;
    }
    this.save(row, { state: 'cancelled', finishedAt: isoNow(this.deps.ctx) });
    this.clearAlert(row);
    const task = this.deps.tasks.find(projectKey, taskKey);
    if (task)
      afterCommit(() =>
        this.release(row, this.deps.engines.get(this.deps.sessions.cardEngineId(projectKey, task))?.merger),
      );
  }

  private ref(row: MergeRecord) {
    return { projectKey: row.projectKey, repo: row.repo };
  }
  private async release(row: MergeRecord, merger?: BranchMerger): Promise<void> {
    await merger
      ?.releaseCheck(this.ref(row), { mergeId: row.id })
      .catch((err: unknown) =>
        this.deps.ctx.logger.warn(
          {
            err,
            mergeId: row.id,
            engineId: this.deps.tasks.find(row.projectKey, row.taskKey)
              ? this.deps.sessions.cardEngineId(
                  row.projectKey,
                  this.deps.tasks.get(row.projectKey, row.taskKey),
                )
              : undefined,
          },
          'could not release a merge checkout',
        ),
      );
  }
  private save(row: MergeRecord, patch: Partial<MergeRecord>): void {
    Object.assign(row, patch, { updatedAt: isoNow(this.deps.ctx) });
    this.deps.ctx.repos.taskMerges.save(row);
    const task = this.deps.tasks.find(row.projectKey, row.taskKey);
    if (task) this.deps.tasks.publish(task);
  }
  private continue(row: MergeRecord, running: Active): boolean {
    const persisted = this.deps.ctx.repos.taskMerges.get(row.id);
    if (!persisted || (persisted.state !== 'queued' && persisted.state !== 'running')) return false;
    if (running.pushing) return true;
    const task = this.deps.tasks.find(row.projectKey, row.taskKey);
    if (!task || !isOpenTask(task) || task.stageId !== row.fromStageId || running.controller.signal.aborted) {
      if (this.stopped && task && isOpenTask(task) && task.stageId === row.fromStageId) {
        this.save(row, { state: 'queued', step: 'queued' });
      } else {
        this.save(row, { state: 'cancelled', finishedAt: isoNow(this.deps.ctx) });
        this.clearAlert(row);
      }
      return false;
    }
    return true;
  }

  private async execute(row: MergeRecord, running: Active): Promise<void> {
    const { projects, tasks, sessions, engines, github, ctx } = this.deps;
    if (!this.continue(row, running)) return;
    const config = await projects.config(row.projectKey);
    if (!this.continue(row, running)) return;
    const task = tasks.get(row.projectKey, row.taskKey);
    const repo = config.project.repos.find((repo) => repo.name === row.repo);
    const engine = engines.get(sessions.cardEngineId(row.projectKey, task));
    const merger = engine?.merger;
    if (!engine || !merger) return this.block(row, 'engine_unavailable', 'the card engine cannot merge');
    if (!repo) return this.block(row, 'merge_error', 'the repository no longer exists');
    if (!row.commit || !row.branch) return this.block(row, 'merge_error', 'the merge has no source commit');
    const commit = row.commit,
      branch = row.branch;
    this.save(row, { state: 'running', step: 'merging', block: undefined });
    const ref = this.ref(row);
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = await merger.prepare(ref, { base: row.base, commit: commit });
      if (!this.continue(row, running)) return;
      // A crash may fall between the git push/advance and the following durable write.
      if (
        row.mergeCommit &&
        base.remote &&
        (await merger.isAncestor(ref, { ancestor: row.mergeCommit, commit: base.remote.commit }))
      ) {
        running.pushing = true;
        this.save(row, {
          landed: 'remote',
          pushed: {
            remote: base.remote.name,
            ...(repo.github
              ? { commitUrl: `https://github.com/${repo.github}/commit/${row.mergeCommit}` }
              : {}),
          },
        });
      } else if (
        row.mergeCommit &&
        !base.remote &&
        (await merger.isAncestor(ref, { ancestor: row.mergeCommit, commit: base.local }))
      ) {
        return this.finish(row, config);
      }
      if (row.landed === 'remote') {
        if (!row.mergeCommit) return this.block(row, 'merge_error', 'the landed merge has no commit');
        const advance = await merger.advance(ref, { base: row.base, from: base.local, to: row.mergeCommit });
        if (!advance.ok) return this.block(row, 'local_checkout', advance.message);
        return this.finish(row, config);
      }
      if (base.contains.local && base.contains.remote !== false && !row.mergeCommit) {
        const latest = await projects.config(row.projectKey);
        if (!this.continue(row, running)) return;
        if (!mergeReadiness(latest, tasks.get(row.projectKey, row.taskKey)).ready)
          return this.block(row, 'gate_changed', 'the card is no longer ready to merge');
        this.save(row, { mergeCommit: base.remote?.commit ?? base.local });
        return this.finish(row, latest);
      }
      if (base.relation === 'local_ahead' || base.relation === 'diverged')
        return this.block(
          row,
          'base_out_of_sync',
          'the local default branch is ahead of or diverged from its upstream',
        );
      const onto = base.remote?.commit ?? base.local;
      const prs: NonNullable<MergeRecord['pullRequests']> = [];
      for (const link of task.links.filter(
        (link) => link.kind === 'pull_request' && link.repo === repo.github,
      )) {
        let pr;
        try {
          pr = await github.getPullRequest(repo.github!, Number(link.ref));
        } catch (err) {
          return this.block(
            row,
            'pull_request',
            err instanceof Error ? err.message : 'could not read the linked pull request',
          );
        }
        if (!this.continue(row, running)) return;
        if (pr.state !== 'open') continue;
        if (
          pr.baseRef !== row.base ||
          !pr.headSha ||
          !(pr.headSha === commit || (await merger.isAncestor(ref, { ancestor: pr.headSha, commit: commit })))
        )
          return this.block(
            row,
            'pull_request',
            'the linked pull request does not match the approved commit and base',
          );
        prs.push({ number: pr.number, url: pr.url });
      }
      if (!this.continue(row, running)) return;
      const built = await merger.build(ref, {
        onto,
        commit: commit,
        message: `Merge ${task.key}: ${task.title.replace(/[\r\n]/g, ' ').slice(0, 100)}\n\nBranch ${branch}, approved commit ${commit}.`,
      });
      if (!this.continue(row, running)) return;
      if (!built.ok)
        return this.fail(row, config, {
          reason: 'conflict',
          base: onto,
          at: isoNow(ctx),
          files: built.conflict.slice(0, 50),
        });
      this.save(row, { mergeCommit: built.mergeCommit, pullRequests: prs, check: undefined });
      const conflicts = await merger.checkoutConflicts(ref, { base: row.base, changed: built.changed });
      if (!this.continue(row, running)) return;
      if (conflicts.length)
        return this.block(row, 'local_checkout', 'uncommitted files overlap the merge', conflicts.join('\n'));
      if (repo.reviewTest) {
        this.save(row, { step: 'checking' });
        const passed = ctx.repos.fullTestRuns
          .forCommit(task.key, commit)
          .find(
            (run) => run.status === 'passed' && run.projectKey === row.projectKey && run.repo === row.repo,
          );
        if (passed && (await merger.isAncestor(ref, { ancestor: onto, commit: commit }))) {
          this.save(row, {
            check: { command: repo.reviewTest.command, status: 'passed', runId: passed.id, reused: true },
          });
        } else {
          const executor = engine.fullTestExecutor;
          if (!executor || !(await executor.available()).ok)
            return this.block(row, 'check_unavailable', 'no full test executor is available');
          if (!this.continue(row, running)) return;
          let result;
          const runId = newId('mergecheck');
          try {
            const worktree = await engine.worktrees.find({
              project: config,
              repoName: repo.name,
              taskKey: task.key,
            });
            if (!this.continue(row, running)) return;
            const checkout = await merger.checkoutForCheck(ref, {
              mergeId: row.id,
              mergeCommit: built.mergeCommit,
              depsFrom:
                worktree?.path ??
                (engine.workspacePath(row.projectKey)
                  ? path.resolve(engine.workspacePath(row.projectKey)!, repo.path)
                  : null),
            });
            if (!this.continue(row, running)) return;
            const paths = engine.paths();
            result = await executor.run(
              {
                runId,
                cwd: checkout.path,
                command: repo.reviewTest.command,
                maxWorkers: repo.reviewTest.maxWorkers,
                timeoutMs: repo.reviewTest.timeoutMinutes * 60_000,
                sandbox: fullTestSandbox({
                  checkout: checkout.path,
                  gitDir: checkout.gitDir,
                  userHome: paths.userHome,
                  appHome: paths.home ?? undefined,
                  closedTmpRoots: [
                    ...paths.claudeTmpRoots,
                    ...(paths.sessionTmpRoot ? [path.dirname(paths.sessionTmpRoot)] : []),
                  ],
                }),
              },
              running.controller.signal,
            );
          } catch (err) {
            if (!this.continue(row, running)) return;
            return this.block(
              row,
              'check_error',
              'the merge check could not run',
              err instanceof Error ? err.message : 'check failed',
            );
          } finally {
            await this.release(row, merger);
          }
          if (!this.continue(row, running)) return;
          this.save(row, { check: { command: repo.reviewTest.command, runId, status: result.outcome } });
          if (result.outcome === 'failed')
            return this.fail(row, config, {
              reason: 'check_failed',
              base: onto,
              at: isoNow(ctx),
              command: repo.reviewTest.command,
              runId,
              outputTail: result.outputTail.split('\n').slice(-40).join('\n').slice(-8000),
            });
          if (result.outcome === 'error')
            return this.block(row, 'check_error', 'the merge check could not run', result.outputTail);
        }
      }
      if (!this.continue(row, running)) return;
      const latest = await projects.config(row.projectKey);
      const current = tasks.get(row.projectKey, row.taskKey);
      if (!this.continue(row, running)) return;
      if (!mergeReadiness(latest, current).ready)
        return this.block(row, 'gate_changed', 'the card is no longer ready to merge');
      if (base.remote) {
        this.save(row, { step: 'pushing' });
        running.pushing = true;
        const pushed = await merger.push(ref, { base: row.base, mergeCommit: built.mergeCommit });
        if (!pushed.ok) {
          if (pushed.reason === 'non_fast_forward') {
            if (attempt === 0) {
              running.pushing = false;
              this.save(row, { mergeCommit: undefined, check: undefined, step: 'merging' });
              continue;
            }
            return this.block(row, 'remote_moved', pushed.message);
          }
          return this.block(
            row,
            pushed.reason === 'rejected' ? 'push_rejected' : 'remote_unreachable',
            pushed.message,
          );
        }
        this.save(row, {
          landed: 'remote',
          pushed: {
            remote: base.remote.name,
            ...(repo.github
              ? { commitUrl: `https://github.com/${repo.github}/commit/${built.mergeCommit}` }
              : {}),
          },
        });
      }
      if (!this.continue(row, running)) return;
      const advance = await merger.advance(ref, { base: row.base, from: base.local, to: built.mergeCommit });
      if (!advance.ok) return this.block(row, 'local_checkout', advance.message);
      return this.finish(row, latest);
    }
  }

  private async finish(row: MergeRecord, config: ProjectConfig): Promise<void> {
    const { ctx, timeline, tasks } = this.deps;
    ctx.unitOfWork(() => {
      this.save(row, { state: 'merged', step: 'finishing', finishedAt: isoNow(ctx) });
      this.clearAlert(row);
      timeline.append({
        projectKey: row.projectKey,
        taskKey: row.taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_merged',
        data: { ...mergedState(row)!, mergeId: row.id },
      });
    });
    await this.notify(row, config);
    const task = tasks.find(row.projectKey, row.taskKey);
    if (task) await this.deps.afterMerge(task);
  }

  private async block(
    row: MergeRecord,
    reason: MergeBlockReason,
    message: string,
    detail?: string,
  ): Promise<void> {
    const { ctx, timeline, inbox, projects } = this.deps;
    const config = await projects.config(row.projectKey);
    const running = this.active.get(`${row.projectKey}:${row.repo}`);
    if (running && !this.continue(row, running)) return;
    ctx.unitOfWork(() => {
      this.save(row, {
        state: 'blocked',
        step: undefined,
        finishedAt: undefined,
        block: { reason, message, at: isoNow(ctx), ...(detail ? { detail: detail.slice(-8000) } : {}) },
      });
      timeline.append({
        projectKey: row.projectKey,
        taskKey: row.taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_merge_blocked',
        data: {
          mergeId: row.id,
          repo: row.repo,
          base: row.base,
          reason,
          message,
          landed: row.landed,
          ...(row.mergeCommit ? { mergeCommit: row.mergeCommit } : {}),
        },
      });
      if (
        memberOf(config, row.merger)?.kind === 'human' &&
        !inbox.list(row.projectKey, { kind: 'alert', taskKey: row.taskKey }).some((item) => {
          const alert = alertPayloadOf(item);
          return alert?.alert === 'merge_blocked' && alert.mergeId === row.id && item.state === 'open';
        })
      ) {
        inbox.create({
          projectKey: row.projectKey,
          taskKey: row.taskKey,
          kind: 'alert',
          assignees: [row.merger],
          source: 'system',
          title: message,
          payload: { alert: 'merge_blocked', taskKey: row.taskKey, mergeId: row.id, reason, message },
          options: [ALERT_SEEN_OPTION],
        });
      }
    });
    await this.notify(row, config);
  }

  private clearAlert(row: MergeRecord, by?: string): void {
    for (const item of this.deps.inbox.list(row.projectKey, { taskKey: row.taskKey, state: 'open' })) {
      const alert = alertPayloadOf(item);
      const request = mergeRequestOf(item);
      if (request?.mergeId === row.id && by) this.deps.inbox.resolveMergeRequest(item.id, by);
      else if (request?.mergeId === row.id || (alert?.alert === 'merge_blocked' && alert.mergeId === row.id))
        this.deps.inbox.cancel(item.id);
    }
  }

  private async fail(row: MergeRecord, config: ProjectConfig, failure: MergeFailure): Promise<void> {
    const { ctx, timeline } = this.deps;
    ctx.unitOfWork(() => {
      this.save(row, { state: 'failed', step: undefined, failure, block: undefined });
      this.clearAlert(row);
      timeline.append({
        projectKey: row.projectKey,
        taskKey: row.taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_merge_failed',
        data: { ...failure, mergeId: row.id },
      });
    });
    await this.notify(row, config);
  }

  private async notify(row: MergeRecord, config: ProjectConfig): Promise<void> {
    const member = memberOf(config, row.merger);
    if (!member) return;
    if (member.kind === 'human' && (row.state === 'requested' || row.state === 'failed')) {
      if (
        this.deps.inbox
          .list(row.projectKey, { taskKey: row.taskKey, state: 'open' })
          .some((item) => mergeRequestOf(item)?.mergeId === row.id)
      )
        return;
      this.deps.inbox.create({
        projectKey: row.projectKey,
        taskKey: row.taskKey,
        kind: 'merge_request',
        assignees: [row.merger],
        source: 'system',
        title: `Merge ${row.taskKey} into ${row.base}`,
        payload: {
          mergeRequest: {
            taskKey: row.taskKey,
            mergeId: row.id,
            repo: row.repo,
            base: row.base,
            ...(row.failure ? { failure: row.failure } : {}),
          },
        },
        options: [{ id: 'merge', label: 'Merge', style: 'primary' }],
      });
      return;
    }
    if (row.state === 'blocked' && member.kind === 'human') return;
    const type =
      row.state === 'failed'
        ? 'task_merge_failed'
        : row.state === 'blocked'
          ? 'task_merge_blocked'
          : row.state === 'merged'
            ? 'task_merged'
            : 'task_merge_requested';
    const event = this.deps.ctx.repos.timeline.latestOfType(row.projectKey, row.taskKey, type);
    if (
      event &&
      this.deps.ctx.repos.messages
        .list(row.projectKey, { taskKey: row.taskKey })
        .some((message) => message.origin?.kind === 'note' && message.origin.eventId === event.id)
    )
      return;
    const text =
      row.state === 'merged'
        ? `Merge ${row.taskKey} into ${row.repo}/${row.base} completed at ${row.mergeCommit}.`
        : row.state === 'failed'
          ? `Merge ${row.taskKey} failed (${row.failure!.reason}).\n${row.failure!.files?.join('\n') ?? row.failure!.outputTail ?? ''}\nFix only simple mechanical conflicts with the merge tool; otherwise send the card back with update_task and explain the failure. Retry with merge_task when ready.`
          : row.state === 'blocked'
            ? `Merge ${row.taskKey} blocked (${row.block!.reason}): ${row.block!.message}. Retry with merge_task after fixing the cause; use ask_human if you cannot resolve it.`
            : `Merge ${row.taskKey}'s approved commit into ${row.repo}/${row.base} before entering ${row.toStageId}. Call merge_task; never merge or push manually.`;
    await this.deps.messaging.send(
      row.projectKey,
      'system',
      { to: [row.merger], taskKey: row.taskKey, text },
      {
        actor: SYSTEM_ACTOR,
        kind: row.state === 'merged' ? 'info' : 'action',
        ownCard: true,
        ...(event ? { origin: { kind: 'note', eventId: event.id } } : {}),
      },
    );
  }
}
