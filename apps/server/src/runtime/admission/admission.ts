import {
  aiLimitReached,
  canReplaceUnstartedAssignee,
  compareStartClass,
  DEFAULT_AGENT_PROVIDER,
  OUTAGE_REFUSALS,
  pausesOnPlanUsage,
  planUsagePause,
  isHandleOnLeave,
  isOpenTask,
  isSessionAtWork,
  isTheme,
  isWorkingOnTask,
  isWorkPaused,
  LOCAL_ENGINE_ID,
  complexityLimitOf,
  complexityOf,
  reachingDevelopers,
  stageDevelopers,
  stageOwners,
  memberOf,
  openPrerequisites,
  sessionWorkItemOf,
  startClass,
  workStageOf,
} from '@projectman/shared';
import type {
  AiMemberConfig,
  AgentProvider,
  CapacityHolder,
  EngineId,
  FocusPlace,
  FreeDeveloper,
  MemberHandle,
  PlanUsage,
  ProjectConfig,
  Task,
  TaskStartWaiting,
  WorkItemRef,
} from '@projectman/shared';
import type { EngineDirectory } from '../../contracts';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import type { DiskGuard } from '../watchers';
import { conflict, DomainError } from '../../kernel';
import type { PlanUsageCache } from '../usage';
import type { ProjectService } from '../../core/projects';
import type { EnsureSessionResult, SessionOrchestrator, SessionStartCause } from '../sessions';
import { prerequisiteCards } from '../../core/tasks';
import type { TaskService } from '../../core/tasks';
import { KeyedMutex, withoutIntegratorExecution } from '../../kernel';
import type { AutomaticStart, DeferredStart, DeferredStarts, StartSpec } from './deferred-starts';
import {
  assertAiEnabled,
  assertNotOnLeave,
  assertNotPaused,
  assertRepoChosen,
  isDeferrable,
  waitingOf,
} from './rules';

/** What an `attempt` came to (PM-543): the start ran or no longer applies, or admission put it off. */
type AttemptOutcome = { kind: 'done' } | { kind: 'deferred'; waiting: TaskStartWaiting };

interface AdmissionRequest {
  config: ProjectConfig;
  /** The AI member that would work; none for a temp worker yet to be hired (the default provider runs it). */
  member?: AiMemberConfig;
  /** What the session is for: its task is not counted in the member's load. */
  workItem?: WorkItemRef;
  /** Whether the member's capacity applies (default true); a task's assignee keeps working on it. */
  capacity?: boolean;
  /** Whether the team's concurrent AI limit applies (default true); a queue item the team waits on skips it (PM-925). */
  aiLimit?: boolean;
  /**
   * The messages that cause the start, oldest first, as they are typed in: the session takes them
   * in its first input (see `SessionOrchestrator.ensureSession`).
   */
  messages?: string[];
  /** Why the session starts (PM-249): the card's other workers are told with it. */
  cause?: SessionStartCause;
}

/** How long an event's request for a retry waits for the others of its burst. */
const RETRY_DEBOUNCE_MS = 750;

/** What `retryDeferred` asks of the focus pull (PM-427). */
export interface FocusPulling {
  /** Key -> place of the project's open cards the focus covers. */
  places(projectKey: string): ReadonlyMap<string, FocusPlace>;
  /** One round: pulls the cards free developers take, at the end of the retry loop. */
  run(): Promise<void>;
}

export interface StartRounding {
  run(): Promise<void>;
}

/**
 * Admission: every AI session start that no person asked for directly (task start, stage
 * hand-over, message wake-up, schedule run) passes the same checks, in this order: the
 * project's AI master switch; that the team is not paused (`team_paused`, PM-219); that the member is not on leave (`member_on_leave`, decision 23);
 * for a task, that a role which changes files has a repository to
 * work in (`repo_required`: a person has to choose it, so waiting does not help); for a scheduled
 * run, the member's previous run has ended; the member's capacity (open tasks it has a running session for plus its
 * other running chats); the concurrent AI sessions (`maxConcurrentAi`, when the project sets
 * one: there is no cap otherwise); that the member's provider is logged in (`provider_not_logged_in`,
 * PM-324); the plan usage of the member's provider, when the provider has a measurable one; the free disk space (`disk_low`, PM-243). Decisions and the starts they allow are serialized. An automatic start
 * refused for a reason that can clear waits in the deferred-start store, which SQLite backs, and
 * is retried.
 */
