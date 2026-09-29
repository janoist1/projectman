import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { ChatItem, PlanUsage, SessionState } from '@projectman/shared';
import type {
  ContextPack,
  ContextPackBuilder,
  ContextPackInput,
  GithubService,
  McpModule,
  McpModuleOptions,
  MemberMemoryStore,
  PermissionBroker,
  PullRequestInfo,
  RunnerEvent,
  RunnerModule,
  RunnerModuleOptions,
  RunningSessionInfo,
  SessionRunner,
  StartSessionSpec,
  WorktreeInfo,
  WorktreeManager,
} from '../../src/contracts';

/** In-memory SessionRunner: records calls; tests drive state with emit()/setState(). */
export class FakeRunner implements SessionRunner {
  readonly started: StartSessionSpec[] = [];
  readonly messages: Array<{ sessionId: string; text: string }> = [];
  readonly stopped: string[] = [];
  readonly input: Array<{ sessionId: string; data: string }> = [];
  readonly resized: Array<{ sessionId: string; cols: number; rows: number }> = [];
  failNextStart: Error | null = null;
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
    return info;
  }

  async sendUserMessage(sessionId: string, text: string): Promise<void> {
    this.messages.push({ sessionId, text });
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
  const planUsage = { value: null as PlanUsage | null, calls: 0 };
  let broker: PermissionBroker | null = null;
  let options: RunnerModuleOptions | null = null;
  const module: RunnerModule = {
    runner,
    transcripts: {
      async read(path: string) {
        const items = transcripts.get(path);
        if (!items) throw new Error(`no transcript at ${path}`);
        return items;
      },
    },
    planUsage: {
      async get() {
        planUsage.calls += 1;
        return planUsage.value;
      },
    },
    registerHookRoutes() {},
  };
  return {
    runner,
    transcripts,
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
  build(input: ContextPackInput): ContextPack {
    this.inputs.push(input);
    return {
      appendSystemPrompt: `You are ${input.member.handle}. Memory: ${input.memory}`,
      initialMessage: input.task ? `Brief for ${input.task.key}: ${input.task.title}` : null,
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
  readonly calls: Array<{ repoName: string; taskKey: string }> = [];
  readonly removed: string[] = [];
  /** Status per worktree path (default: clean). */
  readonly statuses = new Map<string, { dirty: boolean; unpushedCommits: number }>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async ensureForTask(args: {
    project: { project: { key: string } };
    repoName: string;
    taskKey: string;
    title: string;
  }): Promise<WorktreeInfo> {
    this.calls.push({ repoName: args.repoName, taskKey: args.taskKey });
    const path = join(this.root, args.project.project.key, args.taskKey);
    mkdirSync(path, { recursive: true });
    return { path, branch: `task/${args.taskKey}`, repo: args.repoName };
  }
  async status(path: string): Promise<{ dirty: boolean; unpushedCommits: number }> {
    return this.statuses.get(path) ?? { dirty: false, unpushedCommits: 0 };
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

/** Lets pending promise callbacks (background deliveries) run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Lets zero-delay timers and the work they start run. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await flush();
}
