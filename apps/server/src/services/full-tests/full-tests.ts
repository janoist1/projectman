import path from 'node:path';
import {
  effectiveRepo,
  isOpenTask,
  isTheme,
  MERGE_CHECK_WORKFLOW,
  repoOf,
  reviewTestRunnerBeforeReview,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type {
  EngineId,
  FullTestCancelReason,
  FullTestErrorReason,
  MergeCheckRunner,
  ProjectConfig,
  RepoConfig,
  Task,
} from '@projectman/shared';
import type {
  EngineDirectory,
  EngineHost,
  FullTestResult,
  FullTestSpec,
  ReleaseWorkAdmission,
} from '../../contracts';
import type { FullTestRunRecord, ReviewPinRecord } from '../../db';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';
import type { Messaging } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import { Effect, Exit, Scope } from 'effect';
import { runFork, runPromise } from '../../kernel';
import type { FullTestSessions, FullTestRunSandbox } from './ports';
import { makeFullTestQueue } from './queue';
import type { FullTestQueueEffects } from './queue';
import { stopStageReviewers, workStageBefore } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import { newId, SYSTEM_ACTOR } from '../../kernel';

/** How much of a failed run's output the developer's message carries. */
const MESSAGE_OUTPUT_CHARS = 3000;

type ReviewTest = NonNullable<RepoConfig['reviewTest']>;

/**
 * Where the task's repository runs the full test before review (PM-217, PM-909): none when it is not
 * asked for, and none when it runs only at the merge (`fullTestAtMerge`, PM-386) or `beforeReview` is off.
 */
function reviewRunnerOf(config: ProjectConfig, task: Pick<Task, 'repo'>): MergeCheckRunner | undefined {
  const repo = repoOf(config, effectiveRepo(config, task));
  return repo ? reviewTestRunnerBeforeReview(repo) : undefined;
}

/** The full test the task's repository asks for before review; none when `reviewRunnerOf` is none. */
function reviewTestOf(config: ProjectConfig, task: Pick<Task, 'repo'>): ReviewTest | undefined {
  return reviewRunnerOf(config, task) ? repoOf(config, effectiveRepo(config, task))?.reviewTest : undefined;
}

/**
 * The check id of a GitHub Actions review run: a merge-style id, because the engine accepts no other
 * (`merge.release_check` and the check branch use it). Derived from the run id, so it stays unique.
 */
function reviewCheckId(runId: string): string {
  return `mrg_${runId
    .replace(/^ftr_/, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40)
    .padEnd(8, '0')}`;
}

/**
 * The shared git directory the checkout's commits live in: the `.git` directory of the configured
 * repository (the checkout is a linked worktree of it). It comes from the project's configuration and
 * not from the checkout's own `.git` file, which the developer can write. Undefined when the
 * repository has no such directory. `workspacePath` is the project's working directory on the engine
 * that runs the test (PM-311); by default the configured one. The directory is looked up on that
 * engine's disk (PM-312).
 */
export async function repoGitDir(
  engine: Pick<EngineHost, 'resolveGitDir'>,
  config: ProjectConfig,
  task: Pick<Task, 'repo'>,
  workspacePath: string = config.project.workspacePath,
): Promise<string | undefined> {
  const repo = repoOf(config, effectiveRepo(config, task));
  if (!repo) return undefined;
  return (await engine.resolveGitDir(path.resolve(workspacePath, repo.path))) ?? undefined;
}

/** Whether a run says nothing more will come for its pin: it ended, or its commit moved on. */
function settled(run: FullTestRunRecord): boolean {
  if (run.status === 'cancelled') return run.reason === 'branch_moved';
  return run.status === 'passed' || run.status === 'failed' || run.status === 'error';
}

interface FullTestRunsDeps {
  ctx: DomainContext;
  projects: ProjectService;
  tasks: TaskService;
  sessions: FullTestSessions;
  messaging: Messaging;
  timeline: TimelineService;
  /** The engines (PM-311): a card's full test runs on its own engine's executor, with its places. */
  engines: EngineDirectory;
  /** Called when a pin's result is in: the hand-over that waited for it is tried again. */
  released: () => void;

  /** Builds the sandbox without depending on the session policy module. */
  runSandbox: FullTestRunSandbox;
  /** The release gate (PM-752); absent: never held. */
  work?: ReleaseWorkAdmission;
}

/**
 * The server's full test of a task's pinned commit before it is reviewed (PM-217). When a task
 * enters review (or a new round pins a new commit) and its repository has a `reviewTest`, a run is
 * queued; one runs at a time in the whole installation, in the executor's sandbox. While a pin has
 * no result the reviewers do not start and the developer's messages to them wait (`holds`). A green
 * run lets the reviewer start, a failed one sends the task back to the work stage with the failure,
 * and a run that could not run lets the reviewer start with that fact in its brief.
 */
export class FullTestRuns {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: FullTestSessions;
  private readonly messaging: Messaging;
  private readonly timeline: TimelineService;
  private readonly engines: EngineDirectory;
  private readonly released: () => void;
  /** The engines whose sandbox can run a full test (checked at the start). */
  private readonly availableOn = new Set<EngineId>();
  /** The engines with a full test executor: an engine run needs its sandbox too, a GitHub Actions run does not (PM-909). */
  private readonly executorOn = new Set<EngineId>();
  private stopped = false;
  private scope = Scope.makeUnsafe();
  private core: FullTestQueueEffects;

  private readonly deps: FullTestRunsDeps;

  constructor(deps: FullTestRunsDeps) {
    this.deps = deps;
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.messaging = deps.messaging;
    this.timeline = deps.timeline;
    this.engines = deps.engines;
    this.released = deps.released;
    this.core = this.makeCore();
  }

  /** Whether any engine can run a full test, here or on GitHub Actions. */
  private get available(): boolean {
    return this.executorOn.size > 0;
  }

  /**
   * Where the task's full test runs now: its repository's runner, and only when the card's engine can
   * run it (an engine run needs the sandbox; a GitHub Actions run only the engine's executor, PM-909).
   */
  private runnerFor(task: Task, config: ProjectConfig): MergeCheckRunner | undefined {
    const runner = reviewRunnerOf(config, task);
    if (!runner) return undefined;
    const engineId = this.sessions.cardEngineId(config.project.key, task);
    const usable = runner === 'engine' ? this.availableOn.has(engineId) : this.executorOn.has(engineId);
    return usable ? runner : undefined;
  }

  /**
   * Startup: asks the executor whether the sandbox can run here (the engine run is off when it cannot),
   * ends the runs the last server left (`interrupted`) and queues the pins that still need one.
   */
  async init(): Promise<void> {
    this.availableOn.clear();
    this.executorOn.clear();
    for (const engineId of this.engines.ids()) {
      const executor = this.engines.get(engineId)?.fullTestExecutor;
      if (!executor) continue;
      this.executorOn.add(engineId);
      const state = await executor.available().catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
      }));
      if (!state.ok) {
        this.ctx.logger.warn(
          { reason: state.reason, engineId },
          'the full test before review is off: no sandbox',
        );
        continue;
      }
      this.availableOn.add(engineId);
    }
    if (!this.available) return;
    this.stopped = false;
    const runs = this.ctx.repos.fullTestRuns;
    for (const run of [...runs.list('running'), ...runs.list('queued')]) this.cancel(run, 'interrupted');
    await this.syncAll();
  }

  /**
   * An engine connected after the startup check (PM-315, a remote engine): asks its executor and, when it
   * can run the sandbox, puts it in and queues the pins that wait for a run. An engine that is gone stays
   * in: a run on it ends with `engine_offline` and the reviewers see why, instead of being let through.
   */
  async engineOnline(engineId: EngineId): Promise<void> {
    if (this.stopped || this.availableOn.has(engineId)) return;
    const executor = this.engines.get(engineId)?.fullTestExecutor;
    if (!executor) return;
    const newExecutor = !this.executorOn.has(engineId);
    this.executorOn.add(engineId);
    const state = await executor.available().catch((err: unknown) => ({
      ok: false as const,
      reason: err instanceof Error ? err.message : String(err),
    }));
    if (state.ok) this.availableOn.add(engineId);
    else {
      this.ctx.logger.warn(
        { reason: state.reason, engineId },
        'the full test before review is off: no sandbox',
      );
      // A GitHub Actions run needs no sandbox: only a first sight of the executor changes what can run.
      if (!newExecutor) return;
    }
    await this.syncAll();
  }

  /** Whether a full test runs on the task's handed-over commits: the runner is usable and its repository asks for one. */
  runsFor(task: Task, config: ProjectConfig): boolean {
    return this.runnerFor(task, config) !== undefined;
  }

  /** Server stop: the running run ends (`shutdown`) and nothing new starts. */
  async stop(): Promise<void> {
    this.stopped = true;
    // Without a sandbox nothing ever ran: there is nothing to end (and the database may be closed already).
    if (!this.available) return;
    const runs = this.ctx.repos.fullTestRuns;
    for (const run of runs.list('running')) this.cancel(run, 'shutdown');
    await runPromise(Scope.close(this.scope, Exit.void));
    this.scope = Scope.makeUnsafe();
    this.core = this.makeCore();
  }

  /**
   * Whether the task's reviewers wait for the full test of its pinned commit: the feature is on, the
   * repository asks for one, the task is in the stage of its pin, and no result is in yet.
   */
  holds(task: Task, config: ProjectConfig): boolean {
    if (!this.available || !isOpenTask(task) || isTheme(task) || task.status !== 'active') return false;
    const runner = this.runnerFor(task, config);
    if (!runner) return false;
    const pin = this.ctx.repos.reviewPins.get(task.key);
    if (!pin || pin.stageId !== task.stageId) return false;
    // Only a result of the current runner counts: another runner's older pass does not let the reviewer in.
    return !this.ctx.repos.fullTestRuns.forPin(pin, { runner }).some(settled);
  }

  /**
   * Queues a run for every pin that needs one, and drops the runs of pins that are gone; one project's
   * only (the review test setting of it changed) when `onlyProject` is given.
   */
  async syncAll(onlyProject?: string): Promise<void> {
    if (!this.available) return;
    const runs = this.ctx.repos.fullTestRuns;
    const keys = new Map<string, string>();
    for (const pin of this.ctx.repos.reviewPins.list()) keys.set(pin.taskKey, pin.projectKey);
    for (const run of [...runs.list('queued'), ...runs.list('running')])
      keys.set(run.taskKey, run.projectKey);
    for (const [taskKey, projectKey] of keys) {
      if (onlyProject !== undefined && projectKey !== onlyProject) continue;
      try {
        await this.sync(projectKey, taskKey);
      } catch (err) {
        this.ctx.logger.warn({ err, taskKey }, 'could not queue the full test of a task');
      }
    }
  }

  /**
   * Brings the runs of one task in line with its pin: a queued or running run of an older pin (or of
   * a stage the task left) is dropped, and a run is queued for the current pin when it has none.
   */
  async sync(projectKey: string, taskKey: string): Promise<void> {
    if (!this.available || this.stopped) return;
    const task = this.tasks.find(projectKey, taskKey);
    const pin = this.ctx.repos.reviewPins.get(taskKey);
    const config = task ? await this.projects.config(projectKey) : null;
    const runs = this.ctx.repos.fullTestRuns;
    const runner =
      task && config && pin && this.pinApplies(task, pin) ? this.runnerFor(task, config) : undefined;
    const wanted = task && config && pin && runner ? { task, config, pin, runner } : null;
    let settingChanged = false;
    for (const run of runs.forTask(taskKey)) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      if (
        wanted &&
        wanted.pin.commit === run.commit &&
        run.createdAt >= wanted.pin.pinnedAt &&
        run.runner === wanted.runner
      )
        continue;
      const reason = this.dropReason(task, pin, run);
      if (reason === 'configuration_changed') settingChanged = true;
      this.cancel(run, reason);
    }
    if (
      wanted &&
      !runs
        .forPin(wanted.pin, { runner: wanted.runner })
        .some((run) => run.status === 'queued' || run.status === 'running' || settled(run))
    ) {
      runs.queue({
        id: newId('ftr'),
        projectKey,
        taskKey,
        repo: effectiveRepo(wanted.config, wanted.task) ?? '',
        branch: wanted.pin.branch,
        commit: wanted.pin.commit,
        runner: wanted.runner,
        createdAt: isoNow(this.ctx),
      });
      this.ctx.logger.info(
        { taskKey, commit: wanted.pin.commit, runner: wanted.runner },
        'the full test of a pinned commit is queued',
      );
      this.tasks.publish(wanted.task);
    }
    // The setting dropped a run the reviewers waited for and asks for no other: they may start now.
    if (settingChanged && task && config && !this.holds(task, config)) this.release(task, config);
    this.pump();
  }

  /** Whether the task is still in the stage of its pin, open and active: the pin can be waited for. */
  private pinApplies(task: Task, pin: ReviewPinRecord): boolean {
    return isOpenTask(task) && !isTheme(task) && task.status === 'active' && pin.stageId === task.stageId;
  }

  /**
   * Why a run that is no longer wanted is dropped: the task left the stage of its pin (or was closed or
   * paused), a newer commit was pinned, or else the repository's review test setting changed (PM-909).
   */
  private dropReason(
    task: Task | null | undefined,
    pin: ReviewPinRecord | null | undefined,
    run: FullTestRunRecord,
  ): FullTestCancelReason {
    if (!task || !pin || !this.pinApplies(task, pin)) return 'stage_left';
    if (pin.commit !== run.commit || run.createdAt < pin.pinnedAt) return 'repinned';
    return 'configuration_changed';
  }

  /** Ends a queued or running run without a verdict; a running one is stopped. */
  private cancel(run: FullTestRunRecord, reason: FullTestCancelReason): void {
    this.ctx.repos.fullTestRuns.finish(run.id, {
      status: 'cancelled',
      reason,
      finishedAt: isoNow(this.ctx),
    });
    // A checkpoint in execute() can cancel itself: awaiting its own fiber would deadlock.
    runFork(this.core.abort(run.id));
    const task = this.tasks.find(run.projectKey, run.taskKey);
    if (task) this.tasks.publish(task);
  }

  /** Starts the queued runs, if none is draining (also after a release's maintenance fence went down). */
  pump(): void {
    if (this.stopped || !this.available) return;
    runFork(this.core.pump);
  }

  private makeCore(): FullTestQueueEffects {
    return Effect.runSync(
      Scope.provide(
        makeFullTestQueue({
          next: () => (this.stopped ? undefined : this.ctx.repos.fullTestRuns.list('queued')[0]),
          step: async (run, signal) => {
            try {
              await this.execute(run, signal);
            } catch (err) {
              this.ctx.logger.warn({ err, runId: run.id }, 'a full test run failed to go through');
              await this.failToRun(run.id);
            }
          },
          logger: this.ctx.logger,
          ...(this.deps.work ? { work: this.deps.work } : {}),
        }),
        this.scope,
      ),
    );
  }

  /**
   * A run that threw before it ended: it ends as "could not run" like any other, so the card gets its
   * event and its reviewers are not held for a result that never comes.
   */
  private async failToRun(runId: string): Promise<void> {
    const row = this.ctx.repos.fullTestRuns.get(runId);
    if (!row || (row.status !== 'queued' && row.status !== 'running')) return;
    const task = this.tasks.find(row.projectKey, row.taskKey);
    const config = task ? await this.projects.config(row.projectKey).catch(() => null) : null;
    try {
      if (task && config)
        return await this.end(row, task, config, { outcome: 'error', reason: 'spawn_failed' }, '');
    } catch (err) {
      this.ctx.logger.warn({ err, runId }, 'could not record a full test run that failed to go through');
    }
    const left = this.ctx.repos.fullTestRuns.get(runId);
    if (left && (left.status === 'queued' || left.status === 'running'))
      this.ctx.repos.fullTestRuns.finish(runId, {
        status: 'error',
        reason: 'spawn_failed',
        finishedAt: isoNow(this.ctx),
      });
  }

  /** One run, from the checks before it to what follows its result. */
  private async execute(run: FullTestRunRecord, signal: AbortSignal): Promise<void> {
    const runs = this.ctx.repos.fullTestRuns;
    const { projectKey, taskKey } = run;
    const task = this.tasks.find(projectKey, taskKey);
    const pin = this.ctx.repos.reviewPins.get(taskKey);
    const config = task ? await this.projects.config(projectKey) : null;
    // 'configuration_changed' means the pin itself still applies; then only the setting can drop the run
    // (runner switched or off, or its runner became unusable since it was queued).
    const dropped = this.dropReason(task, pin, run);
    if (
      !task ||
      !config ||
      !pin ||
      dropped !== 'configuration_changed' ||
      this.runnerFor(task, config) !== run.runner
    ) {
      this.cancel(run, dropped);
      return;
    }
    const reviewTest = reviewTestOf(config, task)!;
    const command = reviewTest.command;
    if (run.runner === 'github_actions') return this.executeOnGithub(run, task, config, command, signal);
    const head = await this.sessions.sourceHead(config, task);
    if (runs.get(run.id)?.status !== 'queued') return;
    // The server stopped while the checkout was read: nothing starts after the shutdown.
    if (this.stopped) return this.cancel(run, 'shutdown');
    if (!head)
      return this.end(run, task, config, { outcome: 'error', reason: 'spawn_failed' }, 'no checkout to test');
    if (head.commit !== run.commit) return this.cancel(run, 'branch_moved');
    if (head.dirty) return this.end(run, task, config, { outcome: 'error', reason: 'checkout_dirty' }, '');

    // The card's engine runs it, with its places (PM-311).
    const engine = this.engines.get(this.sessions.cardEngineId(projectKey, task));
    const executor = engine?.fullTestExecutor;
    // The engine's working directory of the project; null: the engine does not hold the project.
    const workspace = engine?.workspacePath(projectKey);
    if (!engine || !executor || !workspace)
      return this.end(
        run,
        task,
        config,
        { outcome: 'error', reason: 'spawn_failed' },
        'no engine to test on',
      );
    const paths = engine.paths();
    runs.start(run.id, isoNow(this.ctx));
    this.tasks.publish(task);
    let result: FullTestResult;
    try {
      result = await executor.run(
        {
          runId: run.id,
          cwd: head.path,
          command,
          maxWorkers: reviewTest.maxWorkers,
          timeoutMs: reviewTest.timeoutMinutes * 60_000,
          sandbox: this.deps.runSandbox({
            checkout: head.path,
            gitDir: await repoGitDir(engine, config, task, workspace),
            userHome: paths.userHome,
            appHome: paths.home ?? undefined,
            closedTmpRoots: [
              ...paths.claudeTmpRoots,
              ...(paths.sessionTmpRoot ? [path.dirname(paths.sessionTmpRoot)] : []),
            ],
          }),
        },
        signal,
      );
    } catch (err) {
      this.ctx.logger.warn({ err, runId: run.id }, 'the full test executor threw');
      result = {
        outcome: 'error',
        reason: 'spawn_failed',
        exitCode: null,
        durationMs: 0,
        failedFiles: [],
        outputTail: '',
      };
    }
    // Dropped while it ran (new pin, stage left, shutdown): the result is of no use.
    if (runs.get(run.id)?.status !== 'running') return;
    if (await this.droppedWhileRunning(run)) return;

    // The branch must not have moved or become dirty while the command ran.
    const after = await this.sessions.sourceHead(config, task).catch(() => null);
    if (runs.get(run.id)?.status !== 'running') return;
    if (after && after.commit !== run.commit) return this.cancel(run, 'branch_moved');
    if (after?.dirty)
      return this.end(run, task, config, { outcome: 'error', reason: 'checkout_dirty' }, '', command);
    await this.end(run, task, config, result, result.outputTail, command);
  }

  /**
   * Cancels a run whose pin or setting changed while the executor was busy and no sync dropped it yet
   * (PM-909): its verdict belongs to a commit or a runner nobody asks for any more. True: it was dropped.
   */
  private async droppedWhileRunning(run: FullTestRunRecord): Promise<boolean> {
    const task = this.tasks.find(run.projectKey, run.taskKey);
    const pin = this.ctx.repos.reviewPins.get(run.taskKey);
    const config = task ? await this.projects.config(run.projectKey).catch(() => null) : null;
    // The run may have been ended by someone else while the configuration was read.
    if (this.ctx.repos.fullTestRuns.get(run.id)?.status !== 'running') return true;
    const reason = this.dropReason(task, pin, run);
    if (task && config && reason === 'configuration_changed' && this.runnerFor(task, config) === run.runner)
      return false;
    this.cancel(run, reason);
    return true;
  }

  /**
   * One run on GitHub Actions (PM-909): the card's engine pushes the pinned commit to a temporary check
   * branch and dispatches the merge check workflow in full mode (`all`); no local checkout, sandbox or
   * heavy-run lock is used, and a failure to reach GitHub is an error result, never a local run.
   */
  private async executeOnGithub(
    run: FullTestRunRecord,
    task: Task,
    config: ProjectConfig,
    command: string,
    signal: AbortSignal,
  ): Promise<void> {
    const runs = this.ctx.repos.fullTestRuns;
    const { projectKey } = run;
    const reviewTest = reviewTestOf(config, task)!;
    const repo = repoOf(config, effectiveRepo(config, task));
    // The server stopped before the run started: nothing starts after the shutdown.
    if (this.stopped) return this.cancel(run, 'shutdown');
    const executor = this.engines.get(this.sessions.cardEngineId(projectKey, task))?.fullTestExecutor;
    if (!executor)
      return this.end(run, task, config, { outcome: 'error', reason: 'engine_offline' }, '', command);
    if (!repo?.github)
      return this.end(run, task, config, { outcome: 'error', reason: 'github_unavailable' }, '', command);
    runs.start(run.id, isoNow(this.ctx));
    this.tasks.publish(task);
    const spec: FullTestSpec = {
      runId: run.id,
      cwd: `github-actions:${repo.github}`,
      command,
      maxWorkers: reviewTest.maxWorkers,
      timeoutMs: reviewTest.timeoutMinutes * 60_000,
      sandbox: { denyRead: [], allowRead: [] },
      githubActions: {
        ref: { projectKey, repo: repo.name },
        mergeId: reviewCheckId(run.id),
        repo: repo.github,
        base: repo.defaultBranch,
        commit: run.commit,
        workflow: MERGE_CHECK_WORKFLOW,
        all: true,
      },
    };
    let result: FullTestResult;
    try {
      result = await executor.run(spec, signal);
    } catch (err) {
      this.ctx.logger.warn({ err, runId: run.id }, 'the full test executor threw');
      result = {
        outcome: 'error',
        reason: 'spawn_failed',
        exitCode: null,
        durationMs: 0,
        failedFiles: [],
        outputTail: '',
      };
    }
    if (runs.get(run.id)?.status !== 'running') return;
    if (await this.droppedWhileRunning(run)) return;
    await this.end(run, task, config, result, result.outputTail, command);
  }

  /** Records the end of a run and does what its outcome asks for. */
  private async end(
    run: FullTestRunRecord,
    task: Task,
    config: ProjectConfig,
    result: Partial<FullTestResult> & { outcome: FullTestResult['outcome'] },
    outputTail: string,
    command?: string,
  ): Promise<void> {
    const { projectKey, taskKey } = run;
    const reason: FullTestErrorReason | undefined = result.outcome === 'error' ? result.reason : undefined;
    const failedFiles = result.failedFiles ?? [];
    const durationMs = result.durationMs ?? 0;
    const exitCode = result.exitCode ?? null;
    this.ctx.unitOfWork(() => {
      this.ctx.repos.fullTestRuns.finish(run.id, {
        status: result.outcome,
        reason: reason ?? null,
        exitCode,
        failedFiles,
        durationMs,
        externalUrl: result.externalUrl ?? null,
        finishedAt: isoNow(this.ctx),
      });
      this.timeline.append({
        projectKey,
        taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_full_test',
        data: {
          outcome: result.outcome,
          runId: run.id,
          ...(command !== undefined ? { command } : {}),
          repo: run.repo,
          branch: run.branch,
          commit: run.commit,
          runner: run.runner,
          ...(result.externalUrl ? { externalUrl: result.externalUrl } : {}),
          durationMs,
          exitCode,
          ...(result.outcome === 'failed' ? { failedFiles } : {}),
          ...(reason ? { reason } : {}),
          ...(result.outcome !== 'passed' && outputTail ? { outputTail } : {}),
        },
      });
    });
    this.ctx.logger.info(
      { taskKey, runId: run.id, outcome: result.outcome, reason, durationMs },
      'the full test of a pinned commit ended',
    );
    const current = this.tasks.find(projectKey, taskKey);
    if (current) this.tasks.publish(current);
    if (result.outcome === 'failed')
      await this.sendBack(run, task, config, failedFiles, outputTail, result.externalUrl);
    else this.release(task, config);
  }

  /** The reviewers of the task's stage may start: the hand-over is tried again, their messages go out. */
  private release(task: Task, config: ProjectConfig): void {
    const current = this.tasks.find(task.projectKey, task.key);
    const stage = current ? stageOf(config, current.stageId) : undefined;
    this.released();
    if (!current || !stage) return;
    for (const handle of stageOwners(config, stage))
      if (handle !== current.assignee)
        void this.messaging
          .releaseWaiting(task.projectKey, task.key, handle)
          .catch((err: unknown) =>
            this.ctx.logger.warn(
              { err, taskKey: task.key, member: handle },
              'could not release messages after the full test',
            ),
          );
  }

  /**
   * A failed run sends the task back to the work stage before its stage, as a fix round, stops the
   * reviewers' sessions and tells the developer. When the gate does not let the task back it stays,
   * the developer is told, and the reviewers are not held any longer.
   */
  private async sendBack(
    run: FullTestRunRecord,
    task: Task,
    config: ProjectConfig,
    failedFiles: string[],
    outputTail: string,
    externalUrl?: string,
  ): Promise<void> {
    const { projectKey, taskKey } = run;
    const current = this.tasks.find(projectKey, taskKey);
    const stage = current ? stageOf(config, current.stageId) : undefined;
    const back = current ? workStageBefore(config, current.stageId) : undefined;
    if (!current || !stage || !back) {
      this.ctx.logger.warn({ taskKey }, 'the full test failed, but no work stage is before the task stage');
      this.release(task, config);
      return;
    }
    let moved = false;
    try {
      const result = await this.tasks.moveToStage(projectKey, taskKey, back.id, SYSTEM_ACTOR, {
        testsFailed: { runId: run.id, branch: run.branch, commit: run.commit },
      });
      moved = result.moved;
    } catch (err) {
      this.ctx.logger.warn({ err, taskKey }, 'could not send the task back after a failed full test');
    }
    if (moved) await stopStageReviewers(this.sessions, config, current, stage, back);
    else this.release(task, config);
    if (!current.assignee) return;
    const command = reviewTestOf(config, current)?.command ?? '';
    await this.messaging.send(
      projectKey,
      'system',
      {
        to: [current.assignee],
        taskKey,
        text: failureMessage({
          task: current,
          from: stage.name,
          to: moved ? back.name : null,
          command,
          run,
          failedFiles,
          outputTail,
          ...(externalUrl ? { externalUrl } : {}),
          defaultBranch: repoOf(config, effectiveRepo(config, current))?.defaultBranch ?? 'main',
        }),
      },
      { actor: SYSTEM_ACTOR },
    );
  }
}

