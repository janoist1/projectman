import {
  evaluateMove,
  isOnLeave,
  isOpenTask,
  isTheme,
  memberOf,
  roleBundle,
  stageIndex,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type {
  Actor,
  AiMemberConfig,
  MemberConfig,
  ProjectConfig,
  Session,
  Stage,
  Task,
} from '@projectman/shared';
import { ownerHandles } from '../access';
import { conflict, invalid, notFound, themeRefused } from '../errors';
import type { MemberService } from '../members';
import type { Author, ProjectService } from '../projects';
import type { SessionOrchestrator } from '../sessions';
import { approvalRequestedError, gateBlockedError } from '../tasks';
import type { StageChange, TaskService } from '../tasks';
import { SYSTEM_ACTOR, SYSTEM_AUTHOR } from '../util';
import type { Admission } from './admission';
import { assertPrerequisitesClosed } from './rules';

export interface StartTaskOptions {
  /** Explicit assignee; omitted = the current assignee, else a free developer, else a temp worker. */
  assignee?: string;
  actor: Actor;
  author: Author;
  /** Human who sponsors a temp worker hired for this task (defaults to the first owner). */
  sponsor?: string;
  /** Told the member the start chose (null: nobody free, a temp worker is hired) before admission checks it. */
  onChosen?: (member: MemberConfig | null) => void;
  /**
   * Whether the start still applies to the task as it is now, asked where the task is read and
   * again right before it is assigned (admission and a hire wait in between): when it does not
   * (somebody assigned the card meanwhile), nothing is changed and no session starts.
   */
  stillWanted?: (task: Task) => boolean;
  /** Told the member this start assigned the task to (not one that was already assigned). */
  onAssigned?: (handle: string) => void;
  /**
   * The start goes ahead although a prerequisite is open (PM-204): a person's start after the
   * warning. Without it an open prerequisite refuses the start (`prerequisite_open`); an automatic
   * start waits for the last one to close.
   */
  despitePrerequisites?: boolean;
}

export interface StartTaskResult {
  task: Task;
  session: Session | null;
  /** Temp worker hired for this task, if any. */
  hired: AiMemberConfig | null;
}

/** The task's work stage: the one it is in, else the pipeline's first. */
function workStageOf(config: ProjectConfig, task: Task): Stage | undefined {
  const current = stageOf(config, task.stageId);
  return current?.kind === 'work' ? current : config.pipeline.stages.find((s) => s.kind === 'work');
}

/**
 * Starts work on tasks: picks the developer (the explicit one, the current assignee, else the
 * least loaded free owner of the work stage), hires a temp worker when nobody is free and the
 * limits allow it, passes admission, assigns, moves the task into the work stage and starts
 * the developer's session (the context pack's brief is its first message). A temp worker is
 * retired once its task is done.
 */
export class TaskStarts {
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly members: MemberService;
  private readonly sessions: SessionOrchestrator;
  private readonly admission: Admission;

  constructor(deps: {
    projects: ProjectService;
    tasks: TaskService;
    members: MemberService;
    sessions: SessionOrchestrator;
    admission: Admission;
  }) {
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.members = deps.members;
    this.sessions = deps.sessions;
    this.admission = deps.admission;
  }

  async start(projectKey: string, taskKey: string, opts: StartTaskOptions): Promise<StartTaskResult> {
    const result = await this.admission.exclusive(() => this.startLocked(projectKey, taskKey, opts));
    // The card is started: an automatic start of it that waited has nothing left to do.
    this.admission.discardStale(result.task);
    return result;
  }

  /**
   * `start` for a caller that already holds the admission lock (`Admission.exclusive`, which an
   * automatic start's `run` is under): the lock is not reentrant, so `start` cannot be called
   * there. The member choice, admission checks and the start itself are the same.
   */
  async startLocked(projectKey: string, taskKey: string, opts: StartTaskOptions): Promise<StartTaskResult> {
    const config = await this.projects.config(projectKey);
    let task = this.tasks.get(projectKey, taskKey);
    if (isTheme(task)) throw themeRefused(taskKey, 'be started');
    if (!isOpenTask(task)) throw conflict('task_closed', `task ${taskKey} is ${task.status}`);
    const skipped = { task, session: null, hired: null };
    if (opts.stillWanted && !opts.stillWanted(task)) return skipped;
    const workStage = workStageOf(config, task);
    if (!workStage) throw invalid('no_work_stage', 'the pipeline has no work stage');
    // Before the developer is chosen: nobody is picked, hired or assigned for a card that waits.
    if (!(opts.despitePrerequisites && opts.actor.kind === 'human'))
      assertPrerequisitesClosed(task, this.tasks.list(projectKey));
    const needsMove = stageIndex(config.pipeline, task.stageId) < stageIndex(config.pipeline, workStage.id);

    let member: MemberConfig | null = this.chooseMember(config, task, workStage, opts.assignee);
    opts.onChosen?.(member);
    const workItem = { type: 'task', taskKey } as const;
    const alreadyRunning =
      member?.kind === 'ai' && this.sessions.findRunning(projectKey, member.handle, workItem);
    // A temp worker (no member yet) is hired with the default provider.
    if ((member === null || member.kind === 'ai') && !alreadyRunning)
      await this.admission.check({
        config,
        member: member ?? undefined,
        workItem,
        // The current assignee keeps its task whatever else it carries.
        capacity: opts.assignee !== undefined || member?.handle !== task.assignee,
      });

    if (needsMove) {
      const evaluation = evaluateMove(task, config, task.stageId, workStage.id);
      if (evaluation.unmet.length > 0) throw gateBlockedError(evaluation);
      if (evaluation.approvals.length > 0) {
        const result = await this.tasks.moveToStage(projectKey, taskKey, workStage.id, opts.actor);
        throw approvalRequestedError(result.pendingApproval);
      }
    }

    const wanted = () => !opts.stillWanted || opts.stillWanted(this.tasks.get(projectKey, taskKey));
    let hired: AiMemberConfig | null = null;
    if (!member) {
      if (!wanted()) return skipped;
      hired = await this.hireTempWorker(config, workStage, opts);
      member = hired;
    }

    if (!wanted()) {
      // The card was taken while the temp worker was hired: it has no task to carry.
      if (hired)
        await this.members.retire(
          projectKey,
          hired.handle,
          {},
          { actor: SYSTEM_ACTOR, author: SYSTEM_AUTHOR },
        );
      return skipped;
    }
    if (task.assignee !== member.handle) {
      task = this.tasks.assign(projectKey, taskKey, member.handle, opts.actor);
      opts.onAssigned?.(member.handle);
    }
    if (needsMove) {
      const result = await this.tasks.moveToStage(projectKey, taskKey, workStage.id, opts.actor);
      if (!result.moved) throw approvalRequestedError(result.pendingApproval);
    }
    let session: Session | null = null;
    if (member.kind === 'ai') {
      session = (await this.sessions.ensureSession(projectKey, member.handle, workItem)).session;
    }
    return { task: this.tasks.get(projectKey, taskKey), session, hired };
  }

  /** Stage change listener: a temp worker is retired once its task is done. */
  async retireFinishedTempWorker(change: StageChange): Promise<void> {
    const { task } = change;
    if (task.status !== 'done' || !task.assignee) return;
    const config = await this.projects.config(task.projectKey);
    const member = memberOf(config, task.assignee);
    if (member?.kind !== 'ai' || !member.temp) return;
    // A temp worker carries one task: it stays while another open task is assigned to it.
    if (this.admission.hasOpenAssignment(task.projectKey, member.handle)) return;
    if (this.admission.memberLoad(config, member.handle) > 0) return;
    await this.members.retire(
      task.projectKey,
      member.handle,
      {},
      { actor: SYSTEM_ACTOR, author: SYSTEM_AUTHOR },
    );
  }

  /** A temp worker of the configured role for the work stage, if the limits allow one. */
  private async hireTempWorker(
    config: ProjectConfig,
    workStage: Stage,
    opts: StartTaskOptions,
  ): Promise<AiMemberConfig> {
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
    return this.members.hire(
      config.project.key,
      { role: temp.role },
      { actor: opts.actor, author: opts.author, sponsor },
      { temp: true, stageId: workStage.owners !== undefined ? workStage.id : undefined },
    );
  }

  /**
   * The explicit assignee (an owner of the work stage), else the current assignee if it owns
   * the stage, else the least loaded free AI owner not on leave, else a human owner; null when
   * nobody is free. An explicit or current assignee on leave is refused by admission
   * (`member_on_leave`) rather than replaced.
   */
  private chooseMember(
    config: ProjectConfig,
    task: Task,
    stage: Stage,
    assignee: string | undefined,
  ): MemberConfig | null {
    const projectKey = config.project.key;
    const eligible = stageOwners(config, stage);
    if (assignee) {
      const member = memberOf(config, assignee);
      if (!member) throw notFound('member', assignee);
      if (!eligible.includes(member.handle))
        throw invalid('not_stage_owner', 'assignee must own the work stage');
      return member;
    }
    if (task.assignee) {
      const current = memberOf(config, task.assignee);
      if (current && eligible.includes(current.handle)) return current;
    }
    const candidates = config.team.members
      .map((m, index) => ({ m, index }))
      .filter(
        (c): c is { m: AiMemberConfig; index: number } =>
          c.m.kind === 'ai' && eligible.includes(c.m.handle) && !isOnLeave(c.m),
      )
      .map((c) => ({ ...c, load: this.admission.memberLoad(config, c.m.handle) }))
      .filter(
        (c) =>
          c.load < c.m.capacity &&
          !(c.m.temp && (c.load > 0 || this.admission.hasOpenAssignment(projectKey, c.m.handle))),
      )
      .sort((a, b) => a.load - b.load || a.index - b.index);
    return (
      candidates[0]?.m ??
      config.team.members.find((m) => m.kind === 'human' && eligible.includes(m.handle)) ??
      null
    );
  }
}
