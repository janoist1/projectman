import {
  cardMerger,
  mergeReadiness,
  mergeRepoOf,
  mergeTargetOf,
  stageOwners,
  isCodeReviewStage,
  isOpenTask,
  isOperatorActor,
} from '@projectman/shared';
import type { Actor, ProjectConfig, RepoConfig, Task } from '@projectman/shared';
import { Effect, Exit, Scope } from 'effect';
import { mergedState } from '../../db';
import type { MergeRecord } from '../../db';
import { isoNow } from '../../domain/context';
import { ownerHandles } from '../../domain/access';
import { conflict, DomainError, forbidden } from '../../domain/errors';
import { actorHandle, newId, SYSTEM_ACTOR } from '../../domain/util';
import { runFork, runPromise } from '../../kernel';
import { MergeCardLock } from '../../kernel';
import type { MergeDeps } from './deps';
import type { MergeSlotPeer } from './ports';
import { makeMergeQueue } from './queue';
import type { MergeQueueEffects } from './queue';
import { MergeSteps } from './steps';

/** Durable FIFO per project/repository; all git and sandbox work stays on the card's engine. */
export class Merges {
  private stopped = false;
  private peer: MergeSlotPeer | null = null;
  private readonly cards: MergeCardLock;
  private readonly deps: MergeDeps;
  private readonly steps: MergeSteps;
  private scope = Scope.makeUnsafe();
  private queue: MergeQueueEffects;
  constructor(deps: MergeDeps) {
    this.deps = deps;
    this.cards = deps.cards ?? new MergeCardLock();
    this.steps = new MergeSteps(deps, this.cards, { pump: () => this.pump(), stopped: () => this.stopped });
    this.queue = this.makeQueue();
  }

  private makeQueue(): MergeQueueEffects {
    return Effect.runSync(
      Scope.provide(
        makeMergeQueue({
          ctx: this.deps.ctx,
          tasks: this.deps.tasks,
          steps: this.steps,
          peer: () => this.peer,
          stopped: () => this.stopped,
        }),
        this.scope,
      ),
    );
  }

  /** The member who merges this card (cardMerger with the card's code reviewer); null: nobody can. */
  mergerOf(config: ProjectConfig, task: Task): string | null {
    return cardMerger(config, task, this.reviewer(config, task));
  }

