import path from 'node:path';
import {
  ALERT_SEEN_OPTION,
  alertPayloadOf,
  mergeRequestOf,
  mergeReadiness,
  memberOf,
  isOpenTask,
} from '@projectman/shared';
import type { Actor, MergeBlockReason, MergeFailure, ProjectConfig, Task } from '@projectman/shared';
import type { BranchMerger } from '../../contracts';
import { mergedState } from '../../db';
import type { MergeRecord } from '../../db';
import { isoNow } from '../../domain/context';
import { conflict } from '../../kernel';
import { actorHandle, newId, SYSTEM_ACTOR } from '../../kernel';
import type { MergeCardLock } from '../../kernel';
import type { MergeDeps, MergeRun } from './deps';
import { notifyMerge } from './notify';

/** What the steps need from the facade: the queue's wake-up and whether the server is stopping. */
export type MergeStepsHooks = { pump: () => void; stopped: () => boolean };

/** The merge's step program: the checks, the git work, the full test, the push, and every state change. */
export class MergeSteps {
  private readonly deps: MergeDeps;
  private readonly cards: MergeCardLock;
  private readonly hooks: MergeStepsHooks;
  constructor(deps: MergeDeps, cards: MergeCardLock, hooks: MergeStepsHooks) {
    this.deps = deps;
    this.cards = cards;
    this.hooks = hooks;
  }

  /**
   * Runs one merge in its slot. Whatever the program throws, the merge is blocked (unless it was
   * cancelled meanwhile): a slot never ends with the row left `running`.
   */
  async run(run: MergeRun): Promise<void> {
    try {
      await this.execute(run);
    } catch (err: unknown) {
      if (!this.continue(run)) return;
      await this.block(run, 'merge_error', err instanceof Error ? err.message : 'merge failed');
    }
  }

  notify(row: MergeRecord, config: ProjectConfig): Promise<void> {
    return notifyMerge(this.deps, row, config);
  }

  /** The card's engine; undefined when it is not registered. */
  engine(task: Task) {
    return this.deps.engines.get(this.deps.sessions.cardEngineId(task.projectKey, task));
  }