export class Admission {
  private readonly ctx: DomainContext;
  private readonly sessions: SessionOrchestrator;
  private readonly planUsage: Pick<PlanUsageCache, 'get' | 'peek'>;
  private readonly tasks: TaskService;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly deferred: DeferredStarts;
  private readonly disk?: Pick<DiskGuard, 'assertRoom'>;
  private readonly engines?: Pick<EngineDirectory, 'engineFor' | 'projectEngine' | 'get'>;
  private readonly locks = new KeyedMutex();
  private pull: FocusPulling | undefined;
  private round: StartRounding | undefined;
  private retrying: Promise<void> | null = null;
  private retryAgain = false;
  private readonly retryDebounceMs: number;
  private requestedRetry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private queueRetry: (() => Promise<void>) | undefined;
  private readonly onOutageRefusal?: (
    projectKey: string,
    handle: string,
    code: string,
    details?: Record<string, unknown>,
  ) => void;

  constructor(deps: {
    ctx: DomainContext;
    sessions: SessionOrchestrator;
    planUsage: Pick<PlanUsageCache, 'get' | 'peek'>;
    tasks: TaskService;
    projects: Pick<ProjectService, 'config'>;
    deferred: DeferredStarts;
    onOutageRefusal?: (
      projectKey: string,
      handle: string,
      code: string,
      details?: Record<string, unknown>,
    ) => void;
    disk?: Pick<DiskGuard, 'assertRoom'>;
    /** The engines (PM-311): a member whose engine is not connected waits (`engine_offline`). */
    engines?: Pick<EngineDirectory, 'engineFor' | 'projectEngine' | 'get'>;
    /** How long a requested retry waits to join the ones that follow it (default `RETRY_DEBOUNCE_MS`). */
    retryDebounceMs?: number;
  }) {
    this.retryDebounceMs = deps.retryDebounceMs ?? RETRY_DEBOUNCE_MS;
    this.disk = deps.disk;
    this.engines = deps.engines;
    this.ctx = deps.ctx;
    this.sessions = deps.sessions;
    this.planUsage = deps.planUsage;
    this.tasks = deps.tasks;
    this.projects = deps.projects;
    this.deferred = deps.deferred;
    this.onOutageRefusal = deps.onOutageRefusal;
  }

  /** Runs `fn` alone among admission decisions and the starts they allow (across projects). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.run('ai-admission', fn);
  }

  /**
   * What a member is working on now (decision 19): the open tasks it has a running session for
   * that it works on (see `isWorkingOnTask`: a session idling after the member handed the task
   * on does not count; one still to begin its first turn does, though its CLI reports idle meanwhile:
   * PM-242), plus its other running chats. A finished session, or an assignment without a running
   * session, does not count.
   */
  memberLoad(config: ProjectConfig, handle: string, excludeTaskKey?: string): number {
    return this.holders(config, handle, excludeTaskKey).length;
  }

  /**
   * What takes the member's places (PM-297): exactly the set `memberLoad` counts, one element per
   * task (its sessions together) and one per other running session.
   */
  holders(config: ProjectConfig, handle: string, excludeTaskKey?: string): CapacityHolder[] {
    const holders: CapacityHolder[] = [];
    const ofTask = new Map<string, CapacityHolder>();
    for (const s of this.sessions.list(config.project.key, { member: handle })) {
      if (!this.sessions.isRunning(s.id)) continue;
      const awaitsFirstTurn = this.sessions.awaitsFirstTurn(s.id);
      const working = isSessionAtWork(s, { awaitsFirstTurn, pendingInput: false, messageOnItsWay: false });
      if (s.workItem.type !== 'task') {
        holders.push({
          kind: s.workItem.type,
          sessionId: s.id,
          working,
          startedAt: s.startedAt,
          lastActivityAt: s.lastActivityAt,
        });
        continue;
      }
      if (s.workItem.taskKey === excludeTaskKey) continue;
      const task = this.ctx.repos.tasks.get(s.workItem.taskKey);
      if (
        !task ||
        !isOpenTask(task) ||
        isTheme(task) ||
        !(isWorkingOnTask(config, task, handle, s.state) || awaitsFirstTurn)
      )
        continue;
      const held = ofTask.get(task.key);
      if (!held) {
        const holder: CapacityHolder = {
          kind: 'task',
          taskKey: task.key,
          sessionId: s.id,
          working,
          startedAt: s.startedAt,
          lastActivityAt: s.lastActivityAt,
        };
        ofTask.set(task.key, holder);
        holders.push(holder);
        continue;
      }
      held.working ||= working;
      if (s.startedAt < held.startedAt) held.startedAt = s.startedAt;
      if (s.lastActivityAt > held.lastActivityAt) {
        held.lastActivityAt = s.lastActivityAt;
        held.sessionId = s.id;
      }
    }
    return holders;
  }

