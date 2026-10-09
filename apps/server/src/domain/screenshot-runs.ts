import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { TeamToolError } from '../contracts';
import type {
  ScreenshotExecutor,
  ScreenshotFailure,
  ScreenshotRun,
  ScreenshotRunEnded,
  ScreenshotRunStatus,
  ScreenshotScope,
  TakeScreenshotsInput,
  ToolContext,
} from '../contracts';
import { outputTail } from '../full-test/output';
import { isWithin } from './command-paths';
import type { SessionOrchestrator } from './sessions';
import { newId } from './util';

/** How long `take_screenshots` and `get_screenshot_run` wait for the end of a run (under Codex's 60 s tool limit). */
export const SCREENSHOT_POLL_MS = 40_000;
/** The longest a run takes once it is started (the wait in the machine's queue is not counted). */
export const SCREENSHOT_RUN_TIMEOUT_MS = 15 * 60_000;
/** An ended run is kept this long, and at most `KEPT_PER_SESSION` per session. */
const KEEP_MS = 60 * 60_000;
const KEPT_PER_SESSION = 5;
/** The most images named, the most directory entries looked at, and how deep. */
const FILES_LIMIT = 100;
const SCAN_LIMIT = 5_000;
const SCAN_DEPTH = 6;
const OUTPUT_TAIL_CHARS = 4_000;
const IMAGE = /\.(?:png|jpe?g)$/i;

/** The folder of the images below the session folder: `shots`'s default output. */
export const SHOTS_DIRECTORY = 'shots';

export interface ScreenshotRunsDeps {
  /** The executor of every session; `executorFor` takes precedence. */
  executor?: ScreenshotExecutor;
  /** The executor of the session's engine (PM-311); undefined: its engine has none. */
  executorFor?: (sessionId: string) => ScreenshotExecutor | undefined;
  sessions: Pick<SessionOrchestrator, 'screenshotScope'>;
  logger: FastifyBaseLogger;
  /** Default: this machine's platform (the sandbox is macOS only). */
  platform?: NodeJS.Platform;
  /** Default `SCREENSHOT_POLL_MS`. */
  pollMs?: number;
  /** Default `SCREENSHOT_RUN_TIMEOUT_MS`. */
  runTimeoutMs?: number;
  now?: () => number;
}

interface Run {
  id: string;
  sessionId: string;
  status: ScreenshotRunStatus;
  startedAt: number;
  startedAtIso: string;
  finishedAt?: number;
  finishedAtIso?: string;
  scope: ScreenshotScope;
  files: string[];
  exitCode?: number | null;
  failure?: ScreenshotFailure;
  output?: string;
  controller: AbortController;
  /** The run's end was decided; its status changes when its images are listed. */
  ending: boolean;
  /** The executor's call, settled when the process group is gone; absent until the run is launched. */
  executing?: Promise<void>;
  /** Resolved when the run is over. */
  over: Promise<void>;
  settle: () => void;
}

/**
 * The screenshots of the session members whose own sandbox cannot start Chromium (Codex, PM-351): the
 * server runs `npm run shots` in the session's worktree, in its own sandbox (`ScreenshotExecutor`), and
 * the images go to the session's folder. One run at a time per session; ended runs are kept in memory
 * for a while so the member can ask for them.
 */
export class ScreenshotRuns {
  private readonly runs = new Map<string, Run>();
  private readonly deps: ScreenshotRunsDeps;

  constructor(deps: ScreenshotRunsDeps) {
    this.deps = deps;
  }

  private executorOf(sessionId: string): ScreenshotExecutor | undefined {
    return this.deps.executorFor ? this.deps.executorFor(sessionId) : this.deps.executor;
  }

