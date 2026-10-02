import {
  aiLimitReached,
  DEFAULT_AGENT_PROVIDER,
  isHandleOnLeave,
  isOpenTask,
  isTheme,
  isWorkingOnTask,
  openPrerequisites,
} from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig, Task, TaskStartWaiting, WorkItemRef } from '@projectman/shared';
import { isoNow } from '../context';
import type { DomainContext } from '../context';
import { conflict } from '../errors';
import { highestUsagePercent } from '../plan-usage';
import type { PlanUsageCache } from '../plan-usage';
import type { ProjectService } from '../projects';
import type { EnsureSessionResult, SessionOrchestrator } from '../sessions';
import type { TaskService } from '../tasks';
import { KeyedMutex } from '../util';
import type { AutomaticStart, DeferredStarts, StartSpec } from './deferred-starts';
import { assertAiEnabled, assertNotOnLeave, assertRepoChosen, isDeferrable, waitingOf } from './rules';

export interface AdmissionRequest {
  config: ProjectConfig;
  /** The AI member that would work; none for a temp worker yet to be hired (the default provider runs it). */
  member?: AiMemberConfig;
  /** What the session is for: its task is not counted in the member's load. */
  workItem?: WorkItemRef;
  /** Whether the member's capacity applies (default true); a task's assignee keeps working on it. */
  capacity?: boolean;
  /**
   * The messages that cause the start, oldest first, as they are typed in: the session takes them
   * in its first input (see `SessionOrchestrator.ensureSession`).
   */
  messages?: string[];
}

/**
 * Admission: every AI session start that no person asked for directly (task start, stage
 * hand-over, message wake-up, schedule run) passes the same checks, in this order: the
 * project's AI master switch; that the member is not on leave (`member_on_leave`, decision 23);
 * for a task, that a role which changes files has a repository to
 * work in (`repo_required`: a person has to choose it, so waiting does not help); for a scheduled
 * run, the member's previous run has ended; the member's capacity (open tasks it has a running session for plus its
 * other running chats); the concurrent AI sessions (`maxConcurrentAi`, when the project sets
 * one: there is no cap otherwise); the plan usage of the
 * member's provider. Decisions and the starts they allow are serialized. An automatic start
 * refused for a reason that can clear waits in the deferred-start store, which SQLite backs, and
 * is retried.
 */