/** The system message to the developer of a task whose full test failed. */
function failureMessage(input: {
  task: Pick<Task, 'key'>;
  from: string;
  /** The stage it was sent back to; null when it stayed. */
  to: string | null;
  command: string;
  run: Pick<FullTestRunRecord, 'branch' | 'commit' | 'runner'>;
  failedFiles: string[];
  outputTail: string;
  /** The GitHub Actions run page of a `github_actions` run. */
  externalUrl?: string;
  defaultBranch: string;
}): string {
  const { task, from, to, command, run, failedFiles, outputTail, externalUrl, defaultBranch } = input;
  const github = run.runner === 'github_actions';
  const test = github ? 'GitHub Actions full test' : "server's full test";
  const where = github ? '' : ', PTY tests included';
  const output =
    outputTail.length > MESSAGE_OUTPUT_CHARS
      ? outputTail.startsWith('⎯') || outputTail.startsWith('## ')
        ? `${outputTail.slice(0, MESSAGE_OUTPUT_CHARS)}\n…`
        : `…\n${outputTail.slice(-MESSAGE_OUTPUT_CHARS)}`
      : outputTail;
  return [
    to
      ? `Task ${task.key} came back from ${from} to ${to}: the ${test} (\`${command}\`${where}) failed on commit ${run.commit} of your branch ${run.branch}.`
      : `The ${test} (\`${command}\`${where}) failed on commit ${run.commit} of your branch ${run.branch}, but task ${task.key} could not be sent back from ${from}.`,
    ...(externalUrl ? [`The GitHub Actions run: ${externalUrl}`] : []),
    failedFiles.length > 0
      ? `Failed test files: ${failedFiles.join(', ')}.`
      : 'No test file is named (for example the type check failed).',
    ...(output ? ['The end of the output:', '```', output, '```'] : []),
    `${github ? 'The full test runs on GitHub Actions, not in your own sandbox.' : 'The PTY tests do not run in your own sandbox.'} Fix the failure, commit, and move the task to ${from} again: ${github ? 'GitHub Actions' : 'the server'} runs the full test again. If the same failure is on ${defaultBranch} too, do not touch code that is not yours: ask the owner with ask_human.`,
  ].join('\n');
}