  /** Whether an open task is assigned to the member; a temp worker carries one task at a time. */
  hasOpenAssignment(projectKey: string, handle: string): boolean {
    return this.ctx.repos.tasks.listByAssignee(projectKey, handle).some(isOpenTask);
  }

  /** Throws the refusal when the work must wait (see the class comment for the checks). */
  async check(request: AdmissionRequest): Promise<void> {
    const { config, member, workItem } = request;
    const projectKey = config.project.key;
    assertAiEnabled(config);
    assertNotPaused(this.ctx.repos.pauses, projectKey);
    assertNotOnLeave(member);
    if (workItem?.type === 'task') {
      // A temp worker yet to be hired has the role the limits name for it.
      const role = member?.role ?? config.team.limits.tempWorkers.role;
      const task = this.ctx.repos.tasks.get(workItem.taskKey);
      assertRepoChosen(config, role, task);
      // The member's workspace for the repository serves one task at a time (PM-138).
      if (member && task) this.sessions.assertWorkspaceFree(config, member, task);
    }
    if (member && workItem?.type === 'schedule' && this.hasLiveScheduledRun(projectKey, member.handle))
      throw conflict('previous_run_live', `the previous scheduled run of ${member.handle} is still live`);
    if (member && request.capacity !== false) {
      const excluded = workItem?.type === 'task' ? workItem.taskKey : undefined;
      if (this.memberLoad(config, member.handle, excluded) >= member.capacity)
        throw conflict('member_at_capacity', `${member.handle} is at capacity (${member.capacity})`, {
          capacity: member.capacity,
        });
    }
    const busy = this.sessions.busyCount();
    if (request.aiLimit !== false && aiLimitReached(config, busy)) {
      const max = config.team.limits.maxConcurrentAi;
      throw conflict('ai_limit_reached', `${busy} AI sessions are working (limit ${max})`, { busy, max });
    }
    const provider = member?.provider ?? DEFAULT_AGENT_PROVIDER;
    // The engine the member's sessions run on must be connected (PM-311): the start waits for it.
    const engineId = member ? this.assertEngineOnline(projectKey, member.handle) : undefined;
    // The hold is on the key that engine uses (PM-1091), so it is read once the engine is known.
    this.sessions.assertProviderCooldown(provider, engineId);
    // A provider that is not logged in cannot run the session (PM-324): the start waits for the login.
    if (member) await this.sessions.assertProviderReady(provider, member.handle, engineId);
    if (pausesOnPlanUsage(provider)) {
      const usage = await this.planUsage.get(
        provider,
        engineId ?? this.usageEngine(projectKey, member?.handle),
      );
      this.assertUsageBelowPause(config, provider, usage);
    }
    // Last, because it measures the disk (PM-243).
    await this.disk?.assertRoom(config, engineId);
  }

  /**
   * The engine whose account the provider is measured on: the member's own, else (no member yet, a temp
   * worker to be hired) the project's. Without a directory there is the one local engine.
   */
  private usageEngine(projectKey: string, member?: MemberHandle): EngineId | null {
    if (!this.engines) return LOCAL_ENGINE_ID;
    return member ? this.engines.engineFor(projectKey, member) : this.engines.projectEngine(projectKey);
  }

  /** The id of the member's engine; throws `engine_offline` when there is none or it is not connected. */
  private assertEngineOnline(projectKey: string, handle: string): EngineId | undefined {
    const engines = this.engines;
    if (!engines) return undefined;
    const engineId = engines.engineFor(projectKey, handle);
    if (engineId === null) throw conflict('engine_offline', `no engine is chosen for ${handle}`);
    if (!engines.get(engineId))
      throw conflict('engine_offline', `engine ${engineId} is not connected`, { engine: engineId });
    return engineId;
  }

