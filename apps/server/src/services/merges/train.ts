import {
  ALERT_SEEN_OPTION,
  isCommitId,
  isOpenTask,
  memberOf,
  mergeReadiness,
  openPrerequisites,
  mergeTestFilesCommand,
  MERGE_ENGINE_WAIT_MINUTES,
} from '@projectman/shared';
import type { MergeBlockReason, MergeFailure, ProjectConfig, Task } from '@projectman/shared';
import { EngineLinkLostError, isEngineLinkLost } from '../../contracts';
import type { EngineHost, FullTestExecutor, FullTestResult } from '../../contracts';
import { mergedState } from '../../db';
import type { MergeRecord, MergeTrainRecord } from '../../db';
import { isoNow } from '../../core/base';
import { prerequisiteCards } from '../../core/tasks';
import { newId, SYSTEM_ACTOR } from '../../kernel';
import type { MergeCardLock } from '../../kernel';
import { recordMergeCheck } from './check-runs';
import {
  GITHUB_RUNNER_NEEDS_REPO,
  mergeCheckExecutor,
  mergeCheckRunner,
  prepareMergeCheck,
} from './check-preparation';
import type { MergeDeps, MergeRun } from './deps';
import { flakyCheckFiles, flakyCheckNote } from './flaky';
import type { MergeSteps } from './steps';
import { selectMergeTrain } from './train-selection';
import type { MergeTrainCandidate } from './train-selection';
import { MERGE_ENGINE_LOSSES, MERGE_ENGINE_WAIT_MS, waitForEngine } from './engine-wait';

type Hooks = {
  stopped(): boolean;
  source(config: ProjectConfig, task: Task): Promise<{ commit: string; branch: string } | null>;
  mergerOf(config: ProjectConfig, task: Task): string | null;
};

const sameCheck = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Server-owned train orchestration. All repository and sandbox operations use the pinned engine. */
export class MergeTrains {
  private readonly deps: MergeDeps;
  private readonly cards: MergeCardLock;
  private readonly steps: MergeSteps;
  private readonly hooks: Hooks;
  constructor(deps: MergeDeps, cards: MergeCardLock, steps: MergeSteps, hooks: Hooks) {
    this.deps = deps;
    this.cards = cards;
    this.steps = steps;
    this.hooks = hooks;
  }

  private rows(train: MergeTrainRecord): MergeRecord[] {
    return train.members.map((m) => {
      const row = this.deps.ctx.repos.taskMerges.get(m.mergeId);
      if (!row) throw new Error('A merge train member is missing');
      return row;
    });
  }

  private lock<T>(rows: readonly MergeRecord[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...rows].sort((a, b) => a.taskKey.localeCompare(b.taskKey));
    const next = (i: number): Promise<T> =>
      i === sorted.length
        ? fn()
        : this.cards.run(sorted[i]!.projectKey, sorted[i]!.taskKey, () => next(i + 1));
    return next(0);
  }

  private save(train: MergeTrainRecord, patch: Partial<MergeTrainRecord>): void {
    Object.assign(train, patch, { updatedAt: isoNow(this.deps.ctx) });
    this.deps.ctx.repos.mergeTrains.save(train);
  }

  /** Startup schedules one leader; its manifest occupies the ordinary repository slot again. */
  async scheduleRecovery(train: MergeTrainRecord): Promise<void> {
    await this.deps.engines
      .get(train.engineId)
      ?.merger?.releaseCheck({ projectKey: train.projectKey, repo: train.repo }, { mergeId: train.id })
      .catch((err: unknown) =>
        this.deps.ctx.logger.warn(
          { err, trainId: train.id },
          'could not release an abandoned train checkout',
        ),
      );
    // A blocked attempt is historical: its members may have cancelled or retried independently.
    // Only a candidate already published authorizes restoring this group's requests.
    if (train.state === 'blocked') {
      try {
        if (!(await this.published(train))) return;
      } catch (err) {
        this.deps.ctx.logger.warn(
          { err, trainId: train.id },
          'could not inspect a blocked train publication',
        );
        return;
      }
    }
    const leader = this.rows(train)[0]!;
    if (this.deps.ctx.repos.mergeTrains.get(train.id)?.state === 'merged' || leader.state === 'merged')
      return;
    this.steps.save(leader, { state: 'queued' });
  }

  resume(run: MergeRun): boolean {
    const train = run.row.trainId ? this.deps.ctx.repos.mergeTrains.get(run.row.trainId) : null;
    if (!train || (train.state !== 'running' && !(train.state === 'blocked' && train.step === 'pushing')))
      return false;
    run.recoveryOnly = train.state === 'blocked';
    this.deps.ctx.unitOfWork(() => {
      for (const row of this.rows(train))
        if (row.trainId === train.id && row.state === 'queued')
          this.steps.save(row, { state: run.recoveryOnly ? 'blocked' : 'running' });
    });
    run.train = train;
    run.pushing = train.landed === 'remote';
    return true;
  }

