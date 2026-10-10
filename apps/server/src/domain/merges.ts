import path from 'node:path';
import { ALERT_SEEN_OPTION, alertPayloadOf, evaluateMove, isOpenTask, stageOf } from '@projectman/shared';
import type {
  Actor,
  MergeBlockReason,
  ProjectConfig,
  RepoConfig,
  Stage,
  Task,
  TaskMergeState,
  TimelineEventData,
} from '@projectman/shared';
import type { BranchMerger, EngineDirectory, GithubService } from '../contracts';
import { mergeState, mergedState } from '../db';
import type { MergeRecord } from '../db';
import { ownerHandles } from './access';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict } from './errors';
import type { InboxService } from './inbox';
import type { Messaging } from './messaging';
import type { ProjectService } from './projects';
import { fullTestSandbox } from './session-policy';
import type { SessionOrchestrator } from './sessions';
import { stopStageReviewers, workStageBefore } from './stage-reviewers';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { actorHandle, newId, SYSTEM_ACTOR } from './util';

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
};
type Active = { row: MergeRecord; controller: AbortController; pushing: boolean; promise: Promise<void> };

/** Durable FIFO per project/repository; all git and sandbox work stays on the card's engine. */
export class Merges {
  private readonly active = new Map<string, Active>();
  private stopped = false;
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  enqueue(
    task: Task,
    repo: RepoConfig,
    target: Stage,
    actor: Actor,
    source: { commit: string; branch: string },
  ): TaskMergeState {
    const { ctx, tasks } = this.deps;
    const existing = ctx.repos.taskMerges.open(task.projectKey, task.key);
    if (existing) return mergeState(existing)!;
    const at = isoNow(ctx);
    const row: MergeRecord = {
      id: newId('merge'),
      projectKey: task.projectKey,
      taskKey: task.key,
      repo: repo.name,
      base: repo.defaultBranch,
      ...source,
      fromStageId: task.stageId,
      toStageId: target.id,
      requestedBy: actorHandle(actor),
      state: 'queued',
      step: 'queued',
      landed: 'nowhere',
      createdAt: at,
      updatedAt: at,
    };
    ctx.repos.taskMerges.save(row);
    tasks.publish(task);
    return mergeState(row)!;
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

  async retry(projectKey: string, taskKey: string): Promise<Task> {
    const { ctx, tasks } = this.deps;
    const task = tasks.get(projectKey, taskKey);
    ctx.unitOfWork(() => {
      const row = ctx.repos.taskMerges.open(projectKey, taskKey);
      if (row?.state !== 'blocked') throw conflict('merge_not_blocked', 'the task has no blocked merge');
      this.save(row, { state: 'queued', step: 'queued', block: undefined });
      this.clearAlert(row);
      tasks.publish(task);
    });
    this.pump();
    return tasks.get(projectKey, taskKey);
  }

  private ref(row: MergeRecord) {
    return { projectKey: row.projectKey, repo: row.repo };
  }
  private async release(row: MergeRecord, merger?: BranchMerger): Promise<void> {
    await merger
      ?.releaseCheck(this.ref(row), { mergeId: row.id })
      .catch((err: unknown) =>
        this.deps.ctx.logger.warn({ err, mergeId: row.id }, 'could not release a merge checkout'),
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
    this.save(row, { state: 'running', step: 'merging', block: undefined });
    const ref = this.ref(row);
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = await merger.prepare(ref, { base: row.base, commit: row.commit });
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
        return this.finish(row, config, true);
      }
      if (row.landed === 'remote') {
        if (!row.mergeCommit) return this.block(row, 'merge_error', 'the landed merge has no commit');
        const advance = await merger.advance(ref, { base: row.base, from: base.local, to: row.mergeCommit });
        if (!advance.ok) return this.block(row, 'local_checkout', advance.message);
        return this.finish(row, config, true);
      }
      if ((base.remote ? base.contains.remote : base.contains.local) && !row.mergeCommit) {
        const latest = await projects.config(row.projectKey);
        if (!this.continue(row, running)) return;
        if (!stageOf(latest, row.toStageId))
          return this.block(row, 'gate_changed', 'the target stage no longer exists');
        const gate = evaluateMove(
          tasks.get(row.projectKey, row.taskKey),
          latest,
          row.fromStageId,
          row.toStageId,
        );
        if (gate.unmet.length || gate.approvals.length)
          return this.block(row, 'gate_changed', 'the target gate no longer holds');
        return this.finish(row, latest, false);
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
        } catch {
          return this.block(row, 'pull_request', 'could not read the linked pull request');
        }
        if (!this.continue(row, running)) return;
        if (pr.state !== 'open') continue;
        if (
          pr.baseRef !== row.base ||
          !pr.headSha ||
          !(
            pr.headSha === row.commit ||
            (await merger.isAncestor(ref, { ancestor: pr.headSha, commit: row.commit }))
          )
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
        commit: row.commit,
        message: `Merge ${task.key}: ${task.title.replace(/[\r\n]/g, ' ').slice(0, 100)}\n\nBranch ${row.branch}, approved commit ${row.commit}.`,
      });
      if (!this.continue(row, running)) return;
      if (!built.ok)
        return this.sendBack(row, config, {
          mergeId: row.id,
          reason: 'conflict',
          base: row.base,
          commit: row.commit,
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
          .forCommit(task.key, row.commit)
          .find(
            (run) => run.status === 'passed' && run.projectKey === row.projectKey && run.repo === row.repo,
          );
        if (passed && (await merger.isAncestor(ref, { ancestor: onto, commit: row.commit }))) {
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
            return this.sendBack(row, config, {
              mergeId: row.id,
              reason: 'check_failed',
              base: row.base,
              commit: row.commit,
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
      if (!stageOf(latest, row.toStageId))
        return this.block(row, 'gate_changed', 'the target stage no longer exists');
      const gate = evaluateMove(current, latest, row.fromStageId, row.toStageId);
      if (!this.continue(row, running)) return;
      if (gate.unmet.length || gate.approvals.length)
        return this.block(row, 'gate_changed', 'the target gate no longer holds');
      if (base.remote) {
        this.save(row, { step: 'pushing' });
        running.pushing = true;
        const pushed = await merger.push(ref, { base: row.base, mergeCommit: built.mergeCommit });
        if (!pushed.ok) {
          if (pushed.reason === 'non_fast_forward') {
            if (attempt === 0) {
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
      return this.finish(row, latest, true);
    }
  }

  private async finish(row: MergeRecord, config: ProjectConfig, merged: boolean): Promise<void> {
    const { ctx, tasks, timeline } = this.deps;
    this.save(row, { step: 'finishing' });
    const record = () => {
      this.save(row, { state: merged ? 'merged' : 'cancelled', finishedAt: isoNow(ctx) });
      this.clearAlert(row);
      if (merged)
        timeline.append({
          projectKey: row.projectKey,
          taskKey: row.taskKey,
          actor: SYSTEM_ACTOR,
          type: 'task_merged',
          data: { ...mergedState(row)!, mergeId: row.id },
        });
    };
    const current = tasks.find(row.projectKey, row.taskKey);
    const target = stageOf(config, row.toStageId);
    if (current && current.stageId === row.fromStageId && isOpenTask(current) && target)
      await tasks.finishMerge(config, current, target, SYSTEM_ACTOR, record);
    else ctx.unitOfWork(record);
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
        !inbox.list(row.projectKey, { kind: 'alert', taskKey: row.taskKey }).some((item) => {
          const alert = alertPayloadOf(item);
          return alert?.alert === 'merge_blocked' && alert.mergeId === row.id && item.state === 'open';
        })
      ) {
        inbox.create({
          projectKey: row.projectKey,
          taskKey: row.taskKey,
          kind: 'alert',
          assignees: ownerHandles(config),
          source: 'system',
          title: message,
          payload: { alert: 'merge_blocked', taskKey: row.taskKey, mergeId: row.id, reason, message },
          options: [ALERT_SEEN_OPTION],
        });
      }
    });
  }

  private clearAlert(row: MergeRecord): void {
    for (const item of this.deps.inbox.list(row.projectKey, {
      kind: 'alert',
      taskKey: row.taskKey,
      state: 'open',
    })) {
      const alert = alertPayloadOf(item);
      if (alert?.alert === 'merge_blocked' && alert.mergeId === row.id) this.deps.inbox.cancel(item.id);
    }
  }

  private async sendBack(
    row: MergeRecord,
    config: ProjectConfig,
    failed: NonNullable<TimelineEventData['task_stage_changed']['mergeFailed']>,
  ): Promise<void> {
    const { tasks, sessions, messaging } = this.deps;
    const task = tasks.get(row.projectKey, row.taskKey);
    const from = stageOf(config, task.stageId);
    const back = workStageBefore(config, task.stageId);
    if (!from || !back)
      return this.block(row, 'merge_error', 'there is no preceding work stage for the failed merge');
    let result;
    try {
      result = await tasks.moveToStage(row.projectKey, row.taskKey, back.id, SYSTEM_ACTOR, {
        mergeFailed: failed,
      });
    } catch (err) {
      return this.block(
        row,
        'gate_changed',
        'the task could not be sent back after the failed merge',
        err instanceof Error ? err.message : 'move failed',
      );
    }
    if (!result.moved)
      return this.block(
        row,
        'gate_changed',
        'the work stage requires an approval before the task can be sent back',
      );
    this.save(row, { state: 'sent_back', finishedAt: isoNow(this.deps.ctx) });
    this.clearAlert(row);
    if (result.moved) await stopStageReviewers(sessions, config, task, from, back);
    if (task.assignee)
      await messaging.send(
        row.projectKey,
        'system',
        {
          to: [task.assignee],
          taskKey: task.key,
          text: `Merge ${task.key} into ${row.base} failed (${failed.reason}) on approved commit ${row.commit}.\n${failed.files?.join('\n') ?? failed.outputTail ?? ''}\nFix the failure, commit, and hand the card over again.`,
        },
        { actor: SYSTEM_ACTOR },
      );
  }
}
