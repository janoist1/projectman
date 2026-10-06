import { describe, expect, it, vi } from 'vitest';
import type {
  AgentProvider,
  AiMemberConfig,
  PlanUsage,
  ProjectConfig,
  Session,
  Task,
  WorkItemRef,
} from '@projectman/shared';
import { createRepositories, openDatabase } from '../src/db';
import { Admission, conflict, DeferredStarts, DomainError } from '../src/domain';
import { isDeferrable } from '../src/domain/admission';
import type { AutomaticStart, DomainContext, SessionOrchestrator, TaskService } from '../src/domain';
import { capturingLogger, planUsage } from './helpers/fakes';
import { testConfig } from './helpers/test-template';

const AT = '2026-09-30T10:00:00.000Z';

function task(key: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `tsk_${key}`,
    projectKey: 'AR',
    key,
    parentKey: null,
    title: `Fictional ${key}`,
    description: '',
    stageId: 'development',
    status: 'active',
    assignee: null,
    repo: null,
    priority: null,
    labels: [],
    links: [],
    visibility: 'internal',
    createdBy: 'owner',
    createdAt: AT,
    updatedAt: AT,
    closedAt: null,
    ...overrides,
  };
}

function session(member: string, workItem: WorkItemRef, id = `ses_${member}_${workItem.type}`): Session {
  return {
    id,
    projectKey: 'AR',
    member,
    workItem,
    claudeSessionId: '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11',
    provider: 'claude',
    cwd: '/tmp/acme',
    branch: null,
    transcriptPath: null,
    state: 'idle',
    activity: null,
    startedAt: AT,
    lastActivityAt: AT,
    endedAt: null,
  };
}

interface World {
  tasks?: Task[];
  sessions?: Session[];
  running?: string[];
  /** Running sessions whose first turn has not begun (their CLI may report idle meanwhile). */
  awaitingFirstTurn?: string[];
  busy?: number;
  usage?: Partial<Record<AgentProvider, PlanUsage | null>>;
  adjust?: (config: ProjectConfig) => void;
  /** The deferred starts are kept in SQLite too (an in-memory database). */
  persist?: boolean;
  /** The project's configuration cannot be loaded. */
  configFails?: boolean;
  /** The providers whose CLI is not logged in. */
  loggedOut?: AgentProvider[];
}

/** Admission over an in-memory world: tasks, sessions, running processes and plan usage. */
function admissionFor(world: World = {}) {
  const tasks = new Map((world.tasks ?? []).map((t) => [t.key, t]));
  const sessions = world.sessions ?? [];
  const running = new Set(world.running ?? []);
  const usageRequests: AgentProvider[] = [];
  const published: string[] = [];
  const log = capturingLogger();
  const ctx = {
    repos: {
      pauses: { open: () => [] },
      tasks: {
        get: (key: string) => tasks.get(key) ?? null,
        listByAssignee: (_projectKey: string, handle: string) =>
          [...tasks.values()].filter((t) => t.assignee === handle),
      },
    },
    logger: log.logger,
    now: () => new Date(AT),
  } as unknown as DomainContext;
  const sessionFake = {
    list: (_projectKey: string, filter: { member?: string } = {}) =>
      sessions.filter((s) => !filter.member || s.member === filter.member),
    isRunning: (id: string) => running.has(id),
    awaitsFirstTurn: (id: string) => (world.awaitingFirstTurn ?? []).includes(id),
    busyCount: () => world.busy ?? 0,
    // No member workspaces in this world: nothing holds one.
    assertWorkspaceFree: () => undefined,
    assertProviderReady: async (provider: AgentProvider) => {
      if (world.loggedOut?.includes(provider))
        throw conflict('provider_not_logged_in', `${provider} is not logged in`, { provider });
    },
    assertProviderCooldown: () => undefined,
    findRunning: (_projectKey: string, member: string, workItem: WorkItemRef) =>
      sessions.find(
        (s) =>
          s.member === member && JSON.stringify(s.workItem) === JSON.stringify(workItem) && running.has(s.id),
      ) ?? null,
    ensureSession: vi.fn(async (_projectKey: string, member: string, workItem: WorkItemRef) => ({
      session: session(member, workItem, 'ses_new'),
      created: true,
      resumed: false,
      started: true,
      messagesSent: 0,
      firstInput: Promise.resolve(true),
    })),
  };
  const config = testConfig();
  world.adjust?.(config);
  const store = createRepositories(openDatabase(':memory:')).deferredStarts;
  const deferred = new DeferredStarts(world.persist ? store : undefined);
  const admission = new Admission({
    ctx,
    sessions: sessionFake as unknown as SessionOrchestrator,
    planUsage: {
      get: async (provider: AgentProvider = 'claude') => {
        usageRequests.push(provider);
        return world.usage?.[provider] ?? null;
      },
    },
    tasks: { publish: (t: Task) => published.push(t.key) } as unknown as TaskService,
    projects: {
      config: async () => {
        if (world.configFails) throw new Error('fictional: no configuration');
        return config;
      },
    },
    deferred,
  });
  const member = (handle: string) => config.team.members.find((m) => m.handle === handle) as AiMemberConfig;
  return { admission, deferred, store, config, member, usageRequests, published, tasks, sessionFake, log };
}