  /**
   * Every member's approved commit is readable in the train's repository before the first git
   * read of any of them (PM-739): member workspaces hand them over, idempotently. A refusal stops
   * the attempt, never the choice of another branch.
   */
  private async prepareSources(train: MergeTrainRecord): Promise<void> {
    const config = await this.deps.projects.config(train.projectKey);
    for (const member of train.members) {
      const task = this.deps.tasks.find(train.projectKey, member.taskKey);
      if (!task) throw new Error(`The task ${member.taskKey} of a merge train member is missing`);
      await this.deps.sessions.prepareMergeSource(config, task, member.commit);
    }
  }

  async published(train: MergeTrainRecord): Promise<boolean> {
    if (!train.candidate) return false;
    const merger = this.deps.engines.get(train.engineId)?.merger;
    if (!merger) return false;
    await this.prepareSources(train);
    const ref = { projectKey: train.projectKey, repo: train.repo };
    const base = await merger.prepare(ref, { base: train.base, commit: train.members[0]!.commit });
    return Boolean(
      await merger.isAncestor(ref, {
        ancestor: train.candidate,
        commit: base.remote?.commit ?? base.local,
      }),
    );
  }

  /** Source, authorization and configuration are checked again under the ordered card locks. */
  private async valid(row: MergeRecord, train?: MergeTrainRecord, allowWaiting = false): Promise<boolean> {
    if (train) {
      const snapshot = train.members.find((m) => m.mergeId === row.id);
      if (
        !snapshot ||
        snapshot.commit !== row.commit ||
        snapshot.branch !== row.branch ||
        snapshot.startedBy !== row.startedBy ||
        snapshot.startedAt !== row.startedAt
      )
        return false;
    }
    const { tasks, projects, sessions } = this.deps;
    const task = tasks.find(row.projectKey, row.taskKey);
    if (!task || !isOpenTask(task) || task.stageId !== row.fromStageId) return false;
    const config = await projects.config(row.projectKey);
    const ready = mergeReadiness(config, task);
    if (
      !ready.ready ||
      ready.repo.name !== row.repo ||
      ready.repo.defaultBranch !== row.base ||
      this.hooks.mergerOf(config, task) !== row.merger ||
      row.startedBy !== row.merger ||
      (!allowWaiting && openPrerequisites(task, prerequisiteCards(tasks, row.projectKey, task)).length > 0) ||
      (train &&
        (sessions.cardEngineId(row.projectKey, task) !== train.engineId ||
          !sameCheck(ready.repo.reviewTest, train.reviewTest)))
    )
      return false;
    const source = await this.hooks.source(config, task);
    return source !== null && source.commit === row.commit && source.branch === row.branch;
  }

  /** Returns false for the established single-card path, including already-landed sources. */
  async reserve(run: MergeRun): Promise<boolean> {
    const { ctx, projects, tasks, sessions } = this.deps;
    const queued = this.queued(run.row.projectKey, run.row.repo).slice(0, 8);
    if (queued[0]?.id !== run.row.id || queued.length < 2) return false;
    const candidates: MergeTrainCandidate[] = [];
    for (const row of queued) {
      if (run.signal?.aborted) return false;
      const task = tasks.find(row.projectKey, row.taskKey);
      const config = await projects.config(row.projectKey);
      const repo = config.project.repos.find((r) => r.name === row.repo);
      const engineId = task ? sessions.cardEngineId(row.projectKey, task) : undefined;
      const merger = engineId ? this.deps.engines.get(engineId)?.merger : undefined;
      let eligible = Boolean(
        row.commit &&
        isCommitId(row.commit) &&
        row.branch &&
        row.startedBy &&
        row.startedAt &&
        !row.trainId &&
        task &&
        merger &&
        (await this.valid(row)),
      );
      let solo = Boolean(row.fix || row.resolution || row.landed !== 'nowhere');
      if (eligible && !solo) {
        try {
          await sessions.prepareMergeSource(config, task!, row.commit!);
        } catch (err) {
          // Its own turn reports the refusal; it does not stop the train from forming without it.
          ctx.logger.warn({ err, mergeId: row.id }, 'could not hand over a merge train candidate');
          eligible = false;
        }
      }
      if (eligible && !solo) {
        const base = await merger!.prepare(this.steps.ref(row), { base: row.base, commit: row.commit! });
        // Reconcile existing work individually before attributing any new train work.
        solo = base.contains.local || base.contains.remote === true;
      }
      candidates.push({
        mergeId: row.id,
        taskKey: row.taskKey,
        commit: row.commit ?? '',
        branch: row.branch ?? '',
        startedBy: row.startedBy ?? '',
        startedAt: row.startedAt ?? '',
        prioritizedAt: row.prioritizedAt,
        diagnostic: row.diagnostic,
        projectKey: row.projectKey,
        repo: row.repo,
        base: row.base,
        engineId: engineId ?? '',
        reviewTest: repo?.reviewTest,
        eligible,
        solo,
      });
      if (!eligible || solo) break;
    }
    const ids = selectMergeTrain(candidates);
    if (ids.length < 2) return false;
    const selected = queued.filter((r) => ids.includes(r.id));
    return this.lock(selected, async () => {
      if (run.signal?.aborted || this.hooks.stopped()) return false;
      const first = candidates[0]!;
      const train: MergeTrainRecord = {
        id: newId('mrg'),
        projectKey: first.projectKey,
        repo: first.repo,
        base: first.base,
        engineId: first.engineId,
        reviewTest: first.reviewTest!,
        parentTrainId: first.diagnostic?.parentTrainId,
        members: candidates
          .slice(0, ids.length)
          .map(({ mergeId, taskKey, commit, branch, startedBy, startedAt, prioritizedAt }) => ({
            mergeId,
            taskKey,
            commit,
            branch,
            startedBy,
            startedAt,
            ...(prioritizedAt ? { prioritizedAt } : {}),
          })),
        state: 'running',
        step: 'merging',
        landed: 'nowhere',
        createdAt: isoNow(ctx),
        updatedAt: isoNow(ctx),
      };
      for (const row of selected) if (!(await this.valid(row, train))) return false;
      if (!(await this.pullRequests(train))) return false;
      return ctx.unitOfWork(() => {
        const current = this.queued(train.projectKey, train.repo).slice(0, ids.length);
        if (
          current.some(
            (r, i) =>
              r.id !== ids[i] ||
              r.commit !== train.members[i]!.commit ||
              r.branch !== train.members[i]!.branch ||
              r.prioritizedAt !== train.members[i]!.prioritizedAt,
          ) ||
          current.length !== ids.length
        )
          return false;
        ctx.repos.mergeTrains.save(train);
        for (const row of current)
          this.steps.save(row, {
            state: 'running',
            step: 'merging',
            trainId: train.id,
            prioritizedAt: undefined,
            block: undefined,
            failure: undefined,
          });
        run.train = train;
        return true;
      });
    });
  }