  engineOffline(projectKey: string, handle: string): { engine?: EngineId } | null {
    if (!this.engines) return null;
    const engine = this.engines.engineFor(projectKey, handle);
    if (engine === null) return {};
    return this.engines.get(engine) ? null : { engine };
  }

  startFrame(config: ProjectConfig): 'ai_disabled' | 'team_paused' | 'ai_limit_reached' | null {
    if (!config.team.limits.aiEnabled) return 'ai_disabled';
    if (isWorkPaused(this.ctx.repos.pauses.open(), config.project.key)) return 'team_paused';
    if (aiLimitReached(config, this.sessions.busyCount())) return 'ai_limit_reached';
    return null;
  }

  /** AI owners with capacity and no deferred start waiting for them. */
  freeDevelopers(config: ProjectConfig, stageId: string): FreeDeveloper[] {
    const stage = config.pipeline.stages.find((s) => s.id === stageId);
    if (!stage) return [];
    const owners = new Set(stageOwners(config, stage));
    const waitedFor = this.membersWaitedFor(config.project.key);
    const free: FreeDeveloper[] = [];
    config.team.members.forEach((member, index) => {
      if (member.kind !== 'ai' || member.temp || !owners.has(member.handle)) return;
      if (isHandleOnLeave(config, member.handle) || waitedFor.has(member.handle)) return;
      if (!this.providerAvailable(config, member.provider ?? DEFAULT_AGENT_PROVIDER, member.handle)) return;
      const load = this.memberLoad(config, member.handle);
      if (load >= member.capacity) return;
      free.push({
        handle: member.handle,
        limit: complexityLimitOf(config, member),
        specialtyLabels: member.specialtyLabels,
        temp: false,
        load,
        index,
      });
    });
    return free;
  }

  /**
   * Automatic choices skip providers on hold (a quota cooldown or a plan usage pause, PM-1051); explicit
   * choices still receive the refusal. It reads the last known usage and starts nothing.
   */
  providerAvailable(config: ProjectConfig, provider: AgentProvider, member: MemberHandle): boolean {
    try {
      this.assertProviderAvailable(config, provider, member);
      return true;
    } catch (err) {
      if (
        err instanceof DomainError &&
        (err.code === 'provider_rate_limited' || err.code === 'plan_usage_paused')
      )
        return false;
      throw err;
    }
  }

  /**
   * Whether the AI assignee of an unstarted card may be replaced (`canReplaceUnstartedAssignee`, PM-1051):
   * its provider is on hold (or `providerHeld`: admission just refused it) and the facts read now show no work
   * begun: no session of the assignee on the card, no source trace of any session, no open handoff.
   * `fixLimitHeld` is the fix round limit's hold, which the caller reads.
   */
  canReplaceAssignee(
    config: ProjectConfig,
    task: Task,
    held: { fixLimitHeld: () => boolean; providerHeld?: boolean },
  ): boolean {
    const assignee = task.assignee ? memberOf(config, task.assignee) : undefined;
    if (assignee?.kind !== 'ai') return false;
    const providerBlocked =
      held.providerHeld === true ||
      !this.providerAvailable(config, assignee.provider ?? DEFAULT_AGENT_PROVIDER, assignee.handle);
    // The hold of the fix round limit is read last, and only for a card that could be replaced: reading it may open one.
    if (!providerBlocked) return false;
    const { sessions, taskHandoffs } = this.ctx.repos;
    const projectKey = config.project.key;
    return canReplaceUnstartedAssignee({
      providerBlocked,
      hasWorkSession:
        !!sessions.findByWorkItem(projectKey, assignee.handle, { type: 'task', taskKey: task.key }) ||
        !!sessions.latestSourceOfTask(projectKey, task.key),
      handoffOpen: !!taskHandoffs.open(task.key),
      fixLimitHeld: held.fixLimitHeld(),
    });
  }

  /**
   * The assignment guard of the task service (`ProviderAssignmentCheck`, PM-1051): a card is not given to
   * a member whose provider is on hold now, because that member could not start it. Synchronous, from the
   * quota hold and the last known usage of the account on the member's engine.
   */
  assertProviderAvailable(config: ProjectConfig, provider: AgentProvider, member: MemberHandle): void {
    this.sessions.assertProviderCooldown(provider, this.engines?.engineFor(config.project.key, member));
    this.assertUsageBelowPause(
      config,
      provider,
      this.planUsage.peek(provider, this.usageEngine(config.project.key, member)),
    );
  }

