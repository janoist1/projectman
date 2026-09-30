import { DEFAULT_AGENT_PROVIDER } from '@projectman/shared';
import type {
  Actor,
  AgentProvider,
  AiMemberConfig,
  MemberConfig,
  ProjectConfig,
  Session,
  Stage,
  Task,
  WorkItemRef,
} from '@projectman/shared';
import { ownerHandles } from './access';
import type { DomainContext } from './context';
import { encodeWorkItem } from '../db';
import { conflict, DomainError, invalid, notFound } from './errors';
import { formatInjectedTeamMessage, stageOwners, roleBundle } from '@projectman/shared';
import type { TaskStartWaiting } from '@projectman/shared';
import { isoNow } from './context';
import { evaluateMove, stageIndex } from './gates';
import type { MemberService } from './members';
import { highestUsagePercent } from './plan-usage';
import type { PlanUsageCache } from './plan-usage';
import type { Author, ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import { approvalRequestedError, gateBlockedError, isOpenTask } from './tasks';
import type { StageChange, TaskService } from './tasks';
import { KeyedMutex, SYSTEM_ACTOR, SYSTEM_AUTHOR } from './util';

/** Admission refusals that a later retry can overcome. */
const DEFERRABLE_CODES = new Set([
  'ai_limit_reached',
  'plan_usage_paused',
  'ai_disabled',
  'member_at_capacity',
]);

interface DeferredMessageStart {
  waiting: TaskStartWaiting;
  projectKey: string;
  handle: string;
  workItem: WorkItemRef;
  stageId?: string;
}

export interface StartTaskOptions {
  /** Explicit assignee; omitted = the current assignee, else a free developer, else a temp worker. */
  assignee?: string;
  actor: Actor;
  author: Author;
  /** Human who sponsors a temp worker hired for this task (defaults to the first owner). */
  sponsor?: string;
}

export interface StartTaskResult {
  task: Task;
  session: Session | null;
  /** Temp worker hired for this task, if any. */
  hired: AiMemberConfig | null;
}

/**
 * Starts tasks: picks the developer (capacity = open tasks the member carries), respects
 * the team limits (concurrent AI sessions, plan usage), hires a temp worker when allowed,
 * assigns, moves the task into the first work stage and starts the developer's session
 * (the context pack's brief is its first message).
 */
export class Scheduler {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly members: MemberService;
  private readonly sessions: SessionOrchestrator;
  private readonly planUsage: PlanUsageCache;
  private readonly locks = new KeyedMutex();
  /** Hand-overs refused by admission limits, by `projectKey:taskKey`. */
  private readonly deferredHandOffs = new Map<string, StageChange & { waiting: TaskStartWaiting }>();
  /** Message starts by project, recipient and work item; messages themselves stay in SQLite. */
  private readonly deferredMessages = new Map<string, DeferredMessageStart>();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    members: MemberService;
    sessions: SessionOrchestrator;
    planUsage: PlanUsageCache;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.members = deps.members;
    this.sessions = deps.sessions;
    this.planUsage = deps.planUsage;
    this.tasks.setStartWaitingReader((task) => this.waitingFor(task));
  }

  private waitingFor(task: Task): TaskStartWaiting | undefined {
    const entries = [
      ...[...this.deferredHandOffs.values()].filter(
        (entry) =>
          entry.task.projectKey === task.projectKey &&
          entry.task.key === task.key &&
          entry.to === task.stageId &&
          task.status === 'active',
      ),
      ...[...this.deferredMessages.values()].filter(
        (entry) =>
          entry.projectKey === task.projectKey &&
          entry.workItem.type === 'task' &&
          entry.workItem.taskKey === task.key &&
          entry.stageId === task.stageId &&
          isOpenTask(task),
      ),
    ];
    return entries.map((entry) => entry.waiting).sort((a, b) => a.since.localeCompare(b.since))[0];
  }

  private refusal(err: DomainError, previous?: TaskStartWaiting, member?: string): TaskStartWaiting {
    const details = err.details as { provider?: AgentProvider; threshold?: number } | undefined;
    return {
      reason: err.code as TaskStartWaiting['reason'],
      member,
      ...(err.code === 'plan_usage_paused'
        ? { provider: details?.provider, threshold: details?.threshold }
        : {}),
      since: previous?.since ?? isoNow(this.ctx),
    };
  }

  private async publishWaitingChanges(taskKey: string | undefined, fn: () => Promise<void>): Promise<void> {
    const task = taskKey ? this.ctx.repos.tasks.get(taskKey) : null;
    const before = task ? JSON.stringify(this.waitingFor(task)) : undefined;
    try {
      await fn();
    } finally {
      const latest = taskKey ? this.ctx.repos.tasks.get(taskKey) : null;
      if (latest && before !== JSON.stringify(this.waitingFor(latest))) this.tasks.publish(latest);
    }
  }

  /** Open tasks a member carries: tasks it has a session for or is assigned to. */
  memberLoad(projectKey: string, handle: string, excludeTaskKey?: string): number {
    const keys = new Set<string>();
    for (const s of this.ctx.repos.sessions.list(projectKey, { member: handle })) {
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

  /**
   * Throws when new AI work must wait: too many working sessions, or the plan usage of the
   * provider that would run the work (the member's own subscription) is too high.
   */
  async assertCanStartAiWork(
    config: ProjectConfig,
    provider: AgentProvider = DEFAULT_AGENT_PROVIDER,
  ): Promise<void> {
    if (!config.team.limits.aiEnabled)
      throw conflict('ai_disabled', 'AI work is switched off in this project');
    const max = config.team.limits.maxConcurrentAi;
    const busy = this.sessions.busyCount();
    if (busy >= max) {
      throw conflict('ai_limit_reached', `${busy} AI sessions are working (limit ${max})`, { busy, max });
    }
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

  admit<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.run('ai-admission', fn);
  }

  async startConversation(projectKey: string, handle: string): Promise<Session> {
    return this.startMessageSession(projectKey, handle, { type: 'general' });
  }

  /** Admission for a message that needs a task or general session. */
  async startMessageSession(projectKey: string, handle: string, workItem: WorkItemRef): Promise<Session> {
    return this.admit(() => this.startMessageSessionAdmitted(projectKey, handle, workItem));
  }

  private async startMessageSessionAdmitted(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
  ): Promise<Session> {
    const config = await this.projects.config(projectKey);
    const member = config.team.members.find((m) => m.handle === handle);
    if (!member) throw notFound('member', handle);
    if (member.kind !== 'ai') throw invalid('not_ai_member', 'Conversations require an AI member');
    const running = this.sessions.findRunning(projectKey, handle, workItem);
    if (running) return running;
    if (
      this.memberLoad(projectKey, handle, workItem.type === 'task' ? workItem.taskKey : undefined) >=
      member.capacity
    )
      throw conflict('member_at_capacity', `${handle} is at capacity`, { capacity: member.capacity });
    await this.assertCanStartAiWork(config, member.provider ?? DEFAULT_AGENT_PROVIDER);
    return (await this.sessions.ensureSession(projectKey, handle, workItem)).session;
  }

  /** Automatic message starts retain only admission refusals that can clear. */
  async startQueuedMessageSession(projectKey: string, handle: string, workItem: WorkItemRef): Promise<void> {
    const wi = encodeWorkItem(workItem);
    const key = `${projectKey}:${handle}:${wi.type}:${wi.ref}`;
    await this.admit(() =>
      this.publishWaitingChanges(workItem.type === 'task' ? workItem.taskKey : undefined, async () => {
        const previous = this.deferredMessages.get(key);
        this.deferredMessages.delete(key);
        const config = await this.projects.config(projectKey);
        if (!config.team.members.some((m) => m.handle === handle && m.kind === 'ai')) return;
        const task = workItem.type === 'task' ? this.tasks.get(projectKey, workItem.taskKey) : null;
        if (task && (!isOpenTask(task) || (previous && previous.stageId !== task.stageId))) return;
        const pending = this.ctx.repos.messages
          .pending(projectKey, handle)
          .filter((m) => m.taskKey === (workItem.type === 'task' ? workItem.taskKey : null));
        if (pending.length === 0) return;
        try {
          const session = await this.startMessageSessionAdmitted(projectKey, handle, workItem);
          // A concurrently started session may already have queued these messages; delivery is deduplicated.
          for (const message of pending) {
            const latest = this.ctx.repos.messages.get(message.id);
            if (latest && !latest.receipts?.find((r) => r.handle === handle)?.deliveredAt)
              this.sessions.deliverTeamMessage(session, latest);
          }
        } catch (err) {
          if (!(err instanceof DomainError && DEFERRABLE_CODES.has(err.code))) throw err;
          this.deferredMessages.set(key, {
            projectKey,
            handle,
            workItem,
            stageId: task?.stageId,
            waiting: this.refusal(err, previous?.waiting, handle),
          });
          this.ctx.logger.info(
            { projectKey, member: handle, reason: err.code },
            'team message start deferred',
          );
        }
      }),
    );
  }

  /** A task move or closure invalidates waiting starts, even if it later returns to that stage. */
  discardStaleTaskStarts(task: Task): void {
    const handOffKey = `${task.projectKey}:${task.key}`;
    const change = this.deferredHandOffs.get(handOffKey);
    if (change && (change.to !== task.stageId || task.status !== 'active'))
      this.deferredHandOffs.delete(handOffKey);
    for (const [key, entry] of this.deferredMessages) {
      if (
        entry.projectKey !== task.projectKey ||
        entry.workItem.type !== 'task' ||
        entry.workItem.taskKey !== task.key
      )
        continue;
      if (entry.stageId !== task.stageId || !isOpenTask(task)) this.deferredMessages.delete(key);
    }
  }

  async startTask(projectKey: string, taskKey: string, opts: StartTaskOptions): Promise<StartTaskResult> {
    return this.admit(async () => {
      const config = await this.projects.config(projectKey);
      let task = this.tasks.get(projectKey, taskKey);
      if (!isOpenTask(task)) throw conflict('task_closed', `task ${taskKey} is ${task.status}`);
      const workStage =
        config.pipeline.stages.find((s) => s.id === task.stageId && s.kind === 'work') ??
        config.pipeline.stages.find((s) => s.kind === 'work');
      if (!workStage) throw invalid('no_work_stage', 'the pipeline has no work stage');
      const needsMove = stageIndex(config.pipeline, task.stageId) < stageIndex(config.pipeline, workStage.id);

      let member: MemberConfig | null = this.chooseMember(config, task, opts.assignee);
      const alreadyRunning =
        member?.kind === 'ai' &&
        this.sessions.findRunning(projectKey, member.handle, { type: 'task', taskKey });
      // A temp worker (no member yet) is hired with the default provider.
      if ((member === null || member.kind === 'ai') && !alreadyRunning)
        await this.assertCanStartAiWork(
          config,
          member?.kind === 'ai' ? (member.provider ?? DEFAULT_AGENT_PROVIDER) : DEFAULT_AGENT_PROVIDER,
        );

      if (needsMove) {
        const evaluation = evaluateMove(task, config, task.stageId, workStage.id);
        if (evaluation.unmet.length > 0) throw gateBlockedError(evaluation);
        if (evaluation.approvals.length > 0) {
          const result = await this.tasks.moveToStage(projectKey, taskKey, workStage.id, opts.actor);
          throw approvalRequestedError(result.pendingApproval);
        }
      }

      let hired: AiMemberConfig | null = null;
      if (!member) {
        const temp = config.team.limits.tempWorkers;
        const tempCount = config.team.members.filter((m) => m.kind === 'ai' && m.temp).length;
        if (
          !temp.enabled ||
          tempCount >= temp.max ||
          (workStage.duty && !roleBundle(config, temp.role).duties.includes(workStage.duty))
        ) {
          throw conflict('no_free_member', 'every developer is at capacity', {
            tempWorkersEnabled: temp.enabled,
            tempWorkers: tempCount,
            tempWorkersMax: temp.max,
          });
        }
        const sponsor = opts.sponsor ?? ownerHandles(config)[0];
        if (!sponsor) throw conflict('no_free_member', 'no human can sponsor a temp worker');
        hired = await this.members.hire(
          projectKey,
          { role: temp.role },
          { actor: opts.actor, author: opts.author, sponsor },
          { temp: true, stageId: workStage.owners !== undefined ? workStage.id : undefined },
        );
        member = hired;
      }

      if (task.assignee !== member.handle)
        task = this.tasks.assign(projectKey, taskKey, member.handle, opts.actor);
      if (needsMove) {
        const result = await this.tasks.moveToStage(projectKey, taskKey, workStage.id, opts.actor);
        if (!result.moved) throw approvalRequestedError(result.pendingApproval);
      }
      let session: Session | null = null;
      if (member.kind === 'ai') {
        session = (await this.sessions.ensureSession(projectKey, member.handle, { type: 'task', taskKey }))
          .session;
      }
      return { task: this.tasks.get(projectKey, taskKey), session, hired };
    });
  }

  /**
   * Stage change listener: a task entering a later stage owned by AI members (review, QA,
   * deploy, release, …) gets a session for the least loaded free owner, so work does not stall
   * when a human moved the task or approved the release. The kick-off brief carries the stage
   * rules. An owner already working the task (e.g. reached by a hand-over message) is enough;
   * work stages start through startTask. Admission limits apply: a refused hand-over is kept
   * and retried by retryDeferredHandOffs while the task stays in that stage.
   */
  async handOffToStageOwner(change: StageChange): Promise<void> {
    await this.admit(() =>
      this.publishWaitingChanges(change.task.key, async () => {
        const key = `${change.task.projectKey}:${change.task.key}`;
        const previous = this.deferredHandOffs.get(key);
        this.deferredHandOffs.delete(key);
        const task = this.tasks.get(change.task.projectKey, change.task.key);
        if (task.stageId !== change.to || task.status !== 'active') return;
        change = { ...change, task };
        const projectKey = task.projectKey;
        const workItem = { type: 'task', taskKey: task.key } as const;
        const config = await this.projects.config(projectKey);
        const stage = config.pipeline.stages.find((s) => s.id === change.to);
        if (!stage || stage.kind === 'queue' || stage.kind === 'done') return;
        if (stage.kind === 'work') {
          // Back to work: startTask resumes the assignee; a live session hears of it.
          if (task.assignee) await this.notifyStageOwner(change, stage, task.assignee);
          return;
        }
        // The assignee never takes over a later stage: no self-review.
        const owners = stageOwners(config, stage)
          .map((handle) => config.team.members.find((m) => m.handle === handle))
          .filter((m): m is AiMemberConfig => m?.kind === 'ai' && m.handle !== task.assignee);
        if (owners.length === 0) return;
        const running = owners.find((m) => this.sessions.findRunning(projectKey, m.handle, workItem));
        if (running) return this.notifyStageOwner(change, stage, running.handle);
        let selected: AiMemberConfig | undefined;
        try {
          const free = owners
            .map((member) => ({ member, load: this.memberLoad(projectKey, member.handle, task.key) }))
            .filter(({ member, load }) => load < member.capacity)
            .sort((a, b) => a.load - b.load)[0]?.member;
          selected = free ?? (owners.length === 1 ? owners[0] : undefined);
          if (!free) throw conflict('member_at_capacity', 'Every stage owner is at capacity');
          await this.assertCanStartAiWork(config, free.provider ?? DEFAULT_AGENT_PROVIDER);
          const result = await this.sessions.ensureSession(projectKey, free.handle, workItem);
          // Resumed sessions get no brief, so tell them which stage the task is in now.
          if (result.resumed) await this.notifyStageOwner(change, stage, free.handle);
        } catch (err) {
          if (!(err instanceof DomainError && DEFERRABLE_CODES.has(err.code))) throw err;
          this.deferredHandOffs.set(key, {
            ...change,
            waiting: this.refusal(err, previous?.waiting, selected?.handle),
          });
          this.ctx.logger.info(
            { taskKey: task.key, stage: stage.id, reason: err.code },
            'stage hand-over deferred',
          );
        }
      }),
    );
  }

  /** Tells a member's live task session that the task entered its stage, unless it moved it itself. */
  private async notifyStageOwner(change: StageChange, stage: Stage, handle: string): Promise<void> {
    if (change.actor.kind === 'ai' && change.actor.handle === handle) return;
    const { task } = change;
    const session = this.sessions.findRunning(task.projectKey, handle, { type: 'task', taskKey: task.key });
    if (!session) return;
    this.sessions.deliver(
      session,
      formatInjectedTeamMessage(
        change.actor.handle ?? 'projectman',
        `Task ${task.key} is now in stage ${stage.name} (\`${stage.id}\`). ` +
          'You own this stage: do your part by its rules; get_task shows the latest state.',
        task.key,
      ),
    );
  }

  /** Compatibility entry point; the periodic retry now covers messages as well. */
  async retryDeferredHandOffs(): Promise<void> {
    await this.retryDeferredStarts();
  }

  /** Retries applicable admission refusals; permanent failures are removed. */
  async retryDeferredStarts(): Promise<void> {
    for (const [key, change] of [...this.deferredHandOffs]) {
      if (this.deferredHandOffs.get(key) !== change) continue;
      let task: Task;
      try {
        task = this.tasks.get(change.task.projectKey, change.task.key);
      } catch {
        this.deferredHandOffs.delete(key);
        continue;
      }
      if (task.stageId !== change.to || task.status !== 'active') {
        this.deferredHandOffs.delete(key);
        this.tasks.publish(task);
        continue;
      }
      try {
        await this.handOffToStageOwner({ ...change, task });
      } catch (err) {
        this.ctx.logger.warn({ err, taskKey: task.key }, 'stage hand-over retry failed');
      }
    }
    for (const [key, entry] of [...this.deferredMessages]) {
      if (this.deferredMessages.get(key) !== entry) continue;
      try {
        await this.startQueuedMessageSession(entry.projectKey, entry.handle, entry.workItem);
      } catch (err) {
        this.ctx.logger.warn({ err, member: entry.handle }, 'team message start retry failed');
      }
    }
  }

  /** Stage change listener: a temp worker is retired once its task is done. */
  async retireFinishedTempWorker(change: StageChange): Promise<void> {
    const { task } = change;
    if (task.status !== 'done' || !task.assignee) return;
    const config = await this.projects.config(task.projectKey);
    const member = config.team.members.find((m) => m.handle === task.assignee);
    if (member?.kind !== 'ai' || !member.temp) return;
    if (this.memberLoad(task.projectKey, member.handle) > 0) return;
    await this.members.retire(
      task.projectKey,
      member.handle,
      {},
      { actor: SYSTEM_ACTOR, author: SYSTEM_AUTHOR },
    );
  }

  private chooseMember(config: ProjectConfig, task: Task, assignee: string | undefined): MemberConfig | null {
    const projectKey = config.project.key;
    const stage =
      config.pipeline.stages.find((s) => s.id === task.stageId && s.kind === 'work') ??
      config.pipeline.stages.find((s) => s.kind === 'work');
    const eligible = stage ? stageOwners(config, stage) : [];
    if (assignee) {
      const member = config.team.members.find((m) => m.handle === assignee);
      if (!member) throw notFound('member', assignee);
      if (!eligible.includes(member.handle))
        throw invalid('not_stage_owner', 'assignee must own the work stage');
      if (member.kind === 'ai' && this.memberLoad(projectKey, member.handle, task.key) >= member.capacity) {
        throw conflict('member_at_capacity', `${assignee} is at capacity (${member.capacity})`, {
          capacity: member.capacity,
        });
      }
      return member;
    }
    if (task.assignee) {
      const current = config.team.members.find((m) => m.handle === task.assignee);
      if (current && eligible.includes(current.handle)) return current;
    }
    const candidates = config.team.members
      .map((m, index) => ({ m, index }))
      .filter(
        (c): c is { m: AiMemberConfig; index: number } => c.m.kind === 'ai' && eligible.includes(c.m.handle),
      )
      .map((c) => ({ ...c, load: this.memberLoad(projectKey, c.m.handle) }))
      .filter((c) => c.load < c.m.capacity && !(c.m.temp && c.load > 0))
      .sort((a, b) => a.load - b.load || a.index - b.index);
    return (
      candidates[0]?.m ??
      config.team.members.find((m) => m.kind === 'human' && eligible.includes(m.handle)) ??
      null
    );
  }
}