  /** Skip waiting heads, but keep followers adjacent for the compatible-prefix selector. */
  private queued(projectKey: string, repo: string): MergeRecord[] {
    const rows = this.deps.ctx.repos.taskMerges
      .list('queued')
      .filter((r) => r.projectKey === projectKey && r.repo === repo);
    const first = rows.findIndex((row) => {
      const task = this.deps.tasks.find(projectKey, row.taskKey);
      return (
        !task || openPrerequisites(task, prerequisiteCards(this.deps.tasks, projectKey, task)).length === 0
      );
    });
    return first < 0 ? [] : rows.slice(first);
  }

  /** Returns survivors to their original queue positions, retiring the unique running manifest. */
  async invalidate(run: MergeRun): Promise<void> {
    const train = run.train!;
    await this.lock(this.rows(train), async () => {
      const validity = new Map<string, boolean>();
      for (const row of this.rows(train)) {
        try {
          // A new review configuration or engine needs a new candidate, not a new user request.
          validity.set(row.id, await this.valid(row, undefined, true));
        } catch (err) {
          this.deps.ctx.logger.warn({ err, mergeId: row.id }, 'could not revalidate a retired train member');
          validity.set(row.id, false);
        }
      }
      this.deps.ctx.unitOfWork(() => {
        this.save(train, { state: 'cancelled', finishedAt: isoNow(this.deps.ctx) });
        for (const row of this.rows(train)) {
          if (row.state !== 'running') continue;
          const member = train.members.find((m) => m.mergeId === row.id)!;
          this.steps.save(row, {
            state: validity.get(row.id) ? 'queued' : 'cancelled',
            step: 'queued',
            trainId: undefined,
            mergeCommit: undefined,
            check: undefined,
            prioritizedAt: member.prioritizedAt,
          });
        }
      });
    });
  }

  private async checkpoint(run: MergeRun): Promise<boolean> {
    if (run.pushing) return true;
    if (
      run.signal?.aborted ||
      this.hooks.stopped() ||
      this.rows(run.train!).some((r) => r.state !== 'running')
    ) {
      await this.invalidate(run);
      return false;
    }
    return true;
  }

  private patchMembers(train: MergeTrainRecord, patch: Partial<MergeRecord>): void {
    for (const row of this.rows(train)) this.steps.save(row, patch);
  }

