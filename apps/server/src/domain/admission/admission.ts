import { DEFAULT_AGENT_PROVIDER, isOpenTask } from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig, Task, WorkItemRef } from '@projectman/shared';
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
import { assertAiEnabled, assertRepoChosen, isDeferrable, waitingOf } from './rules';

export interface AdmissionRequest {
  config: ProjectConfig;
  /** The AI member that would work; none for a temp worker yet to be hired (the default provider runs it). */
  member?: AiMemberConfig;
  /** What the session is for: its task is not counted in the member's load. */
  workItem?: WorkItemRef;
  /** Whether the member's capacity applies (default true); a task's assignee keeps working on it. */
  capacity?: boolean;
  /**
   * The message that causes the start, typed in as the first input of a session that resumes its
   * conversation (see `SessionOrchestrator.ensureSession`).
   */
  message?: string;
}

/**
 * Admission: every AI session start that no person asked for directly (task start, stage
 * hand-over, message wake-up, schedule run) passes the same checks, in this order: the
 * project's AI master switch; for a task, that a role which changes files has a repository to
 * work in (`repo_required`: a person has to choose it, so waiting does not help); for a scheduled
 * run, the member's previous run has ended; the member's capacity (open tasks it carries plus its
 * other running chats); the concurrent AI sessions (`maxConcurrentAi`); the plan usage of the
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

  /** Open tasks a member carries (tasks it has a session for or is assigned to) plus its other running chats. */
  memberLoad(projectKey: string, handle: string, excludeTaskKey?: string): number {
    const keys = new Set<string>();
    for (const s of this.sessions.list(projectKey, { member: handle })) {
      if (s.workItem.type === 'task') keys.add(s.workItem.taskKey);
    }
    for (const t of this.ctx.repos.tasks.listByAssignee(projectKey, handle)) keys.add(t.key);
    if (excludeTaskKey) keys.delete(excludeTaskKey);
    let load = 0;
    for (const key of keys) {
      const task = this.ctx.repos.tasks.get(key);
      if (task && isOpenTask(task)) load++;
    }
    return (
      load +
      this.sessions
        .list(projectKey, { member: handle })
        .filter((s) => s.workItem.type !== 'task' && this.sessions.isRunning(s.id)).length
    );
  }

  /** Throws the refusal when the work must wait (see the class comment for the checks). */
  async check(request: AdmissionRequest): Promise<void> {
    const { config, member, workItem } = request;
    const projectKey = config.project.key;
    assertAiEnabled(config);
    if (workItem?.type === 'task') {
      // A temp worker yet to be hired has the role the limits name for it.
      const role = member?.role ?? config.team.limits.tempWorkers.role;
      assertRepoChosen(config, role, this.ctx.repos.tasks.get(workItem.taskKey));
    }
    if (member && workItem?.type === 'schedule' && this.hasLiveScheduledRun(projectKey, member.handle))
      throw conflict('previous_run_live', `the previous scheduled run of ${member.handle} is still live`);
    if (member && request.capacity !== false) {
      const excluded = workItem?.type === 'task' ? workItem.taskKey : undefined;
      if (this.memberLoad(projectKey, member.handle, excluded) >= member.capacity)
        throw conflict('member_at_capacity', `${member.handle} is at capacity (${member.capacity})`, {
          capacity: member.capacity,
        });
    }
    const max = config.team.limits.maxConcurrentAi;
    const busy = this.sessions.busyCount();
    if (busy >= max) {
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
      return { session: running, created: false, resumed: false, started: false, messageSent: false };
    await this.check(request);
    return this.sessions.ensureSession(projectKey, request.member.handle, request.workItem, {
      message: request.message,
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
          if (!isDeferrable(err)) {
            this.deferred.drop(start.key);
            throw err;
          }
          this.deferred.keep({
            start,
            waiting: waitingOf(err, { member: start.waitsFor(), previous: since, at: isoNow(this.ctx) }),
          });
          this.ctx.logger.info({ ...start.log.fields(), reason: err.code }, start.log.deferred);
          return;
        }
        // The start happened, or it no longer applies.
        this.deferred.drop(start.key);
      }),
    );
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
   * the project's master switch is left alone while the switch is off: a retry could only be
   * refused and logged again, and turning the switch on retries it.
   */
  async retryDeferred(): Promise<void> {
    const switches = new Map<string, boolean>();
    for (const entry of this.deferred.list()) {
      if (!this.deferred.holds(entry)) continue;
      const { start } = entry;
      const task = this.taskOf(start);
      if (start.taskKey !== null && (!task || !start.stillValid(task))) {
        this.deferred.drop(start.key);
        if (task) this.tasks.publish(task);
        continue;
      }
      if (entry.waiting.reason === 'ai_disabled' && !(await this.aiEnabled(start.projectKey, switches)))
        continue;
      try {
        await start.retry();
      } catch (err) {
        this.ctx.logger.warn({ err, ...start.log.fields() }, start.log.retryFailed);
      }
    }
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

  /** Whether the project's AI master switch is on (read once per project in `known`); on when it cannot be read. */
  private async aiEnabled(projectKey: string, known: Map<string, boolean>): Promise<boolean> {
    let enabled = known.get(projectKey);
    if (enabled === undefined) {
      enabled = await this.projects.config(projectKey).then(
        (config) => config.team.limits.aiEnabled,
        () => true,
      );
      known.set(projectKey, enabled);
    }
    return enabled;
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
