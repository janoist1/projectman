import { COMPUTE_JOB_WORKFLOW, dutyMembers } from '@projectman/shared';
import type {
  Actor,
  ComputeJobDefinition,
  ComputeJobRunView,
  FullTestCancelReason,
  ProjectConfig,
  RepoConfig,
} from '@projectman/shared';
import { isEngineLinkLost } from '../../contracts';
import type {
  EngineDirectory,
  EngineHost,
  FullTestResult,
  FullTestSpec,
  MergeBaseState,
} from '../../contracts';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import {
  assertIntegratorAccess,
  conflict,
  delegatesOwnerAuthority,
  forbidden,
  invalid,
  newId,
  notFound,
  SYSTEM_ACTOR,
} from '../../kernel';

/** At most this many runs are queued or running in the installation, so a stuck job cannot pile up GitHub minutes. */
export const COMPUTE_JOBS_MAX = 2;
/** The log tail kept on the run. */
const OUTPUT_TAIL_MAX = 4000;
/** The GitHub-side limit of the job plus the time the run may wait in the queue and be set up. */
const RUN_SLACK_MINUTES = 30;
const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 100;

export interface StartComputeJobInput {
  projectKey: string;
  /** The repository's name; absent: the project's only repository. */
  repo?: string | undefined;
  job: string;
  /** The full commit id, which must be on the repository's remote default branch. */
  commit: string;
  /** Run again even if the same commit has a live run or artifact. */
  force?: boolean | undefined;
  /** The card that gets a note when the run ends. */
  taskKey?: string | undefined;
}

export interface ListComputeJobsInput {
  repo?: string | undefined;
  job?: string | undefined;
  limit?: number | undefined;
}

type Deps = {
  ctx: DomainContext;
  projects: ProjectService;
  tasks: TaskService;
  timeline: TimelineService;
  engines: EngineDirectory;
};

type Engine = EngineHost & Required<Pick<EngineHost, 'merger' | 'fullTestExecutor'>>;

const clip = (text: string): string => (text.length > OUTPUT_TAIL_MAX ? text.slice(-OUTPUT_TAIL_MAX) : text);

/**
 * Compute jobs (PM-1148): heavy machine work the project declares in its repository settings (`computeJobs`) and
 * GitHub Actions runs. The hub records the run; the project's engine runs it as `full_test.run` with the
 * `githubJob` descriptor (PM-1147), the engine alone holding the GitHub access. `start` answers with the queued
 * run at once and the run goes on in the background; the row follows it and the card gets a note at its end.
 */
export class ComputeJobService {
  private readonly deps: Deps;
  private readonly running = new Map<string, AbortController>();

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** A run left unfinished by a restart is over: nothing follows it any more. */
  init(): void {
    const { ctx } = this.deps;
    for (const run of ctx.repos.computeJobRuns.unfinished())
      ctx.repos.computeJobRuns.finish(run.id, {
        status: 'cancelled',
        reason: 'interrupted' satisfies FullTestCancelReason,
        finishedAt: isoNow(ctx),
      });
  }

  /** Stops the runs that follow a GitHub run; each ends as `cancelled`. */
  stop(): void {
    for (const abort of this.running.values()) abort.abort();
  }