  /**
   * Retire the failed attempt and requeue its still running members. `maxCards` is the smaller group
   * limit of their next attempt (default: half the group); `null` sets none, so the members may join any
   * train (a member that passed alone, PM-844). A given `note` writes the timeline note of each requeued card.
   */
  private async requeue(
    train: MergeTrainRecord,
    options: { maxCards?: number | null; note?: (taskKey: string) => string } = {},
  ): Promise<void> {
    const { ctx } = this.deps;
    const maxCards = options.maxCards === undefined ? Math.ceil(train.members.length / 2) : options.maxCards;
    await this.lock(this.rows(train), async () => {
      ctx.unitOfWork(() => {
        if (ctx.repos.mergeTrains.get(train.id)?.state !== 'running') return;
        this.save(train, { state: 'failed', finishedAt: isoNow(ctx) });
        for (const row of this.rows(train)) {
          const member = train.members.find((m) => m.mergeId === row.id)!;
          if (row.state !== 'running' || row.trainId !== train.id) continue;
          this.steps.save(row, {
            state: 'queued',
            step: 'queued',
            trainId: undefined,
            diagnostic: maxCards === null ? undefined : { parentTrainId: train.id, maxCards },
            prioritizedAt: member.prioritizedAt,
            mergeCommit: undefined,
            check: undefined,
            failure: undefined,
            block: undefined,
            finishedAt: undefined,
          });
          this.steps.clearAlert(row);
          if (options.note)
            this.deps.timeline.append({
              projectKey: row.projectKey,
              taskKey: row.taskKey,
              actor: SYSTEM_ACTOR,
              type: 'task_note',
              data: { text: options.note(row.taskKey), mentions: [] },
            });
        }
      });
    });
  }

  /**
   * A failed group check: run its failed files on each member alone, on the default branch plus that
   * member, so only the card whose own code fails them is blamed (PM-844). Returns false when nothing was
   * settled and the caller halves the group as before: no `filesCommand`, no failed files, a single
   * member, or no member failed alone. Returns true once the train is settled or stopped.
   */
  private async diagnose(
    run: MergeRun,
    engine: EngineHost,
    executor: FullTestExecutor,
    group: FullTestResult,
  ): Promise<boolean> {
    const train = run.train!;
    const merger = engine.merger;
    const { ctx } = this.deps;
    if (!merger || train.members.length < 2 || group.failedFiles.length === 0 || !train.onto) return false;
    const config = await this.deps.projects.config(train.projectKey);
    const repoConfig = config.project.repos.find((r) => r.name === train.repo);
    const filesCommand = repoConfig?.reviewTest?.filesCommand;
    if (!filesCommand) return false;
    const runner = mergeCheckRunner(train.reviewTest);
    const github = repoConfig?.github;
    if (runner === 'github_actions' && !github) {
      ctx.logger.warn(
        { trainId: train.id, repo: train.repo },
        'the merge check runs on GitHub Actions but the repo has no github setting; the train is halved instead of diagnosed',
      );
      return false;
    }
    const command = mergeTestFilesCommand(filesCommand, group.failedFiles);
    const ref = { projectKey: train.projectKey, repo: train.repo };
    const paths = engine.paths();
    // The group's own checkout is not needed again; the lone checkouts take its place.
    await merger
      .releaseCheck(ref, { mergeId: train.id })
      .catch((err: unknown) =>
        ctx.logger.warn({ err, trainId: train.id }, 'could not release a merge train checkout'),
      );
    const blamed: {
      member: MergeTrainRecord['members'][number];
      failure: MergeFailure;
      url?: string;
    }[] = [];
    const passedAlone: string[] = [];
    for (const member of train.members) {
      if (!(await this.checkpoint(run))) return true;
      let built: Awaited<ReturnType<typeof merger.build>>;
      try {
        built = await merger.build(ref, {
          onto: train.onto,
          commit: member.commit,
          message: `Diagnose ${member.taskKey} for train ${train.id}`,
        });
      } catch (err) {
        if (isEngineLinkLost(err)) throw err;
        // A git error while building the lone merge leaves the member unknown, not guilty.
        ctx.logger.warn({ err, mergeId: member.mergeId }, 'could not build the lone merge of a train member');
        continue;
      }
      if (!(await this.checkpoint(run))) return true;
      if (!built.ok) continue;
      const mergeId = newId('mrg');
      const runId = newId('mergecheck');
      let result: FullTestResult;
      try {
        const prepared = await prepareMergeCheck(merger, {
          ref,
          mergeId,
          mergeCommit: built.mergeCommit,
          base: train.base,
          depsFrom: null,
          runner,
          github,
          files: group.failedFiles,
          checkSandbox: this.deps.checkSandbox,
          paths,
        });
        if (!(await this.checkpoint(run))) return true;
        result = await recordMergeCheck(
          ctx,
          {
            id: runId,
            projectKey: train.projectKey,
            repo: train.repo,
            kind: 'diagnose',
            trainId: train.id,
            taskKeys: [member.taskKey],
            commit: built.mergeCommit,
            base: train.onto,
            maxWorkers: train.reviewTest.maxWorkers,
            runner,
          },
          (markStarted) =>
            executor.run(
              prepared.spec({ runId, command, reviewTest: train.reviewTest }),
              run.signal ?? new AbortController().signal,
              markStarted,
              { linkWaitMs: MERGE_ENGINE_WAIT_MS },
            ),
        );
      } catch (err) {
        if (isEngineLinkLost(err)) throw err;
        // A member that cannot be tried alone stays unknown, not guilty.
        ctx.logger.warn({ err, mergeId: member.mergeId }, 'could not run the lone check of a train member');
        continue;
      } finally {
        await merger
          .releaseCheck(ref, { mergeId })
          .catch((err: unknown) =>
            ctx.logger.warn({ err, mergeId }, 'could not release a lone train member checkout'),
          );
      }
      if (!(await this.checkpoint(run))) return true;
      if (result.outcome === 'error' && result.reason === 'engine_offline')
        throw new EngineLinkLostError('the merge check lost the card engine', true);
      // Only a failure of the group's own failed files blames a card: any other non-zero exit
      // (a usage error, a failed install, no file named) says nothing about the member's code.
      const files = result.failedFiles.filter((file) => group.failedFiles.includes(file));
      if (result.outcome === 'failed' && files.length > 0)
        blamed.push({
          member,
          ...(result.externalUrl ? { url: result.externalUrl } : {}),
          failure: {
            reason: 'check_failed',
            base: train.onto,
            at: isoNow(ctx),
            command,
            runId,
            files,
            outputTail: result.outputTail.slice(0, 8000),
          },
        });
      else if (result.outcome === 'passed') passedAlone.push(member.taskKey);
      ctx.logger.info(
        { trainId: train.id, runId, taskKey: member.taskKey, outcome: result.outcome, files },
        'merge train lone check completed',
      );
    }
    if (blamed.length === 0) return false;
    const names = blamed.map(({ member }) => member.taskKey).join(', ');
    for (const { member, failure, url } of blamed) {
      const row = ctx.repos.taskMerges.get(member.mergeId);
      if (!row || row.state !== 'running' || row.trainId !== train.id) continue;
      this.steps.save(row, {
        check: { command, runId: failure.runId, status: 'failed', runner, ...(url ? { url } : {}) },
      });
      await this.steps.fail(row, config, failure);
    }
    await this.requeue(train, {
      maxCards: null,
      note: (taskKey) =>
        `Merge train ${train.id} failed on ${group.failedFiles.join(', ')}; ${names} failed them alone, this card ${
          passedAlone.includes(taskKey) ? 'passed them alone' : 'could not be told apart alone'
        } and keeps its place in the queue.`,
    });
    return true;
  }