export class Admission {
  private readonly ctx: DomainContext;
  private readonly sessions: SessionOrchestrator;
  private readonly planUsage: Pick<PlanUsageCache, 'get'>;
  private readonly tasks: TaskService;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly deferred: DeferredStarts;
  private readonly locks = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    sessions: SessionOrchestrator;
    planUsage: Pick<PlanUsageCache, 'get'>;
    tasks: TaskService;
    projects: Pick<ProjectService, 'config'>;
    deferred: DeferredStarts;
  }) {
    this.ctx = deps.ctx;
    this.sessions = deps.sessions;
    this.planUsage = deps.planUsage;
    this.tasks = deps.tasks;
    this.projects = deps.projects;
    this.deferred = deps.deferred;
  }

  /** Runs `fn` alone among admission decisions and the starts they allow (across projects). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.run('ai-admission', fn);
  }

  /**
   * What a member is working on now (decision 19): the open tasks it has a running session for
   * that it works on (see `isWorkingOnTask`: a session idling after the member handed the task
   * on does not count), plus its other running chats. A finished session, or an assignment
   * without a running session, does not count.
   */
  memberLoad(config: ProjectConfig, handle: string, excludeTaskKey?: string): number {
    const taskKeys = new Set<string>();
    let chats = 0;
    for (const s of this.sessions.list(config.project.key, { member: handle })) {
      if (!this.sessions.isRunning(s.id)) continue;
      if (s.workItem.type !== 'task') chats++;
      else if (s.workItem.taskKey !== excludeTaskKey) {
        const task = this.ctx.repos.tasks.get(s.workItem.taskKey);
        if (task && isOpenTask(task) && !isTheme(task) && isWorkingOnTask(config, task, handle, s.state))
          taskKeys.add(task.key);
      }
    }
    return chats + taskKeys.size;
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
    if (aiLimitReached(config, busy)) {
      const max = config.team.limits.maxConcurrentAi;
      throw conflict('ai_limit_reached', `${busy} AI sessions are working (limit ${max})`, { busy, max });
    }
    const provider = member?.provider ?? DEFAULT_AGENT_PROVIDER;
    const percent = highestUsagePercent(await this.planUsage.get(provider));
    const threshold = config.team.limits.pauseAbovePlanUsagePercent;
    if (percent !== null && percent > threshold) {
      throw conflict(
        'plan_usage_paused',
        `${provider} plan usage is ${percent}% (pause above ${threshold}%)`,
        { percent, threshold, provider },
      );
    }
  }

  /** The member's session for the work item: the running one, else one admission allows. */
  async start(
    request: AdmissionRequest & { member: AiMemberConfig; workItem: WorkItemRef },
  ): Promise<EnsureSessionResult> {
    const projectKey = request.config.project.key;
    const running = this.sessions.findRunning(projectKey, request.member.handle, request.workItem);
    if (running)
      return {
        session: running,
        created: false,
        resumed: false,
        started: false,
        messagesSent: 0,
        firstInput: Promise.resolve(true),
      };
    await this.check(request);
    return this.sessions.ensureSession(projectKey, request.member.handle, request.workItem, {
      messages: request.messages,
    });
  }

  /**
   * One attempt of an automatic start, alone among admission decisions. A refusal that can
   * clear keeps the start, with why it waits, for the retry loop; other failures propagate.
   * Its task is published again when why it waits changed.
   */
  async attempt(start: AutomaticStart): Promise<void> {
    await this.exclusive(() =>
      this.publishingWaitingChanges(start.taskKey, async () => {
        // The previous deferral of this start stays stored until the attempt settles.
        const previous = this.deferred.take(start.key);
        const since = previous?.start.stillValid(this.taskOf(start)) ? previous.waiting : undefined;
        try {
          await start.run();
        } catch (err) {
          if (!isDeferrable(err, start.defers)) {
            this.deferred.drop(start.key);
            throw err;
          }
          this.deferred.keep({
            start,
            waiting: waitingOf(err, { member: start.waitsFor(), previous: since, at: isoNow(this.ctx) }),
          });
          // Capacity-freeing events retry often: it is said when the reason is new, not at every refusal that stays.
          if (previous?.waiting.reason !== err.code)
            this.ctx.logger.info({ ...start.log.fields(), reason: err.code }, start.log.deferred);
          return;
        }
        // The start happened, or it no longer applies.
        this.deferred.drop(start.key);
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
    if (restored + removed > 0)
      this.ctx.logger.info({ restored, removed }, 'deferred session starts restored');
    return restored;
  }

  /**
   * Retries the deferred starts that still apply; the others are dropped. A start that waits for
   * the project's master switch is left alone while the switch is off, and one that waits for a
   * member on leave while the member is away: a retry could only be refused and logged again,
   * and turning the switch on or calling the member back retries them.
   */
  async retryDeferred(): Promise<void> {
    const configs = new Map<string, ProjectConfig | null>();
    for (const entry of this.deferred.list()) {
      if (!this.deferred.holds(entry)) continue;
      const { start } = entry;
      const task = this.taskOf(start);
      if (start.taskKey !== null && (!task || !start.stillValid(task))) {
        this.deferred.drop(start.key);
        if (task) this.tasks.publish(task);
        continue;
      }
      const { reason, member } = entry.waiting;
      if (reason === 'ai_disabled' || reason === 'member_on_leave') {
        const config = await this.configOf(start.projectKey, configs);
        if (
          config &&
          (reason === 'ai_disabled' ? !config.team.limits.aiEnabled : isHandleOnLeave(config, member))
        )
          continue;
      }
      // A start that waits for prerequisites is retried when the open ones change (one closed, a
      // relation removed): with the same ones open, a retry could only be refused again.
      if (reason === 'prerequisite_open' && task) {
        const open = openPrerequisites(task, this.tasks.list(task.projectKey)).map((card) => card.key);
        const waiting = entry.waiting.prerequisites ?? [];
        if (open.length > 0 && open.length === waiting.length && open.every((key) => waiting.includes(key)))
          continue;
      }
      // A start that waits for labels is retried once the gate lets the card through (the labels are
      // on, or the gate no longer asks for them).
      if (reason === 'label_missing' && task && start.blocked) {
        const config = await this.configOf(start.projectKey, configs);
        if (config && start.blocked(task, config)) continue;
      }
      try {
        await start.retry();
      } catch (err) {
        this.ctx.logger.warn({ err, ...start.log.fields() }, start.log.retryFailed);
      }
    }
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

  private async publishingWaitingChanges(taskKey: string | null, fn: () => Promise<void>): Promise<void> {
    const task = taskKey ? this.ctx.repos.tasks.get(taskKey) : null;
    const before = task ? JSON.stringify(this.deferred.waitingFor(task)) : undefined;
    try {
      await fn();
    } finally {
      const latest = taskKey ? this.ctx.repos.tasks.get(taskKey) : null;
      if (latest && before !== JSON.stringify(this.deferred.waitingFor(latest))) this.tasks.publish(latest);
    }
  }
}