  async start(actor: Actor, input: StartComputeJobInput): Promise<ComputeJobRunView> {
    const { ctx, projects, tasks } = this.deps;
    const { projectKey } = input;
    const config = await projects.config(projectKey);
    this.requireAccess(config, actor);
    const repo = this.repoOf(config, input.repo);
    const def = (repo.computeJobs ?? []).find((entry) => entry.id === input.job);
    if (!def) throw invalid('compute_job_unknown', `repository ${repo.name} has no compute job ${input.job}`);
    if (input.taskKey !== undefined && !tasks.find(projectKey, input.taskKey))
      throw notFound('task', input.taskKey);
    const github = repo.github;
    if (!github)
      throw conflict('release_no_github', `repository ${repo.name} has no GitHub repository configured`);

    const engine = this.engineOf(projectKey);
    await this.requirePublished(engine, projectKey, repo, input.commit);

    const records = ctx.repos.computeJobRuns;
    const created = ctx.unitOfWork(() => {
      if (!input.force) {
        const latest = records.latestFor({ projectKey, repo: repo.name, job: def.id, commit: input.commit });
        if (latest && isLive(latest, ctx.now().getTime())) return { kind: 'existing' as const, run: latest };
      }
      if (records.countActive() >= COMPUTE_JOBS_MAX)
        throw conflict('compute_job_busy', `${COMPUTE_JOBS_MAX} compute jobs are running already`);
      const id = newId('job');
      records.insert({
        id,
        projectKey,
        repo: repo.name,
        job: def.id,
        commit: input.commit,
        runner: 'github_actions',
        requestedBy: actor.handle ?? 'system',
        taskKey: input.taskKey ?? null,
        createdAt: isoNow(ctx),
      });
      return { kind: 'new' as const, id };
    });
    if (created.kind === 'existing') return created.run;
    const abort = new AbortController();
    this.running.set(created.id, abort);
    void this.execute(
      { engine, runId: created.id, projectKey, repo, github, def, commit: input.commit },
      abort,
    );
    const row = records.get(created.id);
    if (!row) throw notFound('compute job run', created.id);
    return row;
  }

  get(projectKey: string, id: string): ComputeJobRunView {
    const run = this.deps.ctx.repos.computeJobRuns.get(id);
    if (!run || run.projectKey !== projectKey) throw notFound('compute job run', id);
    return run;
  }

  list(projectKey: string, input: ListComputeJobsInput = {}): ComputeJobRunView[] {
    const limit = Math.min(Math.max(1, input.limit ?? LIST_LIMIT_DEFAULT), LIST_LIMIT_MAX);
    return this.deps.ctx.repos.computeJobRuns.list(projectKey, {
      ...(input.repo !== undefined ? { repo: input.repo } : {}),
      ...(input.job !== undefined ? { job: input.job } : {}),
      limit,
    });
  }

  /** The owner's own authority passes; any other actor has to hold the deployment duty. */
  private requireAccess(config: ProjectConfig, actor: Actor): void {
    const owner = assertIntegratorAccess(config, 'write', actor);
    if (owner && delegatesOwnerAuthority()) return;
    if (!dutyMembers(config, 'deployment').some((member) => member.handle === actor.handle))
      throw forbidden('insufficient_access', 'only a member with the deployment duty may run a compute job');
  }

  private repoOf(config: ProjectConfig, name: string | undefined): RepoConfig {
    const { repos } = config.project;
    if (name === undefined) {
      if (repos.length === 1) return repos[0]!;
      throw invalid('invalid_request', 'repo is required when the project has several repositories');
    }
    const repo = repos.find((entry) => entry.name === name);
    if (!repo) throw invalid('invalid_request', `the project has no repository ${name}`);
    return repo;
  }

  private engineOf(projectKey: string): Engine {
    const id = this.deps.engines.projectEngine(projectKey);
    const engine = id ? this.deps.engines.get(id) : null;
    if (!engine?.merger || !engine.fullTestExecutor)
      throw conflict('engine_offline', 'the engine of the project is not connected');
    return engine as Engine;
  }

  /** The commit has to be on the remote default branch: the workflow runs nothing else. */
  private async requirePublished(
    engine: Engine,
    projectKey: string,
    repo: RepoConfig,
    commit: string,
  ): Promise<void> {
    let state: MergeBaseState;
    try {
      state = await engine.merger.prepare(
        { projectKey, repo: repo.name },
        { base: repo.defaultBranch, commit },
      );
    } catch (err) {
      if (isEngineLinkLost(err))
        throw conflict('engine_offline', 'the engine of the project is not connected');
      throw conflict(
        'compute_job_commit_unpublished',
        err instanceof Error ? err.message : 'the commit could not be checked',
      );
    }
    if (state.contains.remote !== true)
      throw conflict(
        'compute_job_commit_unpublished',
        `commit ${commit} is not on the remote ${repo.defaultBranch} of ${repo.name}`,
      );
  }

