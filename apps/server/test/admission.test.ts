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
import { Admission, DeferredStarts, DomainError } from '../src/domain';
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
  busy?: number;
  usage?: Partial<Record<AgentProvider, PlanUsage | null>>;
  adjust?: (config: ProjectConfig) => void;
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
    busyCount: () => world.busy ?? 0,
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
    })),
  };
  const deferred = new DeferredStarts();
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
    deferred,
  });
  const config = testConfig();
  world.adjust?.(config);
  const member = (handle: string) => config.team.members.find((m) => m.handle === handle) as AiMemberConfig;
  return { admission, deferred, config, member, usageRequests, published, tasks, sessionFake, log };
}

const refusal = async (promise: Promise<unknown>): Promise<string | null> =>
  promise.then(
    () => null,
    (err: unknown) => (err instanceof DomainError ? err.code : String(err)),
  );

const general: WorkItemRef = { type: 'general' };
const scheduled: WorkItemRef = { type: 'schedule', runId: 'run_fictional' };
const onTask = (taskKey: string): WorkItemRef => ({ type: 'task', taskKey });

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
      'counts the open tasks a member is assigned to against its capacity',
      { tasks: [task('AR-1', { assignee: 'dev-1' })] },
      { handle: 'dev-1', workItem: general },
      'member_at_capacity',
    ],
    [
      'counts the tasks a member has a session for',
      { tasks: [task('AR-1')], sessions: [session('dev-1', onTask('AR-1'))] },
      { handle: 'dev-1', workItem: general },
      'member_at_capacity',
    ],
    [
      'does not count closed tasks',
      { tasks: [task('AR-1', { assignee: 'dev-1', status: 'done' })] },
      { handle: 'dev-1', workItem: general },
      null,
    ],
    [
      "does not count the work item's own task",
      { tasks: [task('AR-1', { assignee: 'dev-1' })] },
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

  it.each(['no_free_member', 'session_start_failed', 'previous_run_live'])(
    'lets the refusal %s through without keeping the start',
    async (code) => {
      const { admission, deferred } = admissionFor({ tasks: [task('AR-1', { stageId: 'code_review' })] });
      const { automatic } = start('hand-over:AR-1', { taskKey: 'AR-1', refuse: () => code });
      expect(await refusal(admission.attempt(automatic))).toBe(code);
      expect(deferred.list()).toEqual([]);
    },
  );

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
});
