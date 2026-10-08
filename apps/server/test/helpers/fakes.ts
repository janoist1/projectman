import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { ChatItem, HandoffSummary, PlanUsage, SessionState, ProjectConfig } from '@projectman/shared';
import type {
  ContextPack,
  ContextPackBuilder,
  ContextPackInput,
  GithubService,
  McpModule,
  McpModuleOptions,
  MemberMemoryStore,
  PauseOptions,
  PauseOutcome,
  PermissionBroker,
  PullRequestInfo,
  RunnerEvent,
  RunnerModule,
  RunnerModuleOptions,
  RunningSessionInfo,
  SessionRunner,
  StartSessionSpec,
  TranscriptReader,
  SourceHead,
  WorktreeInfo,
  WorktreeManager,
} from '../../src/contracts';
import { cheapSubagent } from '../../src/context';

/** In-memory SessionRunner: records calls; tests drive state with emit()/setState(). */
export class FakeRunner implements SessionRunner {
  readonly started: StartSessionSpec[] = [];
  readonly messages: Array<{ sessionId: string; text: string }> = [];
  readonly stopped: string[] = [];
  readonly input: Array<{ sessionId: string; data: string }> = [];
  readonly resized: Array<{ sessionId: string; cols: number; rows: number }> = [];
  failNextStart: Error | null = null;
  /**
   * The first input of a started session is not reported as typed (`first_input_sent`): the test
   * sends it, or ends the session, itself (PM-189).
   */
  holdFirstInput = false;
  /**
   * A started session reports `idle` at once, as a real one does when its CLI can take input and the
   * first input has not been typed yet (the runner's first `session_start` signal).
   */
  idleOnStart = false;
  /** Sessions with a message still on its way in (`hasPendingInput`). */
  readonly pendingInput = new Set<string>();
  private readonly running = new Map<string, RunningSessionInfo>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();

  async start(spec: StartSessionSpec): Promise<RunningSessionInfo> {
    if (this.failNextStart) {
      const err = this.failNextStart;
      this.failNextStart = null;
      throw err;
    }
    this.started.push(spec);
    const info: RunningSessionInfo = {
      sessionId: spec.sessionId,
      pid: 1000 + this.started.length,
      state: 'starting',
      cols: spec.cols ?? 120,
      rows: spec.rows ?? 40,
    };
    this.running.set(spec.sessionId, info);
    // The first input reaches the process at once, unless a test holds it back (`holdFirstInput`).
    if (spec.initialMessage?.trim() && !this.holdFirstInput) {
      this.emit({ type: 'first_input_sent', sessionId: spec.sessionId });
    }
    if (this.idleOnStart) queueMicrotask(() => this.setState(spec.sessionId, 'idle'));
    return info;
  }

  async sendUserMessage(sessionId: string, text: string): Promise<void> {
    this.messages.push({ sessionId, text });
  }

  /** The compactions asked for (PM-213), and whether the next one is taken (`false`: the runner refuses). */
  readonly compactions: Array<{ sessionId: string; instruction: string }> = [];
  compactTaken = true;
  async compact(sessionId: string, instruction: string): Promise<boolean> {
    if (!this.compactTaken || !this.running.has(sessionId)) return false;
    this.compactions.push({ sessionId, instruction });
    return true;
  }

  /**
   * The pauses asked for (PM-218). `pause` and `forcePause` resolve with `pauseOutcomes` (default: stopped
   * idle); `release` always succeeds.
   */
  readonly pauses: Array<{ sessionId: string; opts: PauseOptions | undefined }> = [];
  readonly forcePauses: string[] = [];
  readonly releases: Array<{ sessionId: string; nudge: string | undefined }> = [];
  readonly pauseOutcomes = new Map<string, PauseOutcome | null>();
  async pause(sessionId: string, opts?: PauseOptions): Promise<PauseOutcome | null> {
    this.pauses.push({ sessionId, opts });
    return this.pauseOutcome(sessionId);
  }
  async forcePause(sessionId: string): Promise<PauseOutcome | null> {
    this.forcePauses.push(sessionId);
    return this.pauseOutcome(sessionId);
  }
  release(sessionId: string, opts?: { nudge?: string }): boolean {
    this.releases.push({ sessionId, nudge: opts?.nudge });
    return true;
  }
  private pauseOutcome(sessionId: string): PauseOutcome | null {
    const outcome = this.pauseOutcomes.get(sessionId);
    return outcome === undefined ? { point: 'idle', tool: null } : outcome;
  }