  private assertUsageBelowPause(
    config: ProjectConfig,
    provider: AgentProvider,
    usage: PlanUsage | null,
  ): void {
    const pause = planUsagePause(provider, usage, config.team.limits.pauseAbovePlanUsagePercent);
    if (pause)
      throw conflict(
        'plan_usage_paused',
        `${provider} plan usage is ${pause.percent}% (pause above ${pause.threshold}%)`,
        { percent: pause.percent, threshold: pause.threshold, provider },
      );
  }

  /**
   * What a card that waits for a developer whose limit reaches its points (PM-348, PM-1001) needs
   * before it may wait: no member is chosen yet, so only the checks that do not depend on one: the
   * project's AI switch, the pause, and a repository for the role of those developers (the wait
   * would never end otherwise).
   */
  checkWait(config: ProjectConfig, task: Task): void {
    assertAiEnabled(config);
    assertNotPaused(this.ctx.repos.pauses, config.project.key);
    const stage = workStageOf(config, task);
    const reaching = new Set(
      stage ? reachingDevelopers(stageDevelopers(config, stage), complexityOf(task), task.labels) : [],
    );
    const roles = new Set(
      config.team.members.flatMap((m) => (m.kind === 'ai' && reaching.has(m.handle) ? [m.role] : [])),
    );
    for (const role of roles) assertRepoChosen(config, role, task);
  }

  /** The member's session for the work item: the running one, else one admission allows. */
  async start(
    request: AdmissionRequest & { member: AiMemberConfig; workItem: WorkItemRef },
  ): Promise<EnsureSessionResult> {
    const requested = request.workItem;
    request = { ...request, workItem: sessionWorkItemOf(request.member, request.workItem) };
    const projectKey = request.config.project.key;
    const running = this.sessions.findRunning(projectKey, request.member.handle, request.workItem);
    await this.sessions.refreshProviderQuota();
    this.sessions.assertProviderCooldown(
      request.member.provider ?? DEFAULT_AGENT_PROVIDER,
      this.engines?.engineFor(projectKey, request.member.handle),
    );
    if (running) {
      const result: EnsureSessionResult = {
        session: running,
        created: false,
        resumed: false,
        started: false,
        messagesSent: 0,
        firstInput: Promise.resolve(true),
      };
      if (requested.type === 'task' && request.workItem.type === 'general')
        await this.sessions.notifyProjectManagerStart(
          projectKey,
          request.member.handle,
          requested,
          { messages: request.messages, cause: request.cause },
          result,
        );
      return result;
    }
    try {
      await this.check(request);
      return await this.sessions.ensureSession(projectKey, request.member.handle, requested, {
        messages: request.messages,
        cause: request.cause,
      });
    } catch (err) {
      const refusal = err as { code?: unknown; details?: unknown } | null;
      if (typeof refusal?.code === 'string' && OUTAGE_REFUSALS.some((code) => code === refusal.code)) {
        this.onOutageRefusal?.(
          projectKey,
          request.member.handle,
          refusal.code,
          refusal.details && typeof refusal.details === 'object'
            ? (refusal.details as Record<string, unknown>)
            : undefined,
        );
      }
      throw err;
    }
  }

