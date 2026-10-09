import path from 'node:path';
import { effectiveRepo, isOpenTask, isTheme, repoOf, stageOf, stageOwners } from '@projectman/shared';
import type {
  EngineId,
  FullTestCancelReason,
  FullTestErrorReason,
  ProjectConfig,
  RepoConfig,
  Task,
} from '@projectman/shared';
import type { EngineDirectory, EngineHost, FullTestResult } from '../contracts';
import type { FullTestRunRecord, ReviewPinRecord } from '../db';
import type { DomainContext } from './context';
import { isoNow } from './context';
import type { Messaging } from './messaging';
import type { ProjectService } from './projects';
import { fullTestSandbox } from './session-policy';
import type { SessionOrchestrator } from './sessions';
import { stopStageReviewers, workStageBefore } from './stage-reviewers';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { newId, SYSTEM_ACTOR } from './util';

/** How much of a failed run's output the developer's message carries. */
const MESSAGE_OUTPUT_CHARS = 3000;

type ReviewTest = NonNullable<RepoConfig['reviewTest']>;

/** The full test the task's repository asks for before review (PM-217); none when it is not asked for. */
export function reviewTestOf(config: ProjectConfig, task: Pick<Task, 'repo'>): ReviewTest | undefined {
  return repoOf(config, effectiveRepo(config, task))?.reviewTest;
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
  private readonly sessions: SessionOrchestrator;
  private readonly messaging: Messaging;
  private readonly timeline: TimelineService;
  private readonly engines: EngineDirectory;
  private readonly released: () => void;
  /** The engines whose sandbox can run a full test (checked at the start). */
  private readonly availableOn = new Set<EngineId>();
  private stopped = false;
  private current: { runId: string; controller: AbortController } | null = null;
  private draining: Promise<void> | null = null;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    messaging: Messaging;
    timeline: TimelineService;
    /** The engines (PM-311): a card's full test runs on its own engine's executor, with its places. */
    engines: EngineDirectory;
    /** Called when a pin's result is in: the hand-over that waited for it is tried again. */
    released: () => void;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.messaging = deps.messaging;
    this.timeline = deps.timeline;
    this.engines = deps.engines;
    this.released = deps.released;
  }

  /** Whether any engine can run a full test. */
  private get available(): boolean {
    return this.availableOn.size > 0;
  }

  /**
   * Startup: asks the executor whether the sandbox can run here (the feature is off when it cannot),
   * ends the runs the last server left (`interrupted`) and queues the pins that still need one.
   */
  async init(): Promise<void> {
    this.availableOn.clear();
    for (const engineId of this.engines.ids()) {
      const executor = this.engines.get(engineId)?.fullTestExecutor;
      if (!executor) continue;
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

  /** Whether a full test runs on the task's handed-over commits: the feature is on and its repository asks for one. */
  runsFor(task: Task, config: ProjectConfig): boolean {
    return (
      this.availableOn.has(this.sessions.cardEngineId(config.project.key, task)) &&
      reviewTestOf(config, task) !== undefined
    );
  }

  /** Server stop: the running run ends (`shutdown`) and nothing new starts. */
  async stop(): Promise<void> {
    this.stopped = true;
    // Without a sandbox nothing ever ran: there is nothing to end (and the database may be closed already).
    if (!this.available) return;
    const runs = this.ctx.repos.fullTestRuns;
    for (const run of runs.list('running')) this.cancel(run, 'shutdown');
    await this.draining?.catch(() => undefined);
  }

  /**
   * Whether the task's reviewers wait for the full test of its pinned commit: the feature is on, the
   * repository asks for one, the task is in the stage of its pin, and no result is in yet.
   */
  holds(task: Task, config: ProjectConfig): boolean {
    if (!this.available || !isOpenTask(task) || isTheme(task) || task.status !== 'active') return false;
    if (!reviewTestOf(config, task)) return false;
    if (!this.availableOn.has(this.sessions.cardEngineId(config.project.key, task))) return false;
    const pin = this.ctx.repos.reviewPins.get(task.key);
    if (!pin || pin.stageId !== task.stageId) return false;
    return !this.ctx.repos.fullTestRuns.forPin(pin).some(settled);
  }

  /** Queues a run for every pin that needs one, and drops the runs of pins that are gone. */
  async syncAll(): Promise<void> {
    if (!this.available) return;
    const runs = this.ctx.repos.fullTestRuns;
    const keys = new Map<string, string>();
    for (const pin of this.ctx.repos.reviewPins.list()) keys.set(pin.taskKey, pin.projectKey);
    for (const run of [...runs.list('queued'), ...runs.list('running')])
      keys.set(run.taskKey, run.projectKey);
    for (const [taskKey, projectKey] of keys) {
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
    const wanted = task && config && pin && this.pinApplies(task, config, pin) ? { task, config, pin } : null;
    for (const run of runs.forTask(taskKey)) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      if (wanted && wanted.pin.commit === run.commit && run.createdAt >= wanted.pin.pinnedAt) continue;
      // A run of a pin that no longer applies (the stage left, the card closed or paused): "repinned" is only a newer commit.
      this.cancel(run, wanted ? 'repinned' : 'stage_left');
    }
    if (
      wanted &&
      !runs
        .forPin(wanted.pin)
        .some((run) => run.status === 'queued' || run.status === 'running' || settled(run))
    ) {
      runs.queue({
        id: newId('ftr'),
        projectKey,
        taskKey,
        repo: effectiveRepo(wanted.config, wanted.task) ?? '',
        branch: wanted.pin.branch,
        commit: wanted.pin.commit,
        createdAt: isoNow(this.ctx),
      });
      this.ctx.logger.info(
        { taskKey, commit: wanted.pin.commit },
        'the full test of a pinned commit is queued',
      );
      this.tasks.publish(wanted.task);
    }
    this.pump();
  }

  /** Whether a full test is asked for the task's current pin. */
  private pinApplies(task: Task, config: ProjectConfig, pin: ReviewPinRecord): boolean {
    return (
      isOpenTask(task) &&
      !isTheme(task) &&
      task.status === 'active' &&
      pin.stageId === task.stageId &&
      reviewTestOf(config, task) !== undefined &&
      this.availableOn.has(this.sessions.cardEngineId(config.project.key, task))
    );
  }

  /** Ends a queued or running run without a verdict; a running one is stopped. */
  private cancel(run: FullTestRunRecord, reason: FullTestCancelReason): void {
    this.ctx.repos.fullTestRuns.finish(run.id, {
      status: 'cancelled',
      reason,
      finishedAt: isoNow(this.ctx),
    });
    if (this.current?.runId === run.id) this.current.controller.abort();
    const task = this.tasks.find(run.projectKey, run.taskKey);
    if (task) this.tasks.publish(task);
  }

  private pump(): void {
    if (this.draining || this.stopped || !this.available) return;
    const draining = this.drain()
      .catch((err: unknown) => this.ctx.logger.warn({ err }, 'the full test queue failed'))
      .finally(() => {
        this.draining = null;
        if (this.ctx.repos.fullTestRuns.list('queued').length > 0) this.pump();
      });
    this.draining = draining;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.ctx.repos.fullTestRuns.list('queued')[0];
      if (!next || this.stopped) return;
      try {
        await this.execute(next);
      } catch (err) {
        this.ctx.logger.warn({ err, runId: next.id }, 'a full test run failed to go through');
        await this.failToRun(next.id);
      }
    }
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
  private async execute(run: FullTestRunRecord): Promise<void> {
    const runs = this.ctx.repos.fullTestRuns;
    const { projectKey, taskKey } = run;
    const task = this.tasks.find(projectKey, taskKey);
    const pin = this.ctx.repos.reviewPins.get(taskKey);
    const config = task ? await this.projects.config(projectKey) : null;
    const applies = !!task && !!config && !!pin && this.pinApplies(task, config, pin);
    if (!task || !config || !pin || !applies || pin.commit !== run.commit) {
      this.cancel(run, applies ? 'repinned' : 'stage_left');
      return;
    }
    const reviewTest = reviewTestOf(config, task)!;
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
    const controller = new AbortController();
    this.current = { runId: run.id, controller };
    runs.start(run.id, isoNow(this.ctx));
    this.tasks.publish(task);
    let result: FullTestResult;
    try {
      result = await executor.run(
        {
          runId: run.id,
          cwd: head.path,
          command: reviewTest.command,
          maxWorkers: reviewTest.maxWorkers,
          timeoutMs: reviewTest.timeoutMinutes * 60_000,
          sandbox: fullTestSandbox({
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
        controller.signal,
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
    } finally {
      this.current = null;
    }
    // Dropped while it ran (new pin, stage left, shutdown): the result is of no use.
    if (runs.get(run.id)?.status !== 'running') return;

    // The branch must not have moved or become dirty while the command ran.
    const after = await this.sessions.sourceHead(config, task).catch(() => null);
    if (runs.get(run.id)?.status !== 'running') return;
    if (after && after.commit !== run.commit) return this.cancel(run, 'branch_moved');
    if (after?.dirty) return this.end(run, task, config, { outcome: 'error', reason: 'checkout_dirty' }, '');
    await this.end(run, task, config, result, result.outputTail);
  }

  /** Records the end of a run and does what its outcome asks for. */
  private async end(
    run: FullTestRunRecord,
    task: Task,
    config: ProjectConfig,
    result: Partial<FullTestResult> & { outcome: FullTestResult['outcome'] },
    outputTail: string,
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
          repo: run.repo,
          branch: run.branch,
          commit: run.commit,
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
    if (result.outcome === 'failed') await this.sendBack(run, task, config, failedFiles, outputTail);
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
          defaultBranch: repoOf(config, effectiveRepo(config, current))?.defaultBranch ?? 'main',
        }),
      },
      { actor: SYSTEM_ACTOR },
    );
  }
}

/** The system message to the developer of a task whose full test failed. */
export function failureMessage(input: {
  task: Pick<Task, 'key'>;
  from: string;
  /** The stage it was sent back to; null when it stayed. */
  to: string | null;
  command: string;
  run: Pick<FullTestRunRecord, 'branch' | 'commit'>;
  failedFiles: string[];
  outputTail: string;
  defaultBranch: string;
}): string {
  const { task, from, to, command, run, failedFiles, outputTail, defaultBranch } = input;
  const output =
    outputTail.length > MESSAGE_OUTPUT_CHARS
      ? outputTail.startsWith('⎯')
        ? `${outputTail.slice(0, MESSAGE_OUTPUT_CHARS)}\n…`
        : `…\n${outputTail.slice(-MESSAGE_OUTPUT_CHARS)}`
      : outputTail;
  return [
    to
      ? `Task ${task.key} came back from ${from} to ${to}: the server's full test (\`${command}\`, PTY tests included) failed on commit ${run.commit} of your branch ${run.branch}.`
      : `The server's full test (\`${command}\`, PTY tests included) failed on commit ${run.commit} of your branch ${run.branch}, but task ${task.key} could not be sent back from ${from}.`,
    failedFiles.length > 0
      ? `Failed test files: ${failedFiles.join(', ')}.`
      : 'No test file is named (for example the type check failed).',
    ...(output ? ['The end of the output:', '```', output, '```'] : []),
    `The PTY tests do not run in your own sandbox. Fix the failure, commit, and move the task to ${from} again: the server runs the full test again. If the same failure is on ${defaultBranch} too, do not touch code that is not yours: ask the owner with ask_human.`,
  ].join('\n');
}