const refusal = async (promise: Promise<unknown>): Promise<string | null> =>
  promise.then(
    () => null,
    (err: unknown) => (err instanceof DomainError ? err.code : String(err)),
  );

const general: WorkItemRef = { type: 'general' };
const scheduled: WorkItemRef = { type: 'schedule', runId: 'run_fictional' };
const onTask = (taskKey: string): WorkItemRef => ({ type: 'task', taskKey });
/** Sends the AI member on leave. */
const sendOnLeave =
  (handle: string) =>
  (config: ProjectConfig): void => {
    const member = config.team.members.find((m) => m.handle === handle);
    if (member?.kind === 'ai') member.onLeave = true;
  };
/** A second repository: the project then has several, and a task has to name the one it works in. */
const withTwoRepos = (config: ProjectConfig): void => {
  config.project.repos.push({ name: 'api', path: 'api', defaultBranch: 'main' });
};

describe('admission checks', () => {
  it.each<[string, World, { handle?: string; workItem?: WorkItemRef; capacity?: boolean }, string | null]>([
    ['admits a free member', {}, { handle: 'dev-1', workItem: general }, null],
    [
      'checks the master switch before everything else',
      {
        adjust: (c) => void (c.team.limits.aiEnabled = false),
        tasks: [task('AR-1', { assignee: 'dev-1' })],
        busy: 9,
        usage: { claude: planUsage(99) },
      },
      { handle: 'dev-1', workItem: general },
      'ai_disabled',
    ],
    [
      'refuses a member on leave before capacity, the AI limit and plan usage (decision 23)',
      {
        adjust: sendOnLeave('dev-1'),
        tasks: [task('AR-1', { assignee: 'dev-1' })],
        sessions: [session('dev-1', onTask('AR-1'))],
        running: ['ses_dev-1_task'],
        busy: 9,
        usage: { claude: planUsage(99) },
      },
      { handle: 'dev-1', workItem: general },
      'member_on_leave',
    ],
    [
      'refuses every kind of start for a member on leave',
      { adjust: sendOnLeave('dev-1') },
      { handle: 'dev-1', workItem: scheduled },
      'member_on_leave',
    ],
    [
      'refuses a start for a member on leave even where capacity does not apply',
      { adjust: sendOnLeave('dev-1'), tasks: [task('AR-1', { assignee: 'dev-1' })] },
      { handle: 'dev-1', workItem: onTask('AR-1'), capacity: false },
      'member_on_leave',
    ],
    [
      'admits the others while one member is on leave',
      { adjust: sendOnLeave('dev-1') },
      { handle: 'dev-2' },
      null,
    ],
    [
      'admits a member called back from leave',
      {
        adjust: (config) => {
          sendOnLeave('dev-1')(config);
          const dev = config.team.members.find((m) => m.handle === 'dev-1');
          if (dev?.kind === 'ai') delete dev.onLeave;
        },
      },
      { handle: 'dev-1', workItem: general },
      null,
    ],
    [
      "refuses a scheduled run while the member's previous run is live",
      {
        sessions: [session('dev-1', { type: 'schedule', runId: 'run_earlier' })],
        running: ['ses_dev-1_schedule'],
        tasks: [task('AR-1', { assignee: 'dev-1' })],
      },
      { handle: 'dev-1', workItem: scheduled },
      'previous_run_live',
    ],
    [
      'lets a scheduled run start after the previous one ended',
      { sessions: [session('dev-1', { type: 'schedule', runId: 'run_earlier' })] },
      { handle: 'dev-1', workItem: scheduled },
      null,
    ],
    [
      'counts the open tasks a member has a running session for against its capacity',
      {
        tasks: [task('AR-1', { assignee: 'dev-1' })],
        sessions: [session('dev-1', onTask('AR-1'))],
        running: ['ses_dev-1_task'],
      },
      { handle: 'dev-1', workItem: general },
      'member_at_capacity',
    ],
    [
      'does not count an idle session on a task that moved on to the next stage',
      {
        tasks: [task('AR-1', { assignee: 'dev-1', stageId: 'code_review' })],
        sessions: [session('dev-1', onTask('AR-1'))],
        running: ['ses_dev-1_task'],
      },
      { handle: 'dev-1', workItem: general },
      null,
    ],
    [
      'counts an idle session on a task that moved on while its first turn has not begun (PM-242)',
      {
        tasks: [task('AR-1', { assignee: 'dev-1', stageId: 'code_review' })],
        sessions: [session('dev-1', onTask('AR-1'))],
        running: ['ses_dev-1_task'],
        awaitingFirstTurn: ['ses_dev-1_task'],
      },
      { handle: 'dev-1', workItem: general },
      'member_at_capacity',
    ],
    [
      'counts a session with a turn in progress wherever the task is',
      {
        tasks: [task('AR-1', { assignee: 'dev-1', stageId: 'code_review' })],
        sessions: [{ ...session('dev-1', onTask('AR-1')), state: 'working' }],
        running: ['ses_dev-1_task'],
      },
      { handle: 'dev-1', workItem: general },
      'member_at_capacity',
    ],
    [
      'does not count an open task whose session ended',
      { tasks: [task('AR-1', { assignee: 'dev-1' })], sessions: [session('dev-1', onTask('AR-1'))] },
      { handle: 'dev-1', workItem: general },
      null,
    ],
    [
      'does not count an assigned task without a running session',
      { tasks: [task('AR-1', { assignee: 'dev-1' })] },
      { handle: 'dev-1', workItem: general },
      null,
    ],
    [
      'does not count closed tasks',
      {
        tasks: [task('AR-1', { assignee: 'dev-1', status: 'done' })],
        sessions: [session('dev-1', onTask('AR-1'))],
        running: ['ses_dev-1_task'],
      },
      { handle: 'dev-1', workItem: general },
      null,
    ],
    [
      "does not count the work item's own task",
      {
        tasks: [task('AR-1', { assignee: 'dev-1' })],
        sessions: [session('dev-1', onTask('AR-1'))],
        running: ['ses_dev-1_task'],
      },
      { handle: 'dev-1', workItem: onTask('AR-1') },
      null,
    ],
    [
      'counts running chats that are not about a task',
      { sessions: [session('dev-1', general)], running: ['ses_dev-1_general'] },
      { handle: 'dev-1', workItem: onTask('AR-2') },
      'member_at_capacity',
    ],
    [
      'lets an assignee keep its task whatever else it carries',
      { tasks: [task('AR-1', { assignee: 'dev-1' })] },
      { handle: 'dev-1', workItem: onTask('AR-2'), capacity: false },
      null,
    ],
    [
      'refuses at the concurrent AI limit',
      { busy: 3 },
      { handle: 'dev-1', workItem: general },
      'ai_limit_reached',
    ],
    [
      'puts no cap on concurrent AI sessions when the project names none (decision 23)',
      { adjust: (c) => void delete c.team.limits.maxConcurrentAi, busy: 50 },
      { handle: 'dev-1', workItem: general },
      null,
    ],
    [
      'still pauses at the plan usage threshold without a cap',
      {
        adjust: (c) => void delete c.team.limits.maxConcurrentAi,
        busy: 50,
        usage: { claude: planUsage(99) },
      },
      { handle: 'dev-1', workItem: general },
      'plan_usage_paused',
    ],
    [
      'still refuses a member at its own capacity without a cap',
      {
        adjust: (c) => void delete c.team.limits.maxConcurrentAi,
        sessions: [session('dev-1', general)],
        running: ['ses_dev-1_general'],
      },
      { handle: 'dev-1', workItem: onTask('AR-2') },
      'member_at_capacity',
    ],
    [
      'checks concurrency before plan usage',
      { busy: 3, usage: { claude: planUsage(99) } },
      { handle: 'dev-1', workItem: general },
      'ai_limit_reached',
    ],
    [
      'pauses above the plan usage threshold',
      { usage: { claude: planUsage(81) } },
      { handle: 'dev-1', workItem: general },
      'plan_usage_paused',
    ],
    ['allows the exact threshold', { usage: { claude: planUsage(80) } }, { handle: 'dev-1' }, null],
    [
      'refuses a member whose provider is not logged in',
      { loggedOut: ['claude'] },
      { handle: 'dev-1', workItem: general },
      'provider_not_logged_in',
    ],
    [
      'does not look at the login of another provider',
      { loggedOut: ['codex'] },
      { handle: 'dev-1', workItem: general },
      null,
    ],
    [
      'checks the AI limit before the login, and the login before plan usage',
      { busy: 3, loggedOut: ['claude'], usage: { claude: planUsage(99) } },
      { handle: 'dev-1', workItem: general },
      'ai_limit_reached',
    ],
    [
      'checks the login before plan usage',
      { loggedOut: ['claude'], usage: { claude: planUsage(99) } },
      { handle: 'dev-1', workItem: general },
      'provider_not_logged_in',
    ],
    ['does not check the login of a temp worker yet to be hired', { loggedOut: ['claude'] }, {}, null],
    [
      'does not pause on the usage of a provider that has none to measure',
      {
        usage: { gemini: planUsage(99) } as never,
        adjust: (c) => {
          const dev = c.team.members.find((m) => m.handle === 'dev-1');
          if (dev?.kind === 'ai') dev.provider = 'gemini' as never;
        },
      },
      { handle: 'dev-1', workItem: general },
      null,
    ],
    [
      "reads the plan usage of the member's own provider",
      {
        usage: { claude: planUsage(99), codex: planUsage(10) },
        adjust: (c) => {
          const dev = c.team.members.find((m) => m.handle === 'dev-1');
          if (dev?.kind === 'ai') dev.provider = 'codex';
        },
      },
      { handle: 'dev-1', workItem: general },
      null,
    ],
    [
      'checks a temp worker yet to be hired on the default provider, without capacity',
      { usage: { claude: planUsage(99) }, tasks: [task('AR-1', { assignee: 'dev-1' })] },
      {},
      'plan_usage_paused',
    ],
    [
      'refuses a role that changes files on a task without a repository when the project has several',
      { adjust: withTwoRepos, tasks: [task('AR-1')] },
      { handle: 'dev-1', workItem: onTask('AR-1') },
      'repo_required',
    ],
    [
      'admits that role once the task names a repository',
      { adjust: withTwoRepos, tasks: [task('AR-1', { repo: 'api' })] },
      { handle: 'dev-1', workItem: onTask('AR-1') },
      null,
    ],
    [
      'admits a reviewer on a task without a repository',
      { adjust: withTwoRepos, tasks: [task('AR-1')] },
      { handle: 'cr', workItem: onTask('AR-1') },
      null,
    ],
    [
      'admits a developer on a task without a repository when the project has one, which it works in',
      { tasks: [task('AR-1')] },
      { handle: 'dev-1', workItem: onTask('AR-1') },
      null,
    ],
    [
      'admits a developer on a task without a repository when the project has none',
      { adjust: (config) => void (config.project.repos = []), tasks: [task('AR-1')] },
      { handle: 'dev-1', workItem: onTask('AR-1') },
      null,
    ],
    [
      'asks for the repository of the task for a temp worker yet to be hired, in the role the limits name',
      { adjust: withTwoRepos, tasks: [task('AR-1')] },
      { workItem: onTask('AR-1') },
      'repo_required',
    ],
    [
      'admits a temp worker of a role that only reads on a task without a repository',
      {
        adjust: (config) => {
          withTwoRepos(config);
          config.team.limits.tempWorkers.role = 'code_review';
        },
        tasks: [task('AR-1')],
      },
      { workItem: onTask('AR-1') },
      null,
    ],
    [
      'asks for a repository for tasks only, not for chats and scheduled runs',
      { adjust: withTwoRepos, tasks: [task('AR-1')] },
      { handle: 'dev-1', workItem: scheduled },
      null,
    ],
    [
      'checks the master switch before the repository',
      {
        adjust: (config) => {
          withTwoRepos(config);
          config.team.limits.aiEnabled = false;
        },
        tasks: [task('AR-1')],
      },
      { handle: 'dev-1', workItem: onTask('AR-1') },
      'ai_disabled',
    ],
    [
      'checks the repository before capacity, the AI limit and plan usage, which waiting would not help',
      {
        adjust: withTwoRepos,
        tasks: [task('AR-1'), task('AR-2', { assignee: 'dev-1' })],
        busy: 9,
        usage: { claude: planUsage(99) },
      },
      { handle: 'dev-1', workItem: onTask('AR-1') },
      'repo_required',
    ],
  ])('%s', async (_name, world, request, expected) => {
    const { admission, config, member } = admissionFor(world);
    const code = await refusal(
      admission.check({
        config,
        member: request.handle ? member(request.handle) : undefined,
        workItem: request.workItem,
        capacity: request.capacity,
      }),
    );
    expect(code).toBe(expected);
  });

  it('asks for no plan usage when an earlier check refuses', async () => {
    const { admission, config, usageRequests } = admissionFor({
      adjust: (c) => void (c.team.limits.aiEnabled = false),
    });
    expect(await refusal(admission.check({ config }))).toBe('ai_disabled');
    expect(usageRequests).toEqual([]);
  });

  it('reuses a running session without admission and starts others only when admitted', async () => {
    const { admission, config, member, sessionFake } = admissionFor({
      sessions: [session('dev-1', general)],
      running: ['ses_dev-1_general'],
      busy: 3,
    });
    const reused = await admission.start({ config, member: member('dev-1'), workItem: general });
    expect(reused).toMatchObject({ session: { id: 'ses_dev-1_general' }, started: false });
    expect(await refusal(admission.start({ config, member: member('dev-2'), workItem: general }))).toBe(
      'ai_limit_reached',
    );
    expect(sessionFake.ensureSession).not.toHaveBeenCalled();
  });
});