  /** Starts a run for the calling session and waits up to the poll time for its end. */
  async take(ctx: ToolContext, input: TakeScreenshotsInput): Promise<ScreenshotRun> {
    const platform = this.deps.platform ?? process.platform;
    if (platform !== 'darwin')
      throw new TeamToolError(
        'forbidden',
        `Screenshots by the server need macOS (this machine is ${platform}): its sandbox runs the browser.`,
      );
    const scope = this.deps.sessions.screenshotScope(ctx.sessionId);
    if (!scope)
      throw new TeamToolError(
        'forbidden',
        'Screenshots by the server are only for a session that works in a worktree and has a session folder of its own; yours has not.',
      );
    if (!this.executorOf(ctx.sessionId))
      throw new TeamToolError('forbidden', 'The engine this session runs on cannot take screenshots.');
    this.prune();
    const active = [...this.runs.values()].find(
      (run) => run.sessionId === ctx.sessionId && isActive(run.status),
    );
    if (active)
      throw new TeamToolError(
        'invalid',
        `A screenshot run of this session is still going: ${active.id}. Wait for it with get_screenshot_run.`,
      );
    // The run is registered before the first await, so a parallel call of the session sees it as active.
    const run = this.register(ctx, scope);
    let scenario: string;
    try {
      scenario = await scenarioPath(scope, input.scenario);
    } catch (err) {
      this.runs.delete(run.id);
      run.ending = true;
      run.settle();
      throw err;
    }
    // The session ended while the scenario was checked: the run is already over.
    if (!run.ending) this.launch(ctx, run, [scenario, ...screenshotArgs(input)]);
    await this.waitFor(run);
    return view(run);
  }

  /** A run of the calling session; waits up to the poll time when it is not over. */
  async get(ctx: ToolContext, runId: string): Promise<ScreenshotRun> {
    this.prune();
    const run = this.runs.get(runId);
    if (!run || run.sessionId !== ctx.sessionId)
      throw new TeamToolError('not_found', `This session has no screenshot run ${runId}.`);
    await this.waitFor(run);
    return view(run);
  }