  async fix(
    projectKey: string,
    taskKey: string,
    actor: Actor,
    options: { fixConflict?: boolean; resolution?: string },
  ): Promise<Task> {
    const { ctx, tasks, projects, sessions, engines } = this.deps;
    const task = tasks.get(projectKey, taskKey);
    const row = ctx.repos.taskMerges.open(projectKey, taskKey);
    const handle = actorHandle(actor);
    if (!row || row.merger !== handle)
      throw conflict('merge_fix_not_allowed', 'only the card merger may fix conflicts', {
        reason: 'not_merger',
      });
    if (options.fixConflict && options.resolution !== undefined)
      throw conflict('merge_fix_not_allowed', 'request a fix or submit a resolution separately', {
        reason: 'not_conflict',
      });
    if (
      options.fixConflict
        ? row.state !== 'failed' || row.failure?.reason !== 'conflict'
        : row.state !== 'fixing' || !row.fix
    )
      throw conflict('merge_fix_not_allowed', 'the merge is not in the required conflict state', {
        reason: 'not_conflict',
      });
    const engineId = sessions.cardEngineId(projectKey, task);
    const callerEngine =
      sessions.list(projectKey, { taskKey }).find((s) => s.member === handle && sessions.isRunning(s.id))
        ?.engineId ?? engines.engineFor(projectKey, handle!);
    if (callerEngine !== engineId)
      throw conflict('merge_fix_engine_mismatch', 'the merger must use the card engine');
    const engine = engines.get(engineId);
    if (!engine || !engine.merger)
      throw conflict('merge_fix_not_allowed', 'the card engine is unavailable', { reason: 'not_conflict' });
    if (engine.memberWorkspaces)
      throw conflict('merge_fix_not_allowed', 'merge fixes require task worktree mode', {
        reason: 'member_workspaces',
      });
    if (engines.engineFor(projectKey, handle!) !== engineId)
      throw conflict('merge_fix_engine_mismatch', 'the merger must use the card engine');
    const config = await projects.config(projectKey);
    if (!mergeReadiness(config, task).ready) throw conflict('merge_not_ready', 'the card is no longer ready');
    const key = { project: config, repoName: row.repo, taskKey };
    if (options.fixConflict) {
      if (!row.commit)
        throw conflict('merge_fix_invalid', 'the approved commit is missing', { reason: 'missing_commit' });
      const info = await engine.worktrees.ensureMergeFix({ ...key, commit: row.commit });
      if (
        ctx.repos.taskMerges.open(projectKey, taskKey)?.id !== row.id ||
        !mergeReadiness(await projects.config(projectKey), tasks.get(projectKey, taskKey)).ready
      )
        throw conflict('merge_fix_not_allowed', 'the merge request changed while creating the fix', {
          reason: 'not_conflict',
        });
      this.save(row, {
        state: 'fixing',
        step: undefined,
        fix: {
          by: handle!,
          base: row.failure!.base,
          branch: info.branch,
          path: info.path,
          startedAt: isoNow(ctx),
        },
        resolution: undefined,
      });
      return tasks.get(projectKey, taskKey);
    }
    const note = options.resolution!;
    if (note.length < 1 || note.length > 2000)
      throw conflict('merge_fix_invalid', 'resolution must contain 1 to 2000 characters');
    const info = await engine.worktrees.findMergeFix(key);
    const head = info ? await engine.worktrees.head(info.path) : null;
    if (head?.dirty || (info && (await engine.worktrees.status(info.path)).dirty))
      throw conflict('merge_fix_invalid', 'commit the resolution first', { reason: 'uncommitted' });
    const approved = row.commit;
    if (
      !head ||
      head.branch !== row.fix!.branch ||
      !approved ||
      !(await engine.merger.isAncestor(this.ref(row), { ancestor: approved, commit: head.commit }))
    )
      throw conflict('merge_fix_invalid', 'the fix must contain the approved commit', {
        reason: 'missing_commit',
      });
    if (!(await engine.merger.isAncestor(this.ref(row), { ancestor: row.fix!.base, commit: head.commit })))
      throw conflict('merge_fix_invalid', 'the fix must contain the conflict base', {
        reason: 'missing_base',
      });
    // The card may have changed while git was read; do not queue a superseded request.
    const current = tasks.get(projectKey, taskKey);
    if (
      !mergeReadiness(await projects.config(projectKey), current).ready ||
      ctx.repos.taskMerges.open(projectKey, taskKey)?.id !== row.id
    )
      throw conflict('merge_fix_not_allowed', 'the merge request changed', { reason: 'not_conflict' });
    this.save(row, {
      state: 'queued',
      step: 'queued',
      commit: head.commit,
      branch: head.branch,
      resolution: { note, commit: head.commit },
      failure: undefined,
      block: undefined,
      mergeCommit: undefined,
      check: undefined,
      startedBy: handle,
      startedAt: isoNow(ctx),
    });
    this.deps.timeline.append({
      projectKey,
      taskKey,
      actor,
      type: 'task_note',
      data: { text: note, mentions: [] },
    });
    this.hooks.pump();
    return tasks.get(projectKey, taskKey);
  }
  ref(row: MergeRecord) {
    return { projectKey: row.projectKey, repo: row.repo };
  }
  async includesApproved(task: Task, repo: string, approved: string): Promise<boolean> {
    if (!task.merged || task.merged.repo !== repo) return false;
    if (task.merged.commit === approved) return true;
    if (!task.merged.resolution || task.merged.resolution.commit !== task.merged.commit) return false;
    return (
      (await this.engine(task)?.merger?.isAncestor(
        { projectKey: task.projectKey, repo },
        { ancestor: approved, commit: task.merged.commit },
      )) ?? false
    );
  }
  async release(row: MergeRecord, merger?: BranchMerger): Promise<void> {
    await merger?.releaseCheck(this.ref(row), { mergeId: row.id }).catch((err: unknown) =>
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
    if (row.fix && (row.state === 'merged' || row.state === 'cancelled')) {
      // release may itself run under this card's lock. Schedule rather than re-enter it.
      void this.cards
        .run(row.projectKey, row.taskKey, () => this.removeFix(row))
        .catch((err: unknown) =>
          this.deps.ctx.logger.warn({ err, mergeId: row.id }, 'could not remove merge-fix checkout'),
        );
    }
  }

  private async removeFix(row: MergeRecord): Promise<void> {
    const config = await this.deps.projects.config(row.projectKey);
    const task = this.deps.tasks.find(row.projectKey, row.taskKey);
    if (
      !task ||
      this.deps.ctx.repos.taskMerges.open(row.projectKey, row.taskKey) ||
      this.deps.sessions
        .list(row.projectKey, { taskKey: row.taskKey })
        .some((s) => s.branch === row.fix!.branch && this.deps.sessions.isRunning(s.id))
    )
      return;
    await this.engine(task)?.worktrees.removeMergeFix({
      project: config,
      repoName: row.repo,
      taskKey: row.taskKey,
    });
  }
  save(row: MergeRecord, patch: Partial<MergeRecord>): void {
    Object.assign(row, patch, { updatedAt: isoNow(this.deps.ctx) });
    this.deps.ctx.repos.taskMerges.save(row);
    const task = this.deps.tasks.find(row.projectKey, row.taskKey);
    if (task) this.deps.tasks.publish(task);
  }
  /**
   * The merge's checkpoint: whether it may go on. A cancelled or superseded merge stops here; an
   * interrupted one (the abort signal) is queued again when the server is stopping, else cancelled.
   * Once the push began nothing stops it.
   */
  continue(running: MergeRun): boolean {
    const row = running.row;
    const persisted = this.deps.ctx.repos.taskMerges.get(row.id);
    if (!persisted || (persisted.state !== 'queued' && persisted.state !== 'running')) return false;
    if (running.pushing) return true;
    const task = this.deps.tasks.find(row.projectKey, row.taskKey);
    if (!task || !isOpenTask(task) || task.stageId !== row.fromStageId || running.signal?.aborted) {
      if (this.hooks.stopped() && task && isOpenTask(task) && task.stageId === row.fromStageId) {
        this.save(row, { state: 'queued', step: 'queued' });
      } else {
        this.save(row, { state: 'cancelled', finishedAt: isoNow(this.deps.ctx) });
        this.clearAlert(row);
      }
      return false;
    }
    return true;
  }

  private async execute(running: MergeRun): Promise<void> {
    const row = running.row;
    const { projects, tasks, sessions, engines, github, ctx } = this.deps;
    if (!this.continue(running)) return;
    const config = await projects.config(row.projectKey);
    if (!this.continue(running)) return;
    const task = tasks.get(row.projectKey, row.taskKey);
    const repo = config.project.repos.find((repo) => repo.name === row.repo);
    const engine = engines.get(sessions.cardEngineId(row.projectKey, task));
    const merger = engine?.merger;
    if (!engine || !merger) return this.block(running, 'engine_unavailable', 'the card engine cannot merge');
    if (!repo) return this.block(running, 'merge_error', 'the repository no longer exists');
    if (!row.commit || !row.branch)
      return this.block(running, 'merge_error', 'the merge has no source commit');
    const commit = row.commit,
      branch = row.branch;
    this.save(row, { state: 'running', step: 'merging', block: undefined, prioritizedAt: undefined });
    const ref = this.ref(row);
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = await merger.prepare(ref, { base: row.base, commit: commit });
      if (!this.continue(running)) return;
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
        if (!row.mergeCommit) return this.block(running, 'merge_error', 'the landed merge has no commit');
        const advance = await merger.advance(ref, { base: row.base, from: base.local, to: row.mergeCommit });
        if (!advance.ok) return this.block(running, 'local_checkout', advance.message);
        return this.finish(row, config);
      }
      if (base.contains.local && base.contains.remote !== false && !row.mergeCommit) {
        const latest = await projects.config(row.projectKey);
        if (!this.continue(running)) return;
        if (!mergeReadiness(latest, tasks.get(row.projectKey, row.taskKey)).ready)
          return this.block(running, 'gate_changed', 'the card is no longer ready to merge');
        this.save(row, { mergeCommit: base.remote?.commit ?? base.local });
        return this.finish(row, latest, true);
      }
      if (base.relation === 'local_ahead' || base.relation === 'diverged')
        return this.block(
          running,
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
            running,
            'pull_request',
            err instanceof Error ? err.message : 'could not read the linked pull request',
          );
        }
        if (!this.continue(running)) return;
        if (pr.state !== 'open') continue;
        if (
          pr.baseRef !== row.base ||
          !pr.headSha ||
          !(pr.headSha === commit || (await merger.isAncestor(ref, { ancestor: pr.headSha, commit: commit })))
        )
          return this.block(
            running,
            'pull_request',
            'the linked pull request does not match the approved commit and base',
          );
        prs.push({ number: pr.number, url: pr.url });
      }
      if (!this.continue(running)) return;
      const built = await merger.build(ref, {
        onto,
        commit: commit,
        message: `Merge ${task.key}: ${task.title.replace(/[\r\n]/g, ' ').slice(0, 100)}\n\nBranch ${branch}, approved commit ${commit}.`,
      });
      if (!this.continue(running)) return;
      if (!built.ok)
        return this.fail(row, config, {
          reason: 'conflict',
          base: onto,
          at: isoNow(ctx),
          files: built.conflict.slice(0, 50),
        });
      this.save(row, { mergeCommit: built.mergeCommit, pullRequests: prs, check: undefined });
      const conflicts = await merger.checkoutConflicts(ref, { base: row.base, changed: built.changed });
      if (!this.continue(running)) return;
      if (conflicts.length)
        return this.block(
          running,
          'local_checkout',
          'uncommitted files overlap the merge',
          conflicts.join('\n'),
        );
      // The full test runs at the merge and nowhere else: without a command nothing would check the work.
      if (repo.fullTestAtMerge === true && !repo.reviewTest)
        return this.block(
          running,
          'check_unavailable',
          'the repository runs its full test at the merge (fullTestAtMerge) but names no reviewTest command',
        );
      if (repo.reviewTest) {
        // The test may wait for the machine's heavy-run queue: `checking` starts when it really runs.
        this.save(row, { step: 'check_waiting' });
        const passed = ctx.repos.fullTestRuns
          .forCommit(task.key, commit)
          .find(
            (run) => run.status === 'passed' && run.projectKey === row.projectKey && run.repo === row.repo,
          );
        if (passed && (await merger.isAncestor(ref, { ancestor: onto, commit: commit }))) {
          this.save(row, {
            step: 'checking',
            check: { command: repo.reviewTest.command, status: 'passed', runId: passed.id, reused: true },
          });
        } else {
          const executor = engine.fullTestExecutor;
          if (!executor || !(await executor.available()).ok)
            return this.block(running, 'check_unavailable', 'no full test executor is available');
          if (!this.continue(running)) return;
          let result;
          const runId = newId('mergecheck');
          try {
            const worktree = await engine.worktrees.find({
              project: config,
              repoName: repo.name,
              taskKey: task.key,
            });
            if (!this.continue(running)) return;
            const checkout = await merger.checkoutForCheck(ref, {
              mergeId: row.id,
              mergeCommit: built.mergeCommit,
              depsFrom:
                worktree?.path ??
                (engine.workspacePath(row.projectKey)
                  ? path.resolve(engine.workspacePath(row.projectKey)!, repo.path)
                  : null),
            });
            if (!this.continue(running)) return;
            const paths = engine.paths();
            result = await executor.run(
              {
                runId,
                cwd: checkout.path,
                command: repo.reviewTest.command,
                maxWorkers: repo.reviewTest.maxWorkers,
                timeoutMs: repo.reviewTest.timeoutMinutes * 60_000,
                sandbox: this.deps.checkSandbox({
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
              running.signal!,
              () => {
                if (this.continue(running)) this.save(row, { step: 'checking' });
              },
            );
          } catch (err) {
            if (!this.continue(running)) return;
            return this.block(
              running,
              'check_error',
              'the merge check could not run',
              err instanceof Error ? err.message : 'check failed',
            );
          } finally {
            await this.release(row, merger);
          }
          if (!this.continue(running)) return;
          this.save(row, { check: { command: repo.reviewTest.command, runId, status: result.outcome } });
          if (result.outcome === 'failed')
            return this.fail(row, config, {
              reason: 'check_failed',
              base: onto,
              at: isoNow(ctx),
              command: repo.reviewTest.command,
              runId,
              files: result.failedFiles,
              outputTail: result.outputTail.slice(0, 8000),
            });
          if (result.outcome === 'error')
            return this.block(
              running,
              'check_error',
              `the merge check could not run${result.reason ? ` (${result.reason})` : ''}`,
              result.outputTail.slice(0, 8000),
            );
        }
      }
      if (!this.continue(running)) return;
      const latest = await projects.config(row.projectKey);
      const current = tasks.get(row.projectKey, row.taskKey);
      if (!this.continue(running)) return;
      if (!mergeReadiness(latest, current).ready)
        return this.block(running, 'gate_changed', 'the card is no longer ready to merge');
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
            return this.block(running, 'remote_moved', pushed.message);
          }
          return this.block(
            running,
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
      if (!this.continue(running)) return;
      const advance = await merger.advance(ref, { base: row.base, from: base.local, to: built.mergeCommit });
      if (!advance.ok) return this.block(running, 'local_checkout', advance.message);
      return this.finish(row, latest);
    }
  }

  /** `found`: the work was already in the default branch; that is a system event, not the starter's merge. */
  private async finish(row: MergeRecord, config: ProjectConfig, found = false): Promise<void> {
    const { ctx, timeline, tasks } = this.deps;
    const starter = !found && row.startedBy ? memberOf(config, row.startedBy) : undefined;
    const actor: Actor = starter ? { kind: starter.kind, handle: starter.handle } : SYSTEM_ACTOR;
    ctx.unitOfWork(() => {
      this.save(row, { state: 'merged', step: 'finishing', finishedAt: isoNow(ctx) });
      this.clearAlert(row);
      timeline.append({
        projectKey: row.projectKey,
        taskKey: row.taskKey,
        actor,
        type: 'task_merged',
        data: { ...mergedState(row)!, mergeId: row.id },
      });
    });
    await this.notify(row, config);
    await this.release(row, this.engine(tasks.get(row.projectKey, row.taskKey))?.merger);
    const task = tasks.find(row.projectKey, row.taskKey);
    if (task) await this.deps.afterMerge(task);
  }

  private async block(
    running: MergeRun,
    reason: MergeBlockReason,
    message: string,
    detail?: string,
  ): Promise<void> {
    const { ctx, timeline, inbox, projects } = this.deps;
    const row = running.row;
    const config = await projects.config(row.projectKey);
    if (!this.continue(running)) return;
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

  clearAlert(row: MergeRecord, by?: string): void {
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
}