  private async terminal(
    run: MergeRun,
    reason: MergeBlockReason,
    message: string,
    failure?: MergeFailure,
  ): Promise<void> {
    const train = run.train!;
    const { ctx, timeline } = this.deps;
    ctx.unitOfWork(() => {
      this.save(train, { state: failure ? 'failed' : 'blocked', finishedAt: isoNow(ctx) });
      for (const row of this.rows(train)) {
        this.steps.save(row, {
          state: failure ? 'failed' : 'blocked',
          step: undefined,
          failure,
          block: failure ? undefined : { reason, message, at: isoNow(ctx) },
        });
        this.steps.clearAlert(row);
        const common = { projectKey: row.projectKey, taskKey: row.taskKey, actor: SYSTEM_ACTOR };
        if (failure)
          timeline.append({ ...common, type: 'task_merge_failed', data: { ...failure, mergeId: row.id } });
        else
          timeline.append({
            ...common,
            type: 'task_merge_blocked',
            data: {
              mergeId: row.id,
              repo: row.repo,
              base: row.base,
              reason,
              message,
              landed: row.landed,
              mergeCommit: row.mergeCommit,
            },
          });
      }
    });
    const config = await this.deps.projects.config(train.projectKey);
    for (const row of this.rows(train)) {
      if (!failure && memberOf(config, row.merger)?.kind === 'human')
        this.deps.inbox.create({
          projectKey: row.projectKey,
          taskKey: row.taskKey,
          kind: 'alert',
          assignees: [row.merger],
          source: 'system',
          title: message,
          payload: { alert: 'merge_blocked', taskKey: row.taskKey, mergeId: row.id, reason, message },
          options: [ALERT_SEEN_OPTION],
        });
      await this.steps.notify(row, config);
    }
  }