  /** The session ended: its running run stops (the process group is stopped) before its folder goes. */
  stopSession(sessionId: string): void {
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId || !isActive(run.status)) continue;
      run.controller.abort();
      this.finish(run, { failure: 'stopped', exitCode: null, output: '' });
    }
  }

  /**
   * The server stops: every run stops, and the executors are waited for, so the run directories
   * and the heavy-run lock are released before the server goes.
   */
  async stop(): Promise<void> {
    for (const sessionId of new Set([...this.runs.values()].map((run) => run.sessionId)))
      this.stopSession(sessionId);
    await Promise.all([...this.runs.values()].map((run) => run.executing));
  }

  private register(ctx: ToolContext, scope: ScreenshotScope): Run {
    const now = this.now();
    let settle = (): void => undefined;
    const over = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const run: Run = {
      id: newId('shr'),
      sessionId: ctx.sessionId,
      status: 'queued',
      startedAt: now,
      startedAtIso: new Date(now).toISOString(),
      scope,
      files: [],
      controller: new AbortController(),
      ending: false,
      over,
      settle,
    };
    this.runs.set(run.id, run);
    return run;
  }

  private launch(ctx: ToolContext, run: Run, args: string[]): void {
    const scope = run.scope;
    const label = `shots ${ctx.taskKey ?? ctx.sessionId} ${ctx.member}`;
    run.executing = this.executorOf(ctx.sessionId)!
      .run(
        {
          runId: run.id,
          cwd: scope.cwd,
          sessionDir: scope.sessionDir,
          ...(scope.browsersDir ? { browsersDir: scope.browsersDir } : {}),
          args,
          sandbox: scope.sandbox,
          label,
          timeoutMs: this.deps.runTimeoutMs ?? SCREENSHOT_RUN_TIMEOUT_MS,
        },
        run.controller.signal,
        () => {
          if (run.status === 'queued') run.status = 'running';
        },
      )
      .then(
        (ended) => this.finish(run, outcomeOf(ended)),
        (err: unknown) => {
          this.deps.logger.warn({ err, runId: run.id }, 'a screenshot run failed');
          this.finish(run, {
            failure: 'sandbox',
            exitCode: null,
            output: err instanceof Error ? err.message : String(err),
          });
        },
      );
  }

  /**
   * Ends the run once. The images are listed first, so a run seen as over has its files; the waiting
   * calls go on then.
   */
  private finish(
    run: Run,
    result: { failure?: ScreenshotFailure; exitCode: number | null; output: string },
  ): void {
    if (run.ending) return;
    run.ending = true;
    const settle = (): void => {
      const at = this.now();
      run.finishedAt = at;
      run.finishedAtIso = new Date(at).toISOString();
      run.exitCode = result.exitCode;
      run.output = outputTail(result.output, OUTPUT_TAIL_CHARS);
      if (result.failure) run.failure = result.failure;
      run.status = result.failure ? 'failed' : 'done';
      run.settle();
    };
    // A stopped run's folder is going away: nothing to list.
    if (result.failure === 'stopped') {
      settle();
      return;
    }
    void listImages(path.join(run.scope.sessionDir, SHOTS_DIRECTORY), run.startedAt)
      .then((files) => {
        run.files = files;
      })
      .catch((err: unknown) =>
        this.deps.logger.warn({ err, runId: run.id }, 'could not list the images of a screenshot run'),
      )
      .finally(settle);
  }

  private async waitFor(run: Run): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const poll = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.deps.pollMs ?? SCREENSHOT_POLL_MS);
    });
    try {
      await Promise.race([run.over, poll]);
    } finally {
      clearTimeout(timer);
    }
  }

  private prune(): void {
    const now = this.now();
    const bySession = new Map<string, Run[]>();
    for (const run of this.runs.values()) {
      if (isActive(run.status)) continue;
      if (now - (run.finishedAt ?? run.startedAt) > KEEP_MS) {
        this.runs.delete(run.id);
        continue;
      }
      bySession.set(run.sessionId, [...(bySession.get(run.sessionId) ?? []), run]);
    }
    for (const ended of bySession.values()) {
      ended
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
        .slice(KEPT_PER_SESSION)
        .forEach((run) => this.runs.delete(run.id));
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

const isActive = (status: ScreenshotRunStatus): boolean => status === 'queued' || status === 'running';

/** The failure an end means, per the exit codes of `npm run shots`: 1 the scenario, 2 wrong use or no browser. */
function outcomeOf(ended: ScreenshotRunEnded): {
  failure?: ScreenshotFailure;
  exitCode: number | null;
  output: string;
} {
  const { exitCode, output } = ended;
  if (ended.aborted) return { failure: 'stopped', exitCode, output };
  if (ended.spawnError) return { failure: 'sandbox', exitCode, output: output || ended.spawnError };
  if (ended.timedOut) return { failure: 'timeout', exitCode, output };
  if (exitCode === 0) return { exitCode, output };
  if (exitCode === 2) return { failure: 'usage', exitCode, output };
  // Killed by a signal from outside: the sandbox or its process went away.
  if (exitCode === null) return { failure: 'sandbox', exitCode, output };
  return { failure: 'scenario', exitCode, output };
}

function view(run: Run): ScreenshotRun {
  return {
    runId: run.id,
    status: run.status,
    startedAt: run.startedAtIso,
    ...(run.finishedAtIso ? { finishedAt: run.finishedAtIso } : {}),
    files: run.files,
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.failure ? { failure: run.failure } : {}),
    ...(run.output ? { outputTail: run.output } : {}),
  };
}

/**
 * The arguments after the scenario, built from the validated fields only: no free text from the agent,
 * and never `--out`, `--keep-data` or `--machine`.
 */
export function screenshotArgs(input: Omit<TakeScreenshotsInput, 'scenario'>): string[] {
  const args: string[] = [];
  if (input.widths?.length) args.push('--widths', input.widths.join(','));
  if (input.fullPage) args.push('--full-page');
  if (input.scale !== undefined) args.push('--scale', String(input.scale));
  if (input.timeoutSeconds !== undefined) args.push('--timeout', String(input.timeoutSeconds));
  if (input.seed !== undefined) args.push('--seed', input.seed);
  return args;
}

/**
 * The scenario's real path: it exists, is a file, and lies in the session's working directory or its
 * own folder after links are resolved. The run gets this path, not the one the agent wrote.
 */
export async function scenarioPath(scope: ScreenshotScope, requested: string): Promise<string> {
  const refuse = (why: string): never => {
    throw new TeamToolError('invalid', `The scenario ${requested} ${why}`);
  };
  let real: string;
  try {
    real = await realpath(path.resolve(scope.cwd, requested));
  } catch {
    return refuse('does not exist.');
  }
  const roots = await Promise.all(
    [scope.cwd, scope.sessionDir].map((root) => realpath(root).catch(() => root)),
  );
  if (!roots.some((root) => isWithin(root, real)))
    return refuse('is outside your working directory and your session folder.');
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) return refuse('is not a file.');
  return real;
}

/** The images below `dir` (`.png`, `.jpg`, `.jpeg`) written at or after `since` (ms), absolute, sorted. */
export async function listImages(dir: string, since: number): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++seen > SCAN_LIMIT) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < SCAN_DEPTH) await walk(full, depth + 1);
      } else if (entry.isFile() && IMAGE.test(entry.name)) {
        const info = await lstat(full).catch(() => null);
        // Whole milliseconds: a file written in the same millisecond the run started counts.
        if (info && Math.floor(info.mtimeMs) >= Math.floor(since)) found.push(full);
      }
    }
  };
  await walk(dir, 0);
  return found.sort().slice(0, FILES_LIMIT);
}