  /**
   * One attempt of an automatic start, alone among admission decisions. A refusal that can
   * clear keeps the start, with why it waits, for the retry loop; other failures propagate.
   * Its task is published again when why it waits changed. Says what became of the attempt (PM-543):
   * `done` (the start ran, or no longer applies) or `deferred` with why it waits.
   */
  async attempt(start: AutomaticStart): Promise<AttemptOutcome> {
    return this.exclusive(() =>
      this.publishingWaitingChanges(start.taskKey, async (): Promise<AttemptOutcome> => {
        // The previous deferral of this start stays stored until the attempt settles.
        const previous = this.deferred.take(start.key);
        const since = previous?.start.stillValid(this.taskOf(start)) ? previous.waiting : undefined;
        if (!start.stillValid(this.taskOf(start))) {
          this.deferred.drop(start.key);
          return { kind: 'done' };
        }
        if (this.deferred.held(start)) {
          const waiting: TaskStartWaiting = {
            reason: 'waiting_answer',
            since: since?.reason === 'waiting_answer' ? since.since : isoNow(this.ctx),
            member: start.waitsFor() ?? since?.member,
          };
          this.deferred.keep({
            start: { ...start, waitsFor: () => start.waitsFor() ?? since?.member },
            waiting,
          });
          return { kind: 'deferred', waiting };
        }
        try {
          await start.run();
        } catch (err) {
          if (!isDeferrable(err, start.defers)) {
            this.deferred.drop(start.key);
            throw err;
          }
          const waiting = waitingOf(err, { member: start.waitsFor(), previous: since, at: isoNow(this.ctx) });
          this.deferred.keep({ start, waiting });
          // Capacity-freeing events retry often: it is said when the reason is new, not at every refusal that stays.
          if (previous?.waiting.reason !== waiting.reason)
            this.ctx.logger.info(
              {
                ...start.log.fields(),
                reason: waiting.reason,
                ...(err.code === 'workspace_codex_config'
                  ? { issues: (err.details as { issues?: unknown })?.issues }
                  : {}),
              },
              start.log.deferred,
            );
          return { kind: 'deferred', waiting };
        }
        // The start happened, or it no longer applies.
        this.deferred.started(start.key);
        return { kind: 'done' };
      }),
    );
  }

  /**
   * Keeps a start that waits for something no refusal names (PM-236: the labels an AI member
   * sets), under the admission lock (`exclusive`), and publishes its task so that the card shows
   * why. Retried like the other deferrals, when `blocked` lets it.
   */
  defer(start: AutomaticStart, waiting: Omit<TaskStartWaiting, 'since'>): void {
    const previous = this.deferred.take(start.key);
    this.deferred.keep({
      start,
      waiting: { ...waiting, since: previous?.waiting.since ?? isoNow(this.ctx) },
    });
    this.ctx.logger.info({ ...start.log.fields(), reason: waiting.reason }, start.log.deferred);
    const task = this.taskOf(start);
    if (task) this.tasks.publish(task);
  }

  /**
   * Startup: the starts deferred before the server stopped wait again, as they were (`rebuild`
   * makes each from what was stored). Nothing is tried here; `retryDeferred` applies admission
   * to them. Returns how many wait. Nothing is inferred from the state of tasks: only what was
   * actually deferred comes back.
   */
  restoreDeferred(rebuild: (spec: StartSpec) => AutomaticStart | null): number {
    const { restored, removed } = this.deferred.restore(rebuild);
    // The key each such start would use decides whose hold is restored (PM-1091); no engine: the cloud's.
    const engineIds = this.deferred.list().flatMap(({ start, waiting }): Array<EngineId | null> => {
      const spec = start.spec();
      if (
        spec.kind !== 'provider_resume' &&
        !(waiting.reason === 'provider_rate_limited' && waiting.provider === 'nanogpt')
      )
        return [];
      const member = spec.kind === 'provider_resume' ? spec.handle : (start.waitsFor() ?? waiting.member);
      return [member ? (this.engines?.engineFor(start.projectKey, member) ?? null) : null];
    });
    if (engineIds.length > 0) this.sessions.restoreProviderQuota(engineIds);
    if (restored + removed > 0)
      this.ctx.logger.info({ restored, removed }, 'deferred session starts restored');
    return restored;
  }

  /**
   * Retries the deferred starts that still apply; the others are dropped. A start that waits for
   * the project's master switch is left alone while the switch is off, and one that waits for a
   * member on leave while the member is away: a retry could only be refused and logged again,
   * and turning the switch on or calling the member back retries them. The order is `retryOrder`'s; the
   * focus pull (PM-427) goes last. Rounds do not overlap: a start being retried is out of the store,
   * so a second round meanwhile would not see it (and one that fails puts it back after the round that
   * saw the change). A round asked for while one runs makes the running one go once more, and both
   * callers get the result of the last.
   */
  retryDeferred(): Promise<void> {
    this.cancelRequestedRetry();
    if (this.retrying) {
      this.retryAgain = true;
      return this.retrying;
    }
    this.retrying = (async () => {
      try {
        do {
          this.retryAgain = false;
          await this.retryRound();
          // What frees a place, a limit or a hold for a deferred start does so for a queued one too (PM-925).
          // Inside the loop: a round asked for while the queue retries goes once more.
          await this.queueRetry?.().catch((err: unknown) => {
            this.ctx.logger.warn({ err }, 'member queue retry failed');
          });
        } while (this.retryAgain);
      } finally {
        this.retrying = null;
      }
    })();
    return this.retrying;
  }