  private async finish(train: MergeTrainRecord): Promise<void> {
    const { ctx, timeline, projects, tasks } = this.deps;
    const config = await projects.config(train.projectKey);
    const githubRepo = config.project.repos.find((r) => r.name === train.repo)?.github;
    ctx.unitOfWork(() => {
      this.save(train, {
        state: 'merged',
        step: 'finishing',
        landed: train.landed === 'remote' ? 'remote' : 'local',
        finishedAt: isoNow(ctx),
      });
      for (const row of this.rows(train)) {
        if (row.state === 'merged') continue;
        this.steps.save(row, {
          state: 'merged',
          diagnostic: undefined,
          step: 'finishing',
          finishedAt: isoNow(ctx),
          ...(row.pushed && githubRepo
            ? {
                pushed: {
                  ...row.pushed,
                  commitUrl: `https://github.com/${githubRepo}/commit/${train.candidate}`,
                },
              }
            : {}),
        });
        this.steps.clearAlert(row);
        const starter = memberOf(config, row.startedBy!);
        timeline.append({
          projectKey: row.projectKey,
          taskKey: row.taskKey,
          actor: starter ? { kind: starter.kind, handle: starter.handle } : SYSTEM_ACTOR,
          type: 'task_merged',
          data: { ...mergedState(row)!, mergeId: row.id },
        });
      }
    });
    for (const row of this.rows(train)) {
      try {
        await this.steps.notify(row, config);
      } catch (err) {
        ctx.logger.warn({ err, mergeId: row.id }, 'could not notify a merged train member');
      }
      try {
        const task = tasks.find(row.projectKey, row.taskKey);
        if (task) await this.deps.afterMerge(task);
      } catch (err) {
        ctx.logger.warn({ err, mergeId: row.id }, 'could not advance a merged train member');
      }
    }
  }

  /** PR metadata is deliberately fetched at the final checkpoint too. */
  private async pullRequests(train: MergeTrainRecord): Promise<boolean> {
    const config = await this.deps.projects.config(train.projectKey);
    const repo = config.project.repos.find((r) => r.name === train.repo);
    const merger = this.deps.engines.get(train.engineId)?.merger;
    if (!repo || !merger) return false;
    for (const row of this.rows(train)) {
      const prs: NonNullable<MergeRecord['pullRequests']> = [];
      const task = this.deps.tasks.get(row.projectKey, row.taskKey);
      for (const link of task.links.filter((l) => l.kind === 'pull_request' && l.repo === repo.github)) {
        const pr = await this.deps.github.getPullRequest(repo.github!, Number(link.ref));
        if (pr.state !== 'open') continue;
        if (
          pr.baseRef !== train.base ||
          !pr.headSha ||
          !(
            pr.headSha === row.commit ||
            (await merger.isAncestor(this.steps.ref(row), { ancestor: pr.headSha, commit: row.commit! }))
          )
        )
          return false;
        prs.push({ number: pr.number, url: pr.url });
      }
      this.steps.save(row, { pullRequests: prs });
    }
    return true;
  }

  async run(run: MergeRun, recoverOnly = false): Promise<void> {
    const train = run.train!;
    const { ctx, engines } = this.deps;
    for (let losses = 0; ;) {
      try {
        await this.attempt(run, recoverOnly);
        return;
      } catch (err) {
        if (!run.pushing && !(await this.checkpoint(run))) return;
        if (!isEngineLinkLost(err)) throw err;
        if (++losses > MERGE_ENGINE_LOSSES)
          return this.terminal(run, 'engine_offline', 'the card engine kept losing its link');
        this.patchMembers(train, { step: 'engine_waiting' });
        ctx.logger.info(
          { mergeId: train.id, engineId: train.engineId, losses },
          'a merge waits for its engine',
        );
        const waited = err instanceof EngineLinkLostError && err.waited;
        const back = await waitForEngine(
          engines,
          train.engineId,
          waited ? 0 : MERGE_ENGINE_WAIT_MS,
          run.signal,
        );
        if (back === 'aborted') {
          await this.checkpoint(run);
          return;
        }
        if (back === 'timeout')
          return this.terminal(
            run,
            'engine_offline',
            `the card engine was unreachable for ${MERGE_ENGINE_WAIT_MINUTES} minutes`,
          );
        this.patchMembers(train, { step: train.step });
        ctx.logger.info(
          { mergeId: train.id, engineId: train.engineId, losses },
          'a merge goes on after its engine reconnected',
        );
      }
    }
  }