describe('deferred starts', () => {
  it('keeps an automatic Codex start waiting for setup and retries after repair', async () => {
    const reviewing = task('AR-1', { stageId: 'code_review' });
    const { admission, deferred } = admissionFor({ tasks: [reviewing] });
    const { automatic, retry } = start('hand-over:AR-1', { taskKey: 'AR-1', member: 'cr' });
    let incomplete = true;
    automatic.run = async () => {
      if (incomplete)
        throw conflict('codex_setup_incomplete', 'Codex is not ready', {
          provider: 'codex',
          problem: 'sandbox_config',
        });
    };
    await admission.attempt(automatic);
    expect(deferred.waitingFor(reviewing)).toMatchObject({
      reason: 'codex_setup_incomplete',
      member: 'cr',
      provider: 'codex',
      since: AT,
    });
    await admission.retryDeferred();
    expect(retry).toHaveBeenCalledOnce();
    incomplete = false;
    await admission.attempt(automatic);
    expect(deferred.list()).toEqual([]);
  });
  /** A start that the admission refuses with `code` until it is set to null. */
  function start(
    key: string,
    opts: { taskKey?: string | null; stage?: string; member?: string; refuse?: () => string | null },
  ) {
    const run = vi.fn(async () => {
      const code = opts.refuse?.() ?? null;
      if (code) throw new DomainError(code as never, `refused: ${code}`, { status: 409 });
    });
    const retry = vi.fn(async () => undefined);
    const automatic: AutomaticStart = {
      key,
      projectKey: 'AR',
      taskKey: opts.taskKey ?? null,
      spec: () => ({
        kind: 'hand_over',
        projectKey: 'AR',
        taskKey: opts.taskKey ?? 'AR-1',
        from: 'backlog',
        to: opts.stage ?? 'code_review',
        actor: { kind: 'system', handle: null },
      }),
      stillValid: (t) => (t ? t.stageId === (opts.stage ?? 'code_review') && t.status === 'active' : true),
      run,
      waitsFor: () => opts.member,
      retry,
      log: {
        deferred: 'fictional start deferred',
        retryFailed: 'fictional retry failed',
        fields: () => ({ key }),
      },
    };
    return { automatic, run, retry };
  }

  it('keeps a start refused for a reason that can clear, with why it waits', async () => {
    const reviewing = task('AR-1', { stageId: 'code_review' });
    const { admission, deferred, published } = admissionFor({ tasks: [reviewing] });
    let code: string | null = 'plan_usage_paused';
    const { automatic } = start('hand-over:AR-1', { taskKey: 'AR-1', member: 'cr', refuse: () => code });
    await admission.attempt(automatic);
    const waiting = deferred.waitingFor(reviewing);
    expect(waiting).toMatchObject({ reason: 'plan_usage_paused', member: 'cr', since: AT });
    expect(published).toEqual(['AR-1']);
    // Refused again: it keeps waiting since the first refusal.
    code = 'ai_limit_reached';
    await admission.attempt(automatic);
    expect(deferred.waitingFor(reviewing)).toMatchObject({ reason: 'ai_limit_reached', since: AT });
    code = null;
    await admission.attempt(automatic);
    expect(deferred.waitingFor(reviewing)).toBeUndefined();
    expect(deferred.list()).toEqual([]);
  });

  it('keeps a start whose member is not logged in, with the provider, and retries it (PM-324)', async () => {
    const reviewing = task('AR-1', { stageId: 'code_review' });
    const loggedOut: AgentProvider[] = ['codex'];
    const { admission, deferred, config, member } = admissionFor({
      tasks: [reviewing],
      loggedOut,
      adjust: (c) => {
        const cr = c.team.members.find((m) => m.handle === 'cr');
        if (cr?.kind === 'ai') cr.provider = 'codex';
      },
    });
    const { automatic, retry } = start('hand-over:AR-1', { taskKey: 'AR-1', member: 'cr' });
    automatic.run = () => admission.check({ config, member: member('cr'), workItem: onTask('AR-1') });
    await admission.attempt(automatic);
    expect(deferred.waitingFor(reviewing)).toMatchObject({
      reason: 'provider_not_logged_in',
      member: 'cr',
      provider: 'codex',
      since: AT,
    });
    await admission.retryDeferred();
    expect(retry).toHaveBeenCalledOnce();
    // Once the provider is logged in, the next attempt starts it.
    loggedOut.length = 0;
    await admission.attempt(automatic);
    expect(deferred.list()).toEqual([]);
  });

  it('waits for no_free_member only when the start asks for it (PM-119: it picks its developer itself)', async () => {
    expect(isDeferrable(conflict('no_free_member', 'fictional refusal'))).toBe(false);
    expect(isDeferrable(conflict('no_free_member', 'fictional refusal'), ['no_free_member'])).toBe(true);
    const { admission, deferred } = admissionFor({ tasks: [task('AR-1', { stageId: 'code_review' })] });
    const { automatic } = start('hand-over:AR-1', { taskKey: 'AR-1', refuse: () => 'no_free_member' });
    automatic.defers = ['no_free_member'];
    await admission.attempt(automatic);
    expect(deferred.waitingFor(task('AR-1', { stageId: 'code_review' }))).toMatchObject({
      reason: 'no_free_member',
    });
  });

  it.each(['no_free_member', 'session_start_failed', 'previous_run_live', 'repo_required'])(
    'lets the refusal %s through without keeping the start',
    async (code) => {
      const { admission, deferred } = admissionFor({ tasks: [task('AR-1', { stageId: 'code_review' })] });
      const { automatic } = start('hand-over:AR-1', { taskKey: 'AR-1', refuse: () => code });
      expect(await refusal(admission.attempt(automatic))).toBe(code);
      expect(deferred.list()).toEqual([]);
    },
  );

  it('does not wait for a repository: only the refusals a retry can overcome are deferrable', () => {
    for (const code of [
      'ai_limit_reached',
      'plan_usage_paused',
      'ai_disabled',
      'member_at_capacity',
      'member_on_leave',
      'provider_not_logged_in',
    ] as const)
      expect(isDeferrable(conflict(code, 'fictional refusal')), code).toBe(true);
    expect(isDeferrable(conflict('repo_required', 'fictional refusal'))).toBe(false);
  });

  it('shows the earliest refusal that still applies to the task', () => {
    const deferred = new DeferredStarts();
    const reviewing = task('AR-1', { stageId: 'code_review' });
    const earlier = start('message:AR-1', { taskKey: 'AR-1', stage: 'development' }).automatic;
    const later = start('hand-over:AR-1', { taskKey: 'AR-1' }).automatic;
    deferred.keep({ start: earlier, waiting: { reason: 'ai_disabled', since: '2026-09-30T09:00:00.000Z' } });
    deferred.keep({ start: later, waiting: { reason: 'member_at_capacity', since: AT } });
    expect(deferred.waitingFor(reviewing)).toMatchObject({ reason: 'member_at_capacity' });
    deferred.discardStale(reviewing);
    expect(deferred.list().map((entry) => entry.start.key)).toEqual(['hand-over:AR-1']);
  });

  it('retries the starts that still apply and drops the others', async () => {
    const { admission, deferred, tasks, published } = admissionFor({
      tasks: [task('AR-1', { stageId: 'code_review' }), task('AR-2', { stageId: 'code_review' })],
    });
    const stale = start('hand-over:AR-1', { taskKey: 'AR-1' });
    const valid = start('hand-over:AR-2', { taskKey: 'AR-2' });
    const general = start('message:AR:cr:general', { taskKey: null });
    for (const { automatic } of [stale, valid, general])
      deferred.keep({ start: automatic, waiting: { reason: 'ai_disabled', since: AT } });
    tasks.set('AR-1', task('AR-1', { stageId: 'code_review', status: 'done' }));
    await admission.retryDeferred();
    expect(stale.retry).not.toHaveBeenCalled();
    expect(published).toEqual(['AR-1']);
    expect(valid.retry).toHaveBeenCalledOnce();
    expect(general.retry).toHaveBeenCalledOnce();
    expect(deferred.list().map((entry) => entry.start.key)).toEqual([
      'hand-over:AR-2',
      'message:AR:cr:general',
    ]);
  });

  it('logs a failed retry and goes on with the next start', async () => {
    const { admission, deferred, log } = admissionFor();
    const failing = start('message:AR:dev-1:general', {});
    failing.retry.mockRejectedValueOnce(new Error('fictional failure'));
    const next = start('message:AR:dev-2:general', {});
    for (const { automatic } of [failing, next])
      deferred.keep({ start: automatic, waiting: { reason: 'ai_disabled', since: AT } });
    await admission.retryDeferred();
    expect(next.retry).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.warnings)).toContain('fictional retry failed');
  });

  describe('while the project AI switch is off', () => {
    const aiOff = (c: ProjectConfig) => void (c.team.limits.aiEnabled = false);
    const since = { since: AT };

    it('leaves a start that waits for the switch alone, and retries the starts that wait for something else', async () => {
      const { admission, deferred, config, log } = admissionFor({
        tasks: [task('AR-1', { stageId: 'code_review' }), task('AR-2', { stageId: 'code_review' })],
        adjust: aiOff,
      });
      const forSwitch = start('hand-over:AR-1', { taskKey: 'AR-1' });
      const forCapacity = start('hand-over:AR-2', { taskKey: 'AR-2' });
      deferred.keep({ start: forSwitch.automatic, waiting: { reason: 'ai_disabled', ...since } });
      deferred.keep({ start: forCapacity.automatic, waiting: { reason: 'member_at_capacity', ...since } });

      await admission.retryDeferred();
      await admission.retryDeferred();
      expect(forSwitch.retry).not.toHaveBeenCalled();
      expect(forCapacity.retry).toHaveBeenCalledTimes(2);
      expect(deferred.list().map((entry) => entry.start.key)).toEqual(['hand-over:AR-1', 'hand-over:AR-2']);
      expect(log.warnings).toEqual([]);

      // The start that waited for the switch is tried again once the switch is on.
      config.team.limits.aiEnabled = true;
      await admission.retryDeferred();
      expect(forSwitch.retry).toHaveBeenCalledOnce();
    });

    it('still drops a start that does not apply any more', async () => {
      const { admission, deferred, published } = admissionFor({
        tasks: [task('AR-1', { stageId: 'development' })],
        adjust: aiOff,
      });
      const moved = start('hand-over:AR-1', { taskKey: 'AR-1' });
      deferred.keep({ start: moved.automatic, waiting: { reason: 'ai_disabled', ...since } });
      await admission.retryDeferred();
      expect(deferred.list()).toEqual([]);
      expect(published).toEqual(['AR-1']);
    });

    it('retries the starts of a project whose switch is on, and of one whose configuration cannot be read', async () => {
      const on = admissionFor({ tasks: [task('AR-1', { stageId: 'code_review' })] });
      const retry = start('hand-over:AR-1', { taskKey: 'AR-1' });
      on.deferred.keep({ start: retry.automatic, waiting: { reason: 'ai_disabled', ...since } });
      await on.admission.retryDeferred();
      expect(retry.retry).toHaveBeenCalledOnce();

      const unknown = admissionFor({ tasks: [task('AR-1', { stageId: 'code_review' })], configFails: true });
      const other = start('hand-over:AR-1', { taskKey: 'AR-1' });
      unknown.deferred.keep({ start: other.automatic, waiting: { reason: 'ai_disabled', ...since } });
      await unknown.admission.retryDeferred();
      expect(other.retry).toHaveBeenCalledOnce();
    });
  });

  describe('while a member is on leave', () => {
    const since = { since: AT };

    it('keeps the start that waits for the member and tries it again once the member is called back', async () => {
      const reviewing = task('AR-1', { stageId: 'code_review' });
      const { admission, deferred, config, log } = admissionFor({
        tasks: [reviewing],
        adjust: sendOnLeave('cr'),
      });
      let code: string | null = 'member_on_leave';
      const waiting = start('message:AR:cr:AR-1', {
        taskKey: 'AR-1',
        stage: 'code_review',
        member: 'cr',
        refuse: () => code,
      });
      await admission.attempt(waiting.automatic);
      expect(deferred.waitingFor(reviewing)).toMatchObject({ reason: 'member_on_leave', member: 'cr' });

      // A retry could only be refused and logged again: it is left alone while the member is away.
      await admission.retryDeferred();
      await admission.retryDeferred();
      expect(waiting.retry).not.toHaveBeenCalled();
      expect(log.warnings).toEqual([]);

      const cr = config.team.members.find((m) => m.handle === 'cr');
      if (cr?.kind === 'ai') delete cr.onLeave;
      code = null;
      await admission.retryDeferred();
      expect(waiting.retry).toHaveBeenCalledOnce();
    });

    it('retries a start that waits for another member, or for nobody in particular', async () => {
      const { admission, deferred } = admissionFor({
        tasks: [task('AR-1', { stageId: 'code_review' }), task('AR-2', { stageId: 'code_review' })],
        adjust: sendOnLeave('cr'),
      });
      const other = start('hand-over:AR-1', { taskKey: 'AR-1', member: 'dev-2' });
      const anyone = start('hand-over:AR-2', { taskKey: 'AR-2' });
      deferred.keep({
        start: other.automatic,
        waiting: { reason: 'member_on_leave', member: 'dev-2', ...since },
      });
      deferred.keep({ start: anyone.automatic, waiting: { reason: 'member_on_leave', ...since } });
      await admission.retryDeferred();
      expect(other.retry).toHaveBeenCalledOnce();
      expect(anyone.retry).toHaveBeenCalledOnce();
    });
  });

  describe('kept in SQLite', () => {
    const SYSTEM = { kind: 'system', handle: null } as const;

    it('mirrors what it keeps, replaces and drops, and keeps a start stored while it is attempted', async () => {
      const reviewing = task('AR-1', { stageId: 'code_review' });
      const { admission, deferred, store } = admissionFor({ tasks: [reviewing], persist: true });
      let code: string | null = 'plan_usage_paused';
      const { automatic } = start('hand-over:AR-1', { taskKey: 'AR-1', member: 'cr', refuse: () => code });
      await admission.attempt(automatic);
      const record = {
        key: 'hand-over:AR-1',
        projectKey: 'AR',
        taskKey: 'AR-1',
        spec: {
          kind: 'hand_over',
          projectKey: 'AR',
          taskKey: 'AR-1',
          from: 'backlog',
          to: 'code_review',
          actor: SYSTEM,
        },
      };
      expect(store.list()).toEqual([
        { ...record, waiting: { reason: 'plan_usage_paused', member: 'cr', since: AT } },
      ]);

      // Refused for another reason: the stored deferral is replaced, from the same time.
      code = 'ai_limit_reached';
      await admission.attempt(automatic);
      expect(store.list()).toEqual([
        { ...record, waiting: { reason: 'ai_limit_reached', member: 'cr', since: AT } },
      ]);

      // While the attempt runs the start leaves the store's view but stays stored; once it
      // happened, it is gone from both.
      let storedDuring = -1;
      let shownDuring: unknown = 'not read';
      automatic.run = async () => {
        storedDuring = store.list().length;
        shownDuring = deferred.waitingFor(reviewing);
      };
      await admission.attempt(automatic);
      expect(storedDuring).toBe(1);
      expect(shownDuring).toBeUndefined();
      expect(store.list()).toEqual([]);
      expect(deferred.list()).toEqual([]);

      // A refusal that cannot clear ends the start, stored or not.
      code = 'plan_usage_paused';
      automatic.run = async () => {
        if (code) throw new DomainError(code as never, 'refused', { status: 409 });
      };
      await admission.attempt(automatic);
      expect(store.list()).toHaveLength(1);
      code = 'no_free_member';
      expect(await refusal(admission.attempt(automatic))).toBe('no_free_member');
      expect(store.list()).toEqual([]);
    });

    it('drops the stored starts of a task that moved on, and only those', () => {
      const { deferred, store } = admissionFor({ persist: true });
      const moved = start('hand-over:AR-1', { taskKey: 'AR-1' }).automatic;
      const staying = start('hand-over:AR-2', { taskKey: 'AR-2' }).automatic;
      for (const automatic of [moved, staying])
        deferred.keep({ start: automatic, waiting: { reason: 'ai_disabled', since: AT } });
      deferred.discardStale(task('AR-1', { stageId: 'development' }));
      expect(store.list().map((record) => record.key)).toEqual(['hand-over:AR-2']);
    });

    it('restores the stored starts as they waited, oldest first, and removes the ones it cannot rebuild', () => {
      const { deferred: earlier, store } = admissionFor({ persist: true });
      const reasons = ['ai_disabled', 'plan_usage_paused', 'member_at_capacity'] as const;
      reasons.forEach((reason, i) => {
        const automatic = start(`hand-over:AR-${i + 1}`, { taskKey: `AR-${i + 1}` }).automatic;
        earlier.keep({
          start: automatic,
          waiting: { reason, member: 'cr', since: `2026-09-30T10:0${i}:00.000Z` },
        });
      });
      store.save({
        key: 'from-a-newer-build',
        projectKey: 'AR',
        taskKey: null,
        spec: { kind: 'other' },
        waiting: {},
      });

      const later = new DeferredStarts(store);
      const rebuilt: string[] = [];
      const result = later.restore((spec) => {
        if (spec.kind !== 'hand_over') return null;
        rebuilt.push(spec.taskKey);
        // AR-3's task is gone.
        return spec.taskKey === 'AR-3'
          ? null
          : start(`hand-over:${spec.taskKey}`, { taskKey: spec.taskKey }).automatic;
      });
      expect(result).toEqual({ restored: 2, removed: 2 });
      expect(rebuilt).toEqual(['AR-1', 'AR-2', 'AR-3']);
      expect(later.list().map((entry) => [entry.start.key, entry.waiting])).toEqual([
        ['hand-over:AR-1', { reason: 'ai_disabled', member: 'cr', since: '2026-09-30T10:00:00.000Z' }],
        ['hand-over:AR-2', { reason: 'plan_usage_paused', member: 'cr', since: '2026-09-30T10:01:00.000Z' }],
      ]);
      expect(store.list().map((record) => record.key)).toEqual(['hand-over:AR-1', 'hand-over:AR-2']);
    });

    it('stores a restored start again under the key it is made with now', () => {
      const { deferred: earlier, store } = admissionFor({ persist: true });
      earlier.keep({
        start: start('old-key', { taskKey: 'AR-1' }).automatic,
        waiting: { reason: 'ai_disabled', since: AT },
      });
      const later = new DeferredStarts(store);
      later.restore(() => start('hand-over:AR-1', { taskKey: 'AR-1' }).automatic);
      expect(later.list().map((entry) => entry.start.key)).toEqual(['hand-over:AR-1']);
      expect(store.list().map((record) => record.key)).toEqual(['hand-over:AR-1']);
    });

    it('restores nothing without a store', () => {
      expect(new DeferredStarts().restore(() => null)).toEqual({ restored: 0, removed: 0 });
    });
  });
});