  /**
   * What an event that could free a place, a limit or a hold asks for: a `retryDeferred` shortly after, the
   * requests of one burst (a session's end moves a card, a label, an idle) joined into one. The timer and
   * the callers that wait for the result call `retryDeferred` itself.
   */
  requestRetry(): void {
    if (this.disposed || this.requestedRetry) return;
    if (this.retryDebounceMs <= 0) {
      this.runRequestedRetry();
      return;
    }
    this.requestedRetry = setTimeout(() => this.runRequestedRetry(), this.retryDebounceMs);
    this.requestedRetry.unref?.();
  }

  private runRequestedRetry(): void {
    this.requestedRetry = undefined;
    // Autonomous work keeps its own system authority, not that of the request that asked for it.
    withoutIntegratorExecution(() => this.retryDeferred()).catch((err: unknown) => {
      this.ctx.logger.warn({ err }, 'deferred start retry failed');
    });
  }

  /** A retry that runs now covers the one asked for and not yet started. */
  private cancelRequestedRetry(): void {
    if (this.requestedRetry) clearTimeout(this.requestedRetry);
    this.requestedRetry = undefined;
  }

  /** No retry is asked for any more (the server stops). */
  dispose(): void {
    this.disposed = true;
    this.cancelRequestedRetry();
  }

  private async retryRound(): Promise<void> {
    await this.sessions.refreshProviderQuota();
    const configs = new Map<string, ProjectConfig | null>();
    for (const entry of this.retryOrder()) {
      if (!this.deferred.holds(entry)) continue;
      const { start } = entry;
      if (this.deferred.queued(start.key)) continue;
      const task = this.taskOf(start);
      if (start.taskKey !== null && (!task || !start.stillValid(task))) {
        this.deferred.drop(start.key);
        if (task) this.tasks.publish(task);
        continue;
      }
      if (await this.retryHoldOf(entry, task, configs)) continue;
      try {
        await start.retry();
      } catch (err) {
        this.ctx.logger.warn({ err, ...start.log.fields() }, start.log.retryFailed);
      }
    }
    // After the loop and without the lock: the pull takes it for each card it starts (it is not reentrant).
    try {
      await this.pull?.run();
    } catch (err) {
      this.ctx.logger.warn({ err }, 'focus pull failed');
    }
    try {
      await this.round?.run();
    } catch (err) {
      this.ctx.logger.warn({ err }, 'start round failed');
    }
  }

  /** Both retry stores leave an unchanged blocker alone; its existing refusal code remains visible. */
  retryHold(entry: DeferredStart): Promise<string | null> {
    return this.retryHoldOf(entry, this.taskOf(entry.start), new Map());
  }

  private async retryHoldOf(
    { start, waiting }: DeferredStart,
    task: Task | null,
    configs: Map<string, ProjectConfig | null>,
  ): Promise<string | null> {
    const { reason, member } = waiting;
    if (this.deferred.held(start)) return 'hold_waiting_answer';
    if (reason === 'team_paused' && isWorkPaused(this.ctx.repos.pauses.open(), start.projectKey))
      return reason;
    if (reason === 'ai_disabled' || reason === 'member_on_leave') {
      const config = await this.configOf(start.projectKey, configs);
      if (
        config &&
        (reason === 'ai_disabled' ? !config.team.limits.aiEnabled : isHandleOnLeave(config, member))
      )
        return reason;
    }
    if (
      reason === 'handoff_open' &&
      start.taskKey !== null &&
      this.ctx.repos.taskHandoffs.open(start.taskKey)
    )
      return reason;
    if (reason === 'prerequisite_open' && task) {
      const open = openPrerequisites(task, prerequisiteCards(this.tasks, task.projectKey, task)).map(
        (card) => card.key,
      );
      const previous = waiting.prerequisites ?? [];
      if (open.length > 0 && open.length === previous.length && open.every((key) => previous.includes(key)))
        return reason;
    }
    if ((reason === 'label_missing' || reason === 'full_test_pending') && task && start.blocked) {
      const config = await this.configOf(start.projectKey, configs);
      if (config && start.blocked(task, config)) return reason;
    }
    return null;
  }