  private async attempt(run: MergeRun, recoverOnly: boolean): Promise<void> {
    const train = run.train!;
    const { ctx, engines } = this.deps;
    const engine = engines.get(train.engineId);
    const merger = engine?.merger;
    const ref = { projectKey: train.projectKey, repo: train.repo };
    try {
      if (!engine && engines.ids().includes(train.engineId))
        throw new EngineLinkLostError('the card engine is not connected');
      if (!engine || !merger)
        return await this.terminal(run, 'engine_unavailable', 'The train engine is unavailable');
      await this.prepareSources(train);
      for (let attempt = 0; attempt < 2; attempt++) {
        const base = await merger.prepare(ref, { base: train.base, commit: train.members[0]!.commit });
        // Recovery precedes cancellation or changed gates: publication already happened.
        if (train.candidate) {
          const remoteLanded =
            base.remote &&
            (await merger.isAncestor(ref, { ancestor: train.candidate, commit: base.remote.commit }));
          const localLanded = await merger.isAncestor(ref, { ancestor: train.candidate, commit: base.local });
          if (remoteLanded || (!base.remote && localLanded)) {
            run.pushing = true;
            if (!localLanded) {
              const advanced = await merger.advance(ref, {
                base: train.base,
                from: base.local,
                to: train.candidate,
              });
              if (!advanced.ok) return await this.terminal(run, 'local_checkout', advanced.message);
            }
            if (base.remote)
              ctx.unitOfWork(() => {
                this.save(train, { landed: 'remote' });
                this.patchMembers(train, { landed: 'remote', pushed: { remote: base.remote!.name } });
              });
            return await this.finish(train);
          }
        }
        if (recoverOnly) return;
        if (!(await this.checkpoint(run))) return;
        if (train.check?.status === 'failed') return await this.requeue(train);
        if (base.relation === 'local_ahead' || base.relation === 'diverged')
          return await this.terminal(
            run,
            'base_out_of_sync',
            'The default branch is ahead of or diverged from upstream',
          );
        // A restart rebuilds and checks unpublished candidates; no green crosses a new candidate.
        const onto = base.remote?.commit ?? base.local;
        for (const member of train.members) {
          if (await merger.isAncestor(ref, { ancestor: member.commit, commit: onto }))
            return await this.invalidate(run);
        }
        ctx.unitOfWork(() => {
          this.save(train, {
            onto,
            localFrom: base.local,
            candidate: undefined,
            check: undefined,
            step: 'merging',
          });
          this.patchMembers(train, { step: 'merging', mergeCommit: undefined, check: undefined });
        });
        if (!(await this.pullRequests(train))) return await this.invalidate(run);
        let tip = onto;
        for (const member of train.members) {
          const built = await merger.build(ref, {
            onto: tip,
            commit: member.commit,
            message: `Merge ${member.taskKey} into train ${train.id}`,
          });
          if (!(await this.checkpoint(run))) return;
          if (!built.ok) return await this.requeue(train, { maxCards: 1 });
          tip = built.mergeCommit;
        }
        const built = await merger.build(ref, {
          onto,
          commit: tip,
          message: `Merge train ${train.members.map((m) => m.taskKey).join(', ')}`,
        });
        if (!(await this.checkpoint(run))) return;
        if (!built.ok) return await this.terminal(run, 'merge_error', 'Could not close the merge train');
        ctx.unitOfWork(() => {
          this.save(train, { candidate: built.mergeCommit, step: 'check_waiting' });
          this.patchMembers(train, {
            mergeCommit: built.mergeCommit,
            step: 'check_waiting',
            check: undefined,
          });
        });
        const conflicts = await merger.checkoutConflicts(ref, { base: train.base, changed: built.changed });
        if (conflicts.length)
          return await this.terminal(
            run,
            'local_checkout',
            `Uncommitted paths overlap the train: ${conflicts.join(', ')}`,
          );
        const runner = mergeCheckRunner(train.reviewTest);
        const github = (await this.deps.projects.config(train.projectKey)).project.repos.find(
          (r) => r.name === train.repo,
        )?.github;
        if (runner === 'github_actions' && !github)
          return await this.terminal(run, 'check_unavailable', GITHUB_RUNNER_NEEDS_REPO);
        const available = await mergeCheckExecutor(engine, runner);
        if (!available.ok) return await this.terminal(run, 'check_unavailable', available.reason);
        const { executor } = available;
        if (!(await this.checkpoint(run))) return;
        const prepared = await prepareMergeCheck(merger, {
          ref,
          mergeId: train.id,
          mergeCommit: built.mergeCommit,
          base: train.base,
          depsFrom: null,
          runner,
          github,
          checkSandbox: this.deps.checkSandbox,
          paths: engine.paths(),
        });
        if (!(await this.checkpoint(run))) return;
        const runId = newId('mergecheck');
        let started = false;
        let waitingForEngine = false;
        const result = await recordMergeCheck(
          ctx,
          {
            id: runId,
            projectKey: train.projectKey,
            repo: train.repo,
            kind: 'train',
            trainId: train.id,
            taskKeys: train.members.map((member) => member.taskKey),
            commit: built.mergeCommit,
            base: onto,
            maxWorkers: train.reviewTest.maxWorkers,
            runner,
          },
          (markStarted) =>
            executor.run(
              prepared.spec({ runId, command: train.reviewTest.command, reviewTest: train.reviewTest }),
              run.signal ?? new AbortController().signal,
              () => {
                markStarted();
                if (started || run.signal?.aborted) return;
                started = true;
                ctx.unitOfWork(() => {
                  this.save(train, { step: 'checking' });
                  if (!waitingForEngine) this.patchMembers(train, { step: 'checking' });
                });
              },
              {
                linkWaitMs: MERGE_ENGINE_WAIT_MS,
                onLinkWait: (waiting) => {
                  waitingForEngine = waiting;
                  if (
                    !run.signal?.aborted &&
                    !this.hooks.stopped() &&
                    ctx.repos.mergeTrains.get(train.id)?.state === 'running' &&
                    this.rows(train).every((row) => row.state === 'running')
                  )
                    this.patchMembers(train, { step: waiting ? 'engine_waiting' : train.step });
                },
              },
            ),
        );
        if (!(await this.checkpoint(run))) return;
        if (result.outcome === 'error' && result.reason === 'engine_offline')
          throw new EngineLinkLostError('the merge check lost the card engine', true);
        const check = {
          command: train.reviewTest.command,
          runId,
          status: result.outcome,
          runner,
          ...(result.externalUrl ? { url: result.externalUrl } : {}),
        };
        ctx.unitOfWork(() => {
          this.save(train, { check });
          this.patchMembers(train, { check });
          if (result.outcome === 'failed') {
            const detail = [result.failedFiles.join('\n'), result.outputTail.slice(-8000)]
              .filter(Boolean)
              .join('\n');
            for (const row of this.rows(train))
              this.deps.timeline.append({
                projectKey: row.projectKey,
                taskKey: row.taskKey,
                actor: SYSTEM_ACTOR,
                type: 'task_note',
                data: {
                  text: `Merge train ${train.id} (${train.members.map((m) => m.taskKey).join(', ')}) failed its group check (${runId}). The individual cause has not yet been identified. Smaller attempts will check the current default branch.\n${detail}`,
                  mentions: [],
                },
              });
          }
        });
        ctx.logger.info(
          {
            trainId: train.id,
            runId,
            members: train.members.length,
            outcome: result.outcome,
            durationMs: result.durationMs,
          },
          'merge train check completed',
        );
        if (result.outcome === 'failed') {
          if (await this.diagnose(run, engine, executor, result)) return;
          return await this.requeue(train);
        }
        if (result.outcome !== 'passed')
          return await this.terminal(
            run,
            'check_error',
            `The group check could not run (${result.reason ?? result.outcome}): ${result.outputTail.slice(-8000)}`,
          );
        const flaky = flakyCheckFiles(result);
        if (flaky.length > 0) {
          ctx.unitOfWork(() => {
            for (const row of this.rows(train))
              this.deps.timeline.append({
                projectKey: row.projectKey,
                taskKey: row.taskKey,
                actor: SYSTEM_ACTOR,
                type: 'task_note',
                data: { text: flakyCheckNote(runId, flaky), mentions: [] },
              });
          });
          ctx.logger.info(
            { runId, taskKeys: this.rows(train).map((row) => row.taskKey), flakyFiles: flaky },
            'merge check passed with flaky test files',
          );
        }
        const publish = await this.lock(this.rows(train), async () => {
          for (const row of this.rows(train)) if (!(await this.valid(row, train))) return false;
          if (!(await this.pullRequests(train)) || run.signal?.aborted || this.hooks.stopped()) return false;
          // No awaited work between the final state reread and crossing the publication boundary.
          if (this.rows(train).some((r) => r.state !== 'running')) return false;
          this.save(train, { step: 'pushing' });
          this.patchMembers(train, { step: 'pushing' });
          run.pushing = true;
          return true;
        });
        if (!publish) return await this.invalidate(run);
        if (base.remote) {
          const pushed = await merger.push(ref, { base: train.base, mergeCommit: built.mergeCommit });
          if (!pushed.ok) {
            if (pushed.reason === 'non_fast_forward' && attempt === 0) {
              run.pushing = false;
              await merger.releaseCheck(ref, { mergeId: train.id });
              continue;
            }
            return await this.terminal(
              run,
              pushed.reason === 'non_fast_forward'
                ? 'remote_moved'
                : pushed.reason === 'rejected'
                  ? 'push_rejected'
                  : 'remote_unreachable',
              pushed.message,
            );
          }
          ctx.unitOfWork(() => {
            this.save(train, { landed: 'remote' });
            this.patchMembers(train, { landed: 'remote', pushed: { remote: base.remote!.name } });
          });
        }
        const advanced = await merger.advance(ref, {
          base: train.base,
          from: base.local,
          to: built.mergeCommit,
        });
        if (!advanced.ok) return await this.terminal(run, 'local_checkout', advanced.message);
        return await this.finish(train);
      }
    } catch (err) {
      const durable = this.deps.ctx.repos.mergeTrains.get(train.id);
      if (durable?.state !== 'running') throw err;
      // Keep the durable red check recoverable if the atomic split itself was interrupted.
      if (durable.check?.status === 'failed') throw err;
      // A failed transaction rolls back SQLite, not the in-memory manifest object.
      Object.assign(train, durable);
      if (!run.pushing && !(await this.checkpoint(run))) return;
      if (isEngineLinkLost(err)) throw err;
      await this.terminal(
        run,
        train.step === 'check_waiting' || train.step === 'checking' ? 'check_error' : 'merge_error',
        err instanceof Error ? err.message : 'The merge train failed',
      );
    } finally {
      await merger
        ?.releaseCheck(ref, { mergeId: train.id })
        .catch((err: unknown) =>
          ctx.logger.warn({ err, trainId: train.id }, 'could not release a merge train checkout'),
        );
    }
  }
}