  hasPendingInput(sessionId: string): boolean {
    return this.pendingInput.has(sessionId);
  }

  writeTerminal(sessionId: string, data: string): void {
    this.input.push({ sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.resized.push({ sessionId, cols, rows });
  }

  snapshot(sessionId: string): { data: string; cols: number; rows: number } | null {
    return this.running.has(sessionId) ? { data: `screen of ${sessionId}`, cols: 120, rows: 40 } : null;
  }

  async stop(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
    if (this.running.has(sessionId)) this.emit({ type: 'exit', sessionId, exitCode: 0, signal: null });
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  list(): RunningSessionInfo[] {
    return [...this.running.values()];
  }

  onEvent(listener: (event: RunnerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.running.keys()]) await this.stop(id);
  }

  emit(event: RunnerEvent): void {
    if (event.type === 'exit') this.running.delete(event.sessionId);
    for (const listener of [...this.listeners]) listener(event);
  }

  setState(sessionId: string, state: SessionState, activity: string | null = null): void {
    this.emit({ type: 'state', sessionId, state, activity });
  }

  lastStarted(): StartSessionSpec {
    const spec = this.started[this.started.length - 1];
    if (!spec) throw new Error('no session was started');
    return spec;
  }
}

export interface FakeRunnerModule {
  runner: FakeRunner;
  transcripts: Map<string, ChatItem[]>;
  /** Transcript paths whose file does not exist or is empty; every other path counts as written. */
  emptyTranscripts: Set<string>;
  /** Every transcript read, with its options. */
  transcriptReads: Array<{ path: string; opts: Parameters<TranscriptReader['read']>[1] }>;
  /** The summary `summary` gives for a transcript path (PM-342); null for every other path. */
  summaries: Map<string, HandoffSummary | null>;
  /** Every summary read, with its options. */
  summaryReads: Array<{ path: string; opts: Parameters<TranscriptReader['summary']>[1] }>;
  planUsage: { value: PlanUsage | null; calls: number };
  /** The broker the domain handed to the runner. */
  broker(): PermissionBroker;
  options(): RunnerModuleOptions | null;
  /** Use as createRunnerModule (buildApp) ... */
  create(opts: RunnerModuleOptions): RunnerModule;
  /** ... or as createRunner (createDomain). */
  createWithBroker(broker: PermissionBroker): RunnerModule;
}

export function createFakeRunnerModule(): FakeRunnerModule {
  const runner = new FakeRunner();
  const transcripts = new Map<string, ChatItem[]>();
  const transcriptReads: FakeRunnerModule['transcriptReads'] = [];
  const emptyTranscripts = new Set<string>();
  const summaries = new Map<string, HandoffSummary | null>();
  const summaryReads: FakeRunnerModule['summaryReads'] = [];
  const planUsage = { value: null as PlanUsage | null, calls: 0 };
  let broker: PermissionBroker | null = null;
  let options: RunnerModuleOptions | null = null;
  const module: RunnerModule = {
    runner,
    transcripts: {
      async hasContent(path) {
        return !emptyTranscripts.has(path);
      },
      async read(path, opts) {
        transcriptReads.push({ path, opts });
        const items = transcripts.get(path);
        if (!items) throw new Error(`no transcript at ${path}`);
        return items;
      },
      async summary(path, opts) {
        summaryReads.push({ path, opts });
        return summaries.get(path) ?? null;
      },
    },
    planUsage: {
      async get() {
        planUsage.calls += 1;
        return planUsage.value;
      },
    },
    planUsageFor: () => ({
      async get() {
        planUsage.calls += 1;
        return planUsage.value;
      },
    }),
    registerHookRoutes() {},
  };
  return {
    runner,
    transcripts,
    emptyTranscripts,
    transcriptReads,
    summaries,
    summaryReads,
    planUsage,
    broker() {
      if (!broker) throw new Error('runner module was not created yet');
      return broker;
    },
    options: () => options,
    create(opts) {
      options = opts;
      broker = opts.broker;
      return module;
    },
    createWithBroker(b) {
      broker = b;
      return module;
    },
  };
}

export class FakeContextBuilder implements ContextPackBuilder {
  readonly inputs: ContextPackInput[] = [];
  /** Off by default (sessions are never compacted); a test of the compaction sets it (PM-213). */
  compactInstruction: string | undefined = undefined;
  /** A short, recognisable text: `Nudge <point>[ restarted]`. */
  pauseNudge(input: { point: string; tool: string | null; restarted: boolean }): string {
    return `Nudge ${input.point}${input.restarted ? ' restarted' : ''}`;
  }
  handoffInstruction(input: { taskKey: string; to: string | null }): string {
    return `Hand off ${input.taskKey} to ${input.to ?? 'nobody'}`;
  }
  handoffCancelled(input: { taskKey: string }): string {
    return `Handoff of ${input.taskKey} cancelled`;
  }
  build(input: ContextPackInput): ContextPack {
    this.inputs.push(input);
    return {
      appendSystemPrompt: `You are ${input.member.handle}. Memory: ${input.memory}`,
      initialMessage:
        input.workItem.type === 'schedule'
          ? (input.member.schedule?.prompt ?? null)
          : input.task
            ? `Brief for ${input.task.key}: ${input.task.title}`
            : null,
      continueMessage:
        input.workItem.type === 'task' && input.task
          ? `Continue ${input.task.key}: ${input.task.title}`
          : null,
      // A short, recognisable text when the card has other workers or questions (PM-249).
      standing:
        input.task && (input.cardWorkers?.length || input.cardQuestions?.length)
          ? `Standing ${input.task.key}: workers ${(input.cardWorkers ?? []).map((w) => w.handle).join(',')}; questions ${(input.cardQuestions ?? []).length}`
          : null,
      // The real definition: the session start passes it on as it is.
      subagents: [cheapSubagent(input.member)].filter((agent) => agent !== null),
    };
  }
}

export class FakeMemoryStore implements MemberMemoryStore {
  readonly notes = new Map<string, string>();
  async read(projectKey: string, handle: string): Promise<string> {
    return this.notes.get(`${projectKey}/${handle}`) ?? '';
  }
  async append(projectKey: string, handle: string, note: string): Promise<void> {
    const key = `${projectKey}/${handle}`;
    this.notes.set(key, `${this.notes.get(key) ?? ''}- ${note}\n`);
  }
}

export class FakeWorktreeManager implements WorktreeManager {
  async refreshDependencies() {
    return { status: 'skipped', reason: 'not_worktree' } as const;
  }
  readonly calls: Array<{ repoName: string; taskKey: string }> = [];
  readonly removed: string[] = [];
  readonly existing = new Map<string, WorktreeInfo>();
  /** Status per worktree path (default: clean). */
  readonly statuses = new Map<string, { dirty: boolean; unpushedCommits: number }>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async ensureForTask(args: {
    project: ProjectConfig;
    repoName: string;
    taskKey: string;
    title: string;
  }): Promise<WorktreeInfo> {
    this.calls.push({ repoName: args.repoName, taskKey: args.taskKey });
    const path = join(this.root, args.project.project.key, `${args.taskKey}-${args.repoName}`);
    mkdirSync(path, { recursive: true });
    const repo = args.project.project.repos.find((repo) => repo.name === args.repoName)!;
    const info = {
      path,
      branch: `task/${args.taskKey}`,
      repo: args.repoName,
      gitDir: join(args.project.project.workspacePath, repo.path, '.git'),
    };
    this.existing.set(`${args.project.project.key}/${args.taskKey}/${args.repoName}`, info);
    return info;
  }
  async find(args: {
    project: ProjectConfig;
    repoName: string;
    taskKey: string;
  }): Promise<WorktreeInfo | null> {
    return this.existing.get(`${args.project.project.key}/${args.taskKey}/${args.repoName}`) ?? null;
  }
  async status(path: string): Promise<{ dirty: boolean; unpushedCommits: number }> {
    return this.statuses.get(path) ?? { dirty: false, unpushedCommits: 0 };
  }
  /** Head per worktree path; none by default (a worktree with no commit to hand over). */
  readonly heads = new Map<string, SourceHead>();
  async head(path: string): Promise<SourceHead | null> {
    return this.heads.get(path) ?? null;
  }
  async remove(args: { path: string; force?: boolean }): Promise<void> {
    this.removed.push(args.path);
  }
}

export function pullRequest(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    repo: 'acme/web',
    number: 7,
    title: 'Add login page',
    url: 'https://github.com/acme/web/pull/7',
    state: 'open',
    draft: false,
    headRef: 'task/AR-1',
    baseRef: 'main',
    checks: 'success',
    reviewDecision: null,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    updatedAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

export class FakeGithub implements GithubService {
  readonly prs = new Map<string, PullRequestInfo>();
  readonly watchers: Array<{
    targets: Array<{ repo: string; number: number }>;
    onChange: (pr: PullRequestInfo) => void;
    active: boolean;
  }> = [];
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    const pr = this.prs.get(`${repo}#${number}`);
    if (!pr) throw new Error(`no such pull request ${repo}#${number}`);
    return pr;
  }
  async findPullRequestsForBranch(): Promise<PullRequestInfo[]> {
    return [];
  }
  parsePullRequestUrl(): { repo: string; number: number } | null {
    return null;
  }
  watch(
    targets: Array<{ repo: string; number: number }>,
    onChange: (pr: PullRequestInfo) => void,
  ): () => void {
    const watcher = { targets, onChange, active: true };
    this.watchers.push(watcher);
    return () => {
      watcher.active = false;
    };
  }
  isWatched(repo: string, number: number): boolean {
    return this.watchers.some(
      (w) => w.active && w.targets.some((t) => t.repo === repo && t.number === number),
    );
  }
  /** Simulates a poll that noticed a change. */
  emit(pr: PullRequestInfo): void {
    this.prs.set(`${pr.repo}#${pr.number}`, pr);
    for (const w of [...this.watchers]) {
      if (w.active && w.targets.some((t) => t.repo === pr.repo && t.number === pr.number)) w.onChange(pr);
    }
  }
}

export interface FakeMcp {
  options(): McpModuleOptions;
  create(opts: McpModuleOptions): McpModule;
}

export function createFakeMcp(): FakeMcp {
  let options: McpModuleOptions | null = null;
  return {
    options() {
      if (!options) throw new Error('mcp module was not created yet');
      return options;
    },
    create(opts) {
      options = opts;
      return { registerRoutes() {} };
    },
  };
}

export interface CapturingLogger {
  logger: FastifyBaseLogger;
  errors: unknown[];
  warnings: unknown[];
}

/** A logger that stays quiet but keeps errors and warnings for assertions. */
export function capturingLogger(): CapturingLogger {
  const errors: unknown[] = [];
  const warnings: unknown[] = [];
  const noop = () => undefined;
  const logger = {
    level: 'info',
    fatal: (...args: unknown[]) => errors.push(args),
    error: (...args: unknown[]) => errors.push(args),
    warn: (...args: unknown[]) => warnings.push(args),
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => logger,
  };
  return { logger: logger as unknown as FastifyBaseLogger, errors, warnings };
}

/** A plan usage probe result: `percent` of the five-hour window used. */
export function planUsage(percent: number, overrides: Partial<PlanUsage> = {}): PlanUsage {
  return {
    fiveHourPercent: percent,
    weeklyPercent: null,
    fiveHourResetsAt: null,
    weeklyResetsAt: null,
    fetchedAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}

/** Lets pending promise callbacks (background deliveries) run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Lets zero-delay timers and the work they start run. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await flush();
}
