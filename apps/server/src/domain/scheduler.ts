import type { Actor, AiMemberConfig, MemberConfig, ProjectConfig, Session, Task } from '@projectman/shared';
import { ownerHandles } from './access';
import type { DomainContext } from './context';
import { conflict, invalid, notFound } from './errors';
import { evaluateGates, stageIndex, stagesEntered } from './gates';
import type { MemberService } from './members';
import { highestUsagePercent } from './plan-usage';
import type { PlanUsageCache } from './plan-usage';
import type { Author, ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import { approvalRequestedError, gateBlockedError, isOpenTask } from './tasks';
import type { StageChange, TaskService } from './tasks';
import { KeyedMutex, SYSTEM_ACTOR, SYSTEM_AUTHOR } from './util';

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
    return load;
  }

  /** Throws when new AI work must wait: too many working sessions or plan usage too high. */
  async assertCanStartAiWork(config: ProjectConfig): Promise<void> {
    const max = config.team.limits.maxConcurrentAi;
    const busy = this.sessions.busyCount();
    if (busy >= max) {
      throw conflict('ai_limit_reached', `${busy} AI sessions are working (limit ${max})`, { busy, max });
    }
    const percent = highestUsagePercent(await this.planUsage.get());
    const threshold = config.team.limits.pauseAbovePlanUsagePercent;
    if (percent !== null && percent > threshold) {
      throw conflict('plan_usage_paused', `plan usage is ${percent}% (pause above ${threshold}%)`, {
        percent,
        threshold,
      });
    }
  }

  async startTask(projectKey: string, taskKey: string, opts: StartTaskOptions): Promise<StartTaskResult> {
    return this.locks.run(`schedule:${projectKey}`, async () => {
      const config = await this.projects.config(projectKey);
      let task = this.tasks.get(projectKey, taskKey);
      if (!isOpenTask(task)) throw conflict('task_closed', `task ${taskKey} is ${task.status}`);
      const workStage = config.pipeline.stages.find((s) => s.kind === 'work');
      if (!workStage) throw invalid('no_work_stage', 'the pipeline has no work stage');
      const needsMove = stageIndex(config.pipeline, task.stageId) < stageIndex(config.pipeline, workStage.id);

      let member: MemberConfig | null = this.chooseMember(config, task, opts.assignee);
      const alreadyRunning =
        member?.kind === 'ai' &&
        this.sessions.findRunning(projectKey, member.handle, { type: 'task', taskKey });
      if ((member === null || member.kind === 'ai') && !alreadyRunning)
        await this.assertCanStartAiWork(config);

      if (needsMove) {
        const evaluation = evaluateGates(task, stagesEntered(config.pipeline, task.stageId, workStage.id));
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
        if (!temp.enabled || tempCount >= temp.max) {
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
          { temp: true },
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
    if (assignee) {
      const member = config.team.members.find((m) => m.handle === assignee);
      if (!member) throw notFound('member', assignee);
      if (member.kind === 'ai' && this.memberLoad(projectKey, member.handle, task.key) >= member.capacity) {
        throw conflict('member_at_capacity', `${assignee} is at capacity (${member.capacity})`, {
          capacity: member.capacity,
        });
      }
      return member;
    }
    if (task.assignee) {
      const current = config.team.members.find((m) => m.handle === task.assignee);
      if (current) return current;
    }
    const candidates = config.team.members
      .map((m, index) => ({ m, index }))
      .filter((c): c is { m: AiMemberConfig; index: number } => c.m.kind === 'ai' && c.m.role === 'developer')
      .map((c) => ({ ...c, load: this.memberLoad(projectKey, c.m.handle) }))
      .filter((c) => c.load < c.m.capacity && !(c.m.temp && c.load > 0))
      .sort((a, b) => a.load - b.load || a.index - b.index);
    return candidates[0]?.m ?? null;
  }
}