  /**
   * The order the deferred starts are retried in (PM-427): urgent cards, then the focus cards by their
   * place, then the rest; within one class the cards that wait for a Senior go first (older first, as the
   * others do): a Senior who frees up is not taken by an older card that waits for any free developer
   * (PM-348); then the order the store lists them in. The places are read once per project.
   */
  private retryOrder(): DeferredStart[] {
    const places = new Map<string, ReadonlyMap<string, FocusPlace>>();
    const placesOf = (projectKey: string) => {
      let known = places.get(projectKey);
      if (!known) {
        known = this.pull?.places(projectKey) ?? new Map<string, FocusPlace>();
        places.set(projectKey, known);
      }
      return known;
    };
    const ranked = this.deferred.list().map((entry) => ({
      entry,
      class: startClass(this.taskOf(entry.start), placesOf(entry.start.projectKey)),
      senior: entry.waiting.reason === 'senior_busy',
    }));
    return ranked
      .sort((a, b) => compareStartClass(a.class, b.class) || Number(b.senior) - Number(a.senior))
      .map((item) => item.entry);
  }

  /**
   * Binds the focus pull (PM-427; it needs the starts, which need this class, so it is bound after): its
   * round runs at the end of `retryDeferred`, and its places order the deferred starts.
   */
  usePull(pull: FocusPulling): void {
    this.pull = pull;
  }

  /** Binds the member queue's retry (built after this class): it runs at the end of every `retryDeferred`. */
  useQueueRetry(retry: () => Promise<void>): void {
    this.queueRetry = retry;
  }

  useRound(round: StartRounding): void {
    this.round = round;
  }

  /** The members a stored deferred start of the project waits for (`FocusPull` leaves them out: they are not free). */
  membersWaitedFor(projectKey: string): Set<string> {
    const members = new Set<string>();
    for (const { start, waiting } of this.deferred.list()) {
      if (start.projectKey !== projectKey) continue;
      const waitsFor = start.waitsFor();
      if (waitsFor) members.add(waitsFor);
      if (waiting.member) members.add(waiting.member);
      // A Senior card waits for its Seniors (PM-348): a freed Senior goes to it, not to a pulled card.
      for (const senior of waiting.seniors ?? []) members.add(senior);
    }
    return members;
  }

  /** Whether this start waits in the deferred-start store now. */
  isWaiting(start: AutomaticStart): boolean {
    return this.deferred.list().some((entry) => entry.start === start);
  }

  /** A task move or closure drops the starts it made obsolete, even if the task later returns. */
  discardStale(task: Task): void {
    this.deferred.discardStale(task);
  }

  private hasLiveScheduledRun(projectKey: string, handle: string): boolean {
    return this.sessions
      .list(projectKey, { member: handle })
      .some((s) => s.workItem.type === 'schedule' && this.sessions.isRunning(s.id));
  }

  /** The project's configuration (read once per project in `known`); null when it cannot be read. */
  private async configOf(
    projectKey: string,
    known: Map<string, ProjectConfig | null>,
  ): Promise<ProjectConfig | null> {
    let config = known.get(projectKey);
    if (config === undefined) {
      config = await this.projects.config(projectKey).catch(() => null);
      known.set(projectKey, config);
    }
    return config;
  }

  private taskOf(start: AutomaticStart): Task | null {
    const task = start.taskKey ? this.ctx.repos.tasks.get(start.taskKey) : null;
    return task && task.projectKey === start.projectKey ? task : null;
  }

  private async publishingWaitingChanges<T>(taskKey: string | null, fn: () => Promise<T>): Promise<T> {
    const task = taskKey ? this.ctx.repos.tasks.get(taskKey) : null;
    const before = task ? JSON.stringify(this.deferred.waitingFor(task)) : undefined;
    try {
      return await fn();
    } finally {
      const latest = taskKey ? this.ctx.repos.tasks.get(taskKey) : null;
      if (latest && before !== JSON.stringify(this.deferred.waitingFor(latest))) this.tasks.publish(latest);
    }
  }
}