  private async execute(
    run: {
      engine: Engine;
      runId: string;
      projectKey: string;
      repo: RepoConfig;
      github: string;
      def: ComputeJobDefinition;
      commit: string;
    },
    abort: AbortController,
  ): Promise<void> {
    const { ctx } = this.deps;
    const { def, runId } = run;
    const spec: FullTestSpec = {
      runId,
      cwd: `github-job:${run.github}`,
      command: def.command,
      maxWorkers: 1,
      timeoutMs: (def.timeoutMinutes + RUN_SLACK_MINUTES) * 60_000,
      sandbox: { denyRead: [], allowRead: [] },
      githubJob: {
        ref: { projectKey: run.projectKey, repo: run.repo.name },
        repo: run.github,
        base: run.repo.defaultBranch,
        workflow: def.workflow ?? COMPUTE_JOB_WORKFLOW,
        job: def.id,
        commit: run.commit,
        command: def.command,
        runsOn: def.runsOn,
        outputs: def.outputs,
        ...(def.node !== undefined ? { node: def.node } : {}),
        timeoutMinutes: def.timeoutMinutes,
      },
    };
    let result: FullTestResult | null = null;
    let refusal: string | null = null;
    try {
      result = await run.engine.fullTestExecutor.run(spec, abort.signal, () =>
        ctx.repos.computeJobRuns.start(runId, isoNow(ctx)),
      );
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    } finally {
      this.running.delete(runId);
    }
    try {
      this.finish(run.projectKey, runId, result, refusal, abort.signal.aborted);
    } catch (err) {
      ctx.logger.error({ err, runId }, 'compute job: the run could not be recorded');
    }
  }

  private finish(
    projectKey: string,
    runId: string,
    result: FullTestResult | null,
    refusal: string | null,
    stopped: boolean,
  ): void {
    const { ctx } = this.deps;
    const records = ctx.repos.computeJobRuns;
    const finishedAt = isoNow(ctx);
    if (stopped && (result === null || result.outcome === 'error')) {
      records.finish(runId, { status: 'cancelled', reason: 'shutdown', finishedAt });
    } else if (result === null) {
      records.finish(runId, {
        status: 'error',
        reason: 'engine_refused',
        outputTail: clip(refusal ?? ''),
        finishedAt,
      });
    } else {
      const status =
        result.outcome === 'passed' ? 'succeeded' : result.outcome === 'failed' ? 'failed' : 'error';
      records.finish(runId, {
        status,
        reason: result.outcome === 'error' ? (result.reason ?? null) : null,
        durationMs: result.durationMs,
        queuedMs: result.cost?.queuedMs ?? null,
        billableMs: result.cost?.billableMs ?? null,
        externalUrl: result.externalUrl ?? null,
        outputTail: clip(result.outputTail),
        outputs: result.outputs ?? [],
        artifact: result.artifact ?? null,
        finishedAt,
      });
    }
    const row = records.get(runId);
    if (row?.taskKey) {
      this.deps.timeline.append({
        projectKey,
        taskKey: row.taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_note',
        data: { text: endNote(row), mentions: [] },
      });
    }
  }
}

/** A run still going, or one that succeeded and whose artifact can still be downloaded. */
function isLive(run: ComputeJobRunView, nowMs: number): boolean {
  if (run.status === 'queued' || run.status === 'running') return true;
  const expiresAt = run.artifact?.expiresAt;
  return run.status === 'succeeded' && expiresAt != null && Date.parse(expiresAt) > nowMs;
}

/** The system note of a run that ended. */
function endNote(run: ComputeJobRunView): string {
  const parts = [`Compute job ${run.job} on ${run.commit.slice(0, 12)} ended: ${run.status}`];
  if (run.reason) parts.push(`(${run.reason})`);
  if (run.durationMs !== null) parts.push(`in ${Math.round(run.durationMs / 1000)} s`);
  if (run.billableMs !== null) parts.push(`billable ${Math.round(run.billableMs / 1000)} s`);
  if (run.externalUrl) parts.push(run.externalUrl);
  return `${parts.join(' ')}. Run ${run.id}.`;
}