  /** The `task_not_merged` refusal of a move whose work is not on the base branch. */
  notMergedError(
    config: ProjectConfig,
    task: Task,
    repo: RepoConfig,
    reason: 'not_merged' | 'not_on_remote' | 'engine_unavailable',
    message = 'the approved commit is not on the default branch',
  ) {
    return conflict('task_not_merged', message, {
      reason,
      merger: this.mergerOf(config, task),
      base: repo.defaultBranch,
    });
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
    await this.cards.run(projectKey, taskKey, () => this.reconcileCard(projectKey, taskKey));
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
        await this.steps.notify(existing, config);
        return;
      }
      ctx.unitOfWork(() => {
        this.steps.save(existing, { state: 'cancelled', finishedAt: isoNow(ctx) });
        this.steps.clearAlert(existing);
      });
      await this.steps.release(existing, this.steps.engine(task)?.merger);
    }
    if (!ready.ready || !merger) return;
    let source;
    try {
      source = await this.source(config, task, true);
    } catch (err) {
      ctx.logger.warn({ err, taskKey }, 'could not read a merge request source');
      return;
    }
    if (!source || (await this.steps.includesApproved(task, ready.repo.name, source.commit))) return;
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
    if (row) await this.steps.notify(row, config);
  }

  async start(
    projectKey: string,
    taskKey: string,
    actor: Actor,
    options: { fixConflict?: boolean; resolution?: string } = {},
  ): Promise<Task> {
    return this.cards.run(projectKey, taskKey, async () => {
      if (options.fixConflict || options.resolution !== undefined)
        return this.steps.fix(projectKey, taskKey, actor, options);
      await this.reconcileCard(projectKey, taskKey);
      const { ctx, tasks, projects } = this.deps;
      const task = tasks.get(projectKey, taskKey),
        config = await projects.config(projectKey);
      const row = ctx.repos.taskMerges.open(projectKey, taskKey);
      if (row?.state === 'fixing')
        throw conflict('merge_fix_not_allowed', 'submit the committed fix with resolution', {
          reason: 'not_conflict',
        });
      const merger = row?.merger ?? cardMerger(config, task, this.reviewer(config, task));
      if (!merger || actorHandle(actor) !== merger)
        throw forbidden('merge_not_merger', 'only the card merger may start the merge');
      const readiness = mergeReadiness(config, task);
      if (!readiness.ready)
        throw conflict('merge_not_ready', 'the card is not ready to merge', { reason: readiness.reason });
      if (row?.state === 'queued' || row?.state === 'running') return task;
      if (!row) throw conflict('merge_not_ready', 'the card has no work to merge', { reason: 'no_merge' });
      const approvedSource = await this.source(config, task);
      const source =
        row.fix && row.resolution
          ? { commit: row.resolution.commit, branch: row.fix.branch }
          : approvedSource;
      if (
        row.fix &&
        row.resolution &&
        approvedSource &&
        !(await this.steps.engine(task)?.merger?.isAncestor(this.steps.ref(row), {
          ancestor: approvedSource.commit,
          commit: row.resolution.commit,
        }))
      )
        throw conflict('merge_fix_invalid', 'the fix no longer contains the approved source', {
          reason: 'missing_commit',
        });
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
        this.steps.save(row, {
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
        this.steps.clearAlert(row, actorHandle(actor));
      });
      this.pump();
      return tasks.get(projectKey, taskKey);
    });
  }

  /**
   * Puts the card's queued merge at the front of its repository's queue (PM-576). The card's merger, an owner and
   * the Operator may decide it; the running merge is not interrupted. The merge gets `prioritized_at` (the queue
   * orders by it first, the latest decision first), which is cleared when the merge starts running. Without a
   * queued merge nothing can move; when it is first already, nothing changes (`moved` false, no event).
   */
  async prioritize(
    projectKey: string,
    taskKey: string,
    actor: Actor,
    reason: string,
  ): Promise<{ task: Task; moved: boolean }> {
    return this.cards.run(projectKey, taskKey, async () => {
      const { ctx, tasks, projects } = this.deps;
      const config = await projects.config(projectKey);
      const task = tasks.get(projectKey, taskKey);
      const row = ctx.repos.taskMerges.open(projectKey, taskKey);
      const handle = actorHandle(actor);
      if (
        row &&
        row.merger !== handle &&
        !(actor.kind === 'human' && ownerHandles(config).includes(handle)) &&
        !isOperatorActor(config, actor)
      )
        throw forbidden(
          'merge_not_merger',
          'only the card merger, an owner or the Operator may move a merge forward',
        );
      if (!row || row.state !== 'queued')
        throw conflict('merge_not_prioritizable', 'only a queued merge can be moved forward', {
          reason: !row ? 'no_merge' : row.state === 'running' ? 'running' : 'not_queued',
        });
      const queue = ctx.repos.taskMerges.waitingOf(projectKey, row.repo);
      const index = queue.findIndex((item) => item.id === row.id);
      const ahead = queue
        .slice(0, Math.max(index, 0))
        .filter((item) => item.state === 'queued')
        .map((item) => item.taskKey);
      if (ahead.length === 0) return { task, moved: false };
      ctx.unitOfWork(() => {
        this.steps.save(row, { prioritizedAt: isoNow(ctx) });
        this.deps.timeline.append({
          projectKey,
          taskKey,
          actor,
          type: 'task_merge_prioritized',
          data: { mergeId: row.id, repo: row.repo, reason, ahead },
        });
      });
      this.pump();
      return { task: tasks.get(projectKey, taskKey), moved: true };
    });
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
      throw this.notMergedError(
        config,
        task,
        repo,
        'engine_unavailable',
        'could not read the approved source commit',
      );
    }
    if (!source) return;
    if (await this.steps.includesApproved(task, repo.name, source.commit)) return;
    const merger = this.steps.engine(task)?.merger;
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
    throw this.notMergedError(config, task, repo, reason);
  }

  async init(): Promise<void> {
    this.stopped = false;
    const { ctx } = this.deps;
    for (const row of ctx.repos.taskMerges.list('running'))
      this.steps.save(row, { state: 'queued', step: 'queued' });
    // Known abandoned check worktrees are released before any new check is made.
    for (const state of ['queued', 'blocked'] as const) {
      for (const row of ctx.repos.taskMerges.list(state)) {
        try {
          const task = this.deps.tasks.find(row.projectKey, row.taskKey);
          if (!task) continue;
          const engine = this.deps.engines.get(this.deps.sessions.cardEngineId(row.projectKey, task));
          await this.steps.release(row, engine?.merger);
        } catch (err) {
          ctx.logger.warn({ err, mergeId: row.id }, 'could not recover a merge check worktree');
        }
      }
    }
    this.pump();
    this.deps.background.run(
      async () => {
        for (const project of this.deps.projects.summaries()) {
          try {
            await this.deps.projects.config(project.key);
            for (const task of this.deps.tasks.list(project.key)) {
              if (!isOpenTask(task)) continue;
              try {
                await this.reconcile(project.key, task.key);
              } catch (err) {
                ctx.logger.warn(
                  { err, projectKey: project.key, taskKey: task.key },
                  'could not reconcile a merge request after startup',
                );
              }
            }
          } catch (err) {
            ctx.logger.warn(
              { err, projectKey: project.key },
              'could not reconcile project merge requests after startup',
            );
          }
        }
      },
      (err) => ctx.logger.warn({ err }, 'merge startup recovery failed'),
    );
  }

  /**
   * Waits for the running merges: one that has not begun pushing goes back to `queued`, one that is
   * pushing runs to the end. The queue is made anew, so `init()` works after `stop()`.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await runPromise(Scope.close(this.scope, Exit.void));
    this.scope = Scope.makeUnsafe();
    this.queue = this.makeQueue();
  }

  /** The Operator's document writes share the repository's slot (PM-495): a merge waits while one runs, and it goes first when the slot frees. */
  registerSlotPeer(peer: MergeSlotPeer): void {
    this.peer = peer;
  }

  /** Whether a merge runs in the repository's slot. */
  busy(projectKey: string, repo: string): boolean {
    return this.queue.slot(projectKey, repo) !== undefined;
  }

  /** The card whose merge runs in the repository's slot; null: none. */
  holder(projectKey: string, repo: string): string | null {
    return this.queue.slot(projectKey, repo)?.row.taskKey ?? null;
  }

  pump(): void {
    runFork(this.queue.pump);
  }

  cancel(projectKey: string, taskKey: string, effects?: (() => Promise<void>)[]): void {
    const row = this.deps.ctx.repos.taskMerges.open(projectKey, taskKey);
    if (!row) return;
    const running = this.queue.slot(row.projectKey, row.repo);
    const afterCommit = (effect: () => Promise<void>) => {
      if (effects) effects.push(effect);
      else void effect();
    };
    // The interruption is not awaited, as the abort was not: the merge ends at its next checkpoint.
    if (running?.row.id === row.id && !running.pushing)
      afterCommit(async () => {
        runFork(this.queue.interrupt(running));
      });
    if (row.state === 'running') {
      return;
    }
    this.steps.save(row, { state: 'cancelled', finishedAt: isoNow(this.deps.ctx) });
    this.steps.clearAlert(row);
    const task = this.deps.tasks.find(projectKey, taskKey);
    if (task) afterCommit(() => this.steps.release(row, this.steps.engine(task)?.merger));
  }
}
