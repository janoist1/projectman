import {
  assertIntegratorAccess,
  assertSuperMutation,
  assertOwnOrSuperApproval,
  integratorExecution,
} from '../../kernel';
import {
  aiLabelSetters,
  canAutomaticallyStartTask,
  coordinationActorRefusal,
  chooseDeveloper,
  complexityLimitOf,
  tempMaxPointsOf,
  complexityOf,
  DEFAULT_AGENT_PROVIDER,
  evaluateStart,
  humanStageOwner,
  isOnLeave,
  isOpenTask,
  isTheme,
  isCoordinatorSuperActor,
  mayOverridePrerequisites,
  memberOf,
  projectRefines,
  reachingDevelopers,
  roleBundle,
  stageDevelopers,
  stageIndex,
  stageOwners,
  startBlock,
  workStageOf,
} from '@projectman/shared';
import type {
  Actor,
  AgentProvider,
  AiMemberConfig,
  GateEvaluation,
  MemberConfig,
  ProjectConfig,
  Session,
  Stage,
  StagePull,
  Task,
} from '@projectman/shared';
import { ownerHandles } from '@projectman/shared';
import { conflict, DomainError, forbidden, invalid, notFound, themeRefused } from '../../kernel';
import type { MemberService } from '../../core/members';
import type { Author, ProjectService } from '../../core/projects';
import type { SessionOrchestrator } from '../sessions';
import {
  approvalRequestedError,
  assertAssigneeFits,
  gateBlockedError,
  prerequisiteCards,
} from '../../core/tasks';
import type { StageChange, TaskService, WorkEntryCheck } from '../../core/tasks';
import { actorHandle, SYSTEM_ACTOR, SYSTEM_AUTHOR } from '../../kernel';
import type { Admission } from './admission';
import { assertPrerequisitesClosed } from './rules';
import type { SeniorWaits } from './senior-waits';

interface StartTaskOptions {
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
  /**
   * A person's start of a card whose gate before the work stage asks only for labels that AI members
   * set (PM-236): their sessions start on the card, and the developer's start waits for the labels
   * (`StartTaskResult.awaiting`) instead of being refused. Without it, or when a label is set only
   * by a person, the gate refuses the start.
   */
  startSetters?: boolean;
  /**
   * Members who are not chosen when the start picks the developer (PM-262: the implementer the card was
   * taken from). Internal, not a contract; an explicit `assignee` is not filtered.
   */
  excludeMembers?: string[];
  /**
   * The start is an automatic one (a card moved into the work stage, `WorkStarts.run`), not a person's
   * Start (PM-348): a card that waits for the Senior is refused with `senior_busy`, which the automatic
   * start waits for. A person's Start of such a card is answered with the waiting card instead.
   */
  automatic?: boolean;
  /** Why the system pulls the card into the work stage ahead of its turn (PM-427): recorded on the stage change. */
  pulled?: StagePull;
}

interface StartTaskResult {
  task: Task;
  session: Session | null;
  /** Temp worker hired for this task, if any. */
  hired: AiMemberConfig | null;
  /** The developer's start waits for these labels, which these members were started to set (PM-236). */
  awaiting?: { labels: string[]; members: string[] };
  /** The card is recommended for the Senior and waits for one of these (PM-348); no developer is assigned. */
  seniorWait?: { seniors: string[] };
}

export interface LabelWaitRequest {
  projectKey: string;
  taskKey: string;
  /** The stage the card is in, and the work stage it moves to when the start goes ahead. */
  from: string;
  to: string;
  actor: Actor;
  /** The card's assignee, kept (not chosen again). */
  assignee: string | null;
  /** The developer the person chose. */
  developer?: string;
  despitePrerequisites?: boolean;
  labels: string[];
  /** The member who sets them (the first of the started ones). */
  member: string;
}

/** Keeps the developer's start that waits for labels (PM-236); called under the admission lock. */
export interface LabelWait {
  awaitLabels(wait: LabelWaitRequest): void;
}

export interface SeniorWaitRequest {
  projectKey: string;
  taskKey: string;
  /** The stage the card was in, and the work stage it is in now (a start moves it there without an assignee). */
  from: string;
  to: string;
  actor: Actor;
  /** The Seniors the card waits for. */
  seniors: string[];
  /** Who chose "wait on" after the question, if anyone did. */
  waitDecidedBy?: string;
  despitePrerequisites?: boolean;
}

/** Keeps a person's Start of a card that waits for the Senior (PM-348); called under the admission lock. */
export interface SeniorWait {
  awaitSenior(wait: SeniorWaitRequest): void;
}

/** What a person's Start needs of the fix round limit (PM-262): to end the hold, then let the waiting messages through. */
interface FixLimitStart {
  heldFor(task: Task, config: ProjectConfig): boolean;
  humanStart(task: Task, actor: Actor): boolean;
  releaseMessages(task: Task): void;
}

/**
 * A label that only a person sets, missing from the entry gate of the stage the card is in: the
 * move to the work stage would not ask for it (it enters the stages after this one), so the start
 * is refused here, the refusal naming the label.
 */
function refuseOwnStageApproval(task: Task, evaluation: GateEvaluation): void {
  if (evaluation.approvals.some((a) => a.stageId === task.stageId)) throw gateBlockedError(evaluation);
}

function startsAsPerson(config: ProjectConfig, actor: Actor): boolean {
  return actor.kind === 'human' || isCoordinatorSuperActor(config, actor);
}

/** The start's `despitePrerequisites` flag as the move honors it (PM-1099): one value for every move it makes. */
function despiteOf(config: ProjectConfig, opts: StartTaskOptions): boolean {
  return opts.despitePrerequisites === true && mayOverridePrerequisites(config, opts.actor);
}

/**
 * Starts work on tasks: picks the developer (the explicit one, the current assignee, else the
 * least loaded free owner of the work stage), hires a temp worker when nobody is free and the
 * limits allow it, passes admission, assigns, moves the task into the work stage and starts
 * the developer's session (the context pack's brief is its first message). A temp worker is
 * retired once its task is done.
 */
export class TaskStarts implements WorkEntryCheck {
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly members: MemberService;
  private readonly sessions: SessionOrchestrator;
  private readonly admission: Admission;
  private readonly seniorWaits: SeniorWaits;
  private labelWait: LabelWait | undefined;
  private seniorWait: SeniorWait | undefined;
  private fixLimit: FixLimitStart | undefined;
  private readonly moving = new Set<string>();

  /** The Start button itself starts this move; a delayed hand-over must not start it a second time. */
  ownsMove(change: StageChange): boolean {
    return this.moving.has(`${change.task.projectKey}:${change.task.key}`);
  }

  constructor(deps: {
    projects: ProjectService;
    tasks: TaskService;
    members: MemberService;
    sessions: SessionOrchestrator;
    admission: Admission;
    seniorWaits: SeniorWaits;
  }) {
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.members = deps.members;
    this.sessions = deps.sessions;
    this.admission = deps.admission;
    this.seniorWaits = deps.seniorWaits;
  }

  async start(projectKey: string, taskKey: string, opts: StartTaskOptions): Promise<StartTaskResult> {
    const result = await this.admission.exclusive('task-start', () =>
      this.startLocked(projectKey, taskKey, opts),
    );
    // The card is started: an automatic start of it that waited has nothing left to do.
    this.admission.discardStale(result.task);
    return result;
  }

  /**
   * The project manager's move of a card without an assignee into the work stage (PM-722): it passes
   * only when the start the move triggers would find a developer, now: a free one, or a temp worker the
   * limits let it hire. Refused like that start would be (`senior_busy`, `no_free_member`); nothing is
   * chosen, hired or written.
   */
  assertMemberFree(config: ProjectConfig, task: Task, target: Stage): void {
    const chosen = this.chooseMember(config, task, target, undefined, []);
    if (chosen.kind === 'senior_busy')
      throw conflict('senior_busy', `task ${task.key} waits for a developer whose limit reaches its points`, {
        seniors: chosen.seniors,
      });
    if (!chosen.member && !this.mayHireTempWorker(config, target, chosen.tempAllowed))
      throw conflict('no_free_member', 'every developer is at capacity');
  }

  /** The shared rule (`canAutomaticallyStartTask`), on all this card's subtasks read from fresh state (PM-818). */
  private canStartAutomatically(task: Task): boolean {
    const subtasks = this.tasks.readSchedulingTasks(task.projectKey, {
      kind: 'children',
      parentKeys: [task.key],
      includeClosed: true,
    });
    return canAutomaticallyStartTask(task, subtasks);
  }

  /**
   * `start` for a caller that already holds the admission lock (`Admission.exclusive`, which an
   * automatic start's `run` is under): the lock is not reentrant, so `start` cannot be called
   * there. The member choice, admission checks and the start itself are the same.
   */
  async startLocked(projectKey: string, taskKey: string, opts: StartTaskOptions): Promise<StartTaskResult> {
    const config = await this.projects.config(projectKey);
    assertIntegratorAccess(config, 'write', opts.actor);
    let task = this.tasks.get(projectKey, taskKey);
    if (task.fixLimit && integratorExecution()) assertOwnOrSuperApproval();
    const skipped = { task, session: null, hired: null };
    if (opts.automatic && !this.canStartAutomatically(task)) return skipped;
    if (isTheme(task)) throw themeRefused(taskKey, 'be started');
    if (!isOpenTask(task)) throw conflict('task_closed', `task ${taskKey} is ${task.status}`);
    if (!coordinationActorRefusal(config, opts.actor) && task.fixLimit)
      throw forbidden('operator_never', 'the coordinator cannot start a task held by its fix round limit');
    if (opts.stillWanted && !opts.stillWanted(task)) return skipped;
    const workStage = workStageOf(config, task);
    if (!workStage) throw invalid('no_work_stage', 'the pipeline has no work stage');
    const needsMove = stageIndex(config.pipeline, task.stageId) < stageIndex(config.pipeline, workStage.id);
    // PM-291: a person's Start of a card that is not ready to start (being refined, held, an approval
    // of its own column missing, labels missing) is refused with the reason the drawer shows.
    if (needsMove && startsAsPerson(config, opts.actor)) {
      const block = startBlock(task, config);
      if (block) throw gateBlockedError(evaluateStart(task, config, workStage.id), block);
    }
    // Before the developer is chosen: nobody is picked, hired or assigned for a card that waits.
    const despite = despiteOf(config, opts);
    if (!despite) assertPrerequisitesClosed(task, prerequisiteCards(this.tasks, projectKey, task));
    // PM-248: the gate of the stage the card is in holds the Start too; a label only a person
    // sets there is no approval this Start can ask for, so it is refused before anyone is started.
    if (needsMove) refuseOwnStageApproval(task, evaluateStart(task, config, workStage.id));
    // A project with refinement works its cards out first (decision 31): the Start button does not
    // start their setters, it is refused until the card is worked out.
    if (
      needsMove &&
      opts.startSetters &&
      startsAsPerson(config, opts.actor) &&
      this.labelWait &&
      !projectRefines(config)
    ) {
      const waiting = await this.startLabelSetters(config, task, workStage, opts);
      if (waiting) return { ...skipped, task: this.tasks.get(projectKey, taskKey), awaiting: waiting };
    }

    const workItem = { type: 'task', taskKey } as const;
    // The providers admission refused as on hold while an automatic choice was being checked (PM-1051): the
    // choice is made again without their members, at most once per provider.
    const heldProviders = new Set<AgentProvider>();
    let chosen: ChosenMember;
    let member: MemberConfig | null;
    for (;;) {
      const pick = this.chooseMember(
        config,
        task,
        workStage,
        opts.assignee,
        opts.excludeMembers ?? [],
        heldProviders,
        opts.actor,
      );
      if (pick.kind === 'senior_busy')
        return this.waitForSenior(config, task, workStage, opts, needsMove, pick.seniors);
      chosen = pick;
      member = pick.member;
      assertSuperMutation(
        config,
        { kind: 'runtime_start', providers: member?.kind === 'ai' ? [member.provider ?? 'claude'] : [] },
        opts.actor,
      );
      opts.onChosen?.(member);
      const alreadyRunning =
        member?.kind === 'ai' && this.sessions.findRunning(projectKey, member.handle, workItem);
      // A temp worker (no member yet) is hired with the default provider.
      if (!((member === null || member.kind === 'ai') && !alreadyRunning)) break;
      try {
        await this.admission.check({
          config,
          member: member ?? undefined,
          workItem,
          // The current assignee keeps its task whatever else it carries.
          capacity: opts.assignee !== undefined || member?.handle !== task.assignee,
        });
        break;
      } catch (err) {
        const provider = member?.kind === 'ai' ? (member.provider ?? DEFAULT_AGENT_PROVIDER) : undefined;
        if (
          opts.assignee !== undefined ||
          !provider ||
          heldProviders.has(provider) ||
          !(
            err instanceof DomainError &&
            (err.code === 'provider_rate_limited' || err.code === 'plan_usage_paused')
          )
        )
          throw err;
        heldProviders.add(provider);
      }
    }

    // Again: admission and a hire waited since the first check, and labels may have changed.
    if (needsMove) await this.passEntryGates(config, task, workStage, opts);

    const wanted = () => {
      const current = this.tasks.get(projectKey, taskKey);
      return (
        (!opts.automatic || this.canStartAutomatically(current)) &&
        (!opts.stillWanted || opts.stillWanted(current)) &&
        // The replaced assignee stays if work or a handoff appeared on the card meanwhile (PM-1051).
        (!chosen.replaces || this.stillReplaceable(config, current, chosen.replaces))
      );
    };
    let hired: AiMemberConfig | null = null;
    if (!member) {
      if (!wanted()) return skipped;
      hired = await this.hireTempWorker(config, workStage, opts, chosen.tempAllowed);
      member = hired;
    }

    let startWanted = false;
    try {
      startWanted = wanted();
    } finally {
      // A withdrawn or refused start leaves the new temp worker with no task to carry.
      if (!startWanted && hired)
        await this.members.retire(
          projectKey,
          hired.handle,
          {},
          { actor: SYSTEM_ACTOR, author: SYSTEM_AUTHOR },
        );
    }
    if (!startWanted) return skipped;
    // A person's Start of a card held by its fix round limit (PM-262) is one more round for its assignee.
    const anotherRound =
      (opts.actor.kind === 'human' || isCoordinatorSuperActor(config, opts.actor)) &&
      task.assignee === member.handle &&
      !!this.fixLimit?.humanStart(task, opts.actor);
    if (task.assignee !== member.handle) {
      // Said before the assignment, which ends a wait for a Senior as "assigned".
      if (chosen.noneReaches) this.seniorWaits.noSenior(task);
      task = this.tasks.assign(projectKey, taskKey, member.handle, opts.actor, { handoff: 'auto_assign' });
      opts.onAssigned?.(member.handle);
    }
    if (needsMove) {
      const key = `${projectKey}:${taskKey}`;
      this.moving.add(key);
      try {
        const result = await this.tasks.moveToStage(projectKey, taskKey, workStage.id, opts.actor, {
          ...(opts.pulled ? { pulled: opts.pulled } : {}),
          ...(despite ? { despitePrerequisites: true } : {}),
        });
        if (!result.moved) throw approvalRequestedError(result.pendingApproval);
      } finally {
        this.moving.delete(key);
      }
    }
    let session: Session | null = null;
    // The old assignee's note comes first (PM-342): the receiver is started when the handoff is over.
    const handedOver = this.tasks.get(projectKey, taskKey).handoff?.to === member.handle;
    if (member.kind === 'ai' && !handedOver) {
      session = (
        await this.sessions.ensureSession(projectKey, member.handle, workItem, {
          cause: { kind: 'start_button', by: opts.actor },
        })
      ).session;
    }
    if (anotherRound) this.fixLimit?.releaseMessages(task);
    return { task: this.tasks.get(projectKey, taskKey), session, hired };
  }

  /** Binds what keeps the start that waits for labels (it needs this class to run, so it is bound after). */
  useLabelWait(labelWait: LabelWait): void {
    this.labelWait = labelWait;
  }

  /** Binds what keeps a person's Start of a card that waits for the Senior (it needs this class to run, so it is bound after). */
  useSeniorWait(seniorWait: SeniorWait): void {
    this.seniorWait = seniorWait;
  }

  /**
   * The gate of the work stage holds the move too (the labels may have changed while admission or a
   * hire waited): refused, or the approvals it needs are requested and the start ends with that request.
   */
  private async passEntryGates(
    config: ProjectConfig,
    task: Task,
    workStage: Stage,
    opts: StartTaskOptions,
  ): Promise<void> {
    const evaluation = evaluateStart(task, config, workStage.id);
    if (evaluation.unmet.length > 0) throw gateBlockedError(evaluation);
    refuseOwnStageApproval(task, evaluation);
    if (evaluation.approvals.length > 0) {
      const result = await this.tasks.moveToStage(task.projectKey, task.key, workStage.id, opts.actor, {
        viaStart: true,
        ...(despiteOf(config, opts) ? { despitePrerequisites: true } : {}),
      });
      throw approvalRequestedError(result.pendingApproval);
    }
  }

  /**
   * A card whose points only some developers' limit reaches, while all of them are busy or away
   * (PM-348, PM-1001): nobody is chosen,
   * hired or assigned. The gates hold as for any start, admission checks only what needs no member
   * (`checkWait`), and a card still in an earlier stage moves into the work stage without an assignee.
   * The automatic start then opens the wait and is refused with `senior_busy`, which it waits for; a
   * person's Start is not an error: the start is kept as a work start that waits (`SeniorWait`), and the
   * result names the wait.
   */
  private async waitForSenior(
    config: ProjectConfig,
    task: Task,
    workStage: Stage,
    opts: StartTaskOptions,
    needsMove: boolean,
    seniors: string[],
  ): Promise<StartTaskResult> {
    const projectKey = config.project.key;
    if (needsMove) await this.passEntryGates(config, task, workStage, opts);
    this.admission.checkWait(config, task);
    if (needsMove) {
      const result = await this.tasks.moveToStage(projectKey, task.key, workStage.id, opts.actor, {
        viaStart: true,
        ...(despiteOf(config, opts) ? { despitePrerequisites: true } : {}),
      });
      if (!result.moved) throw approvalRequestedError(result.pendingApproval);
    }
    const current = this.tasks.get(projectKey, task.key);
    if (opts.stillWanted && !opts.stillWanted(current)) return { task: current, session: null, hired: null };
    const decision = this.seniorWaits.decisionFor(projectKey, task.key);
    const waitDecidedBy = decision?.decision === 'wait' ? decision.by : undefined;
    if (opts.automatic) {
      this.seniorWaits.open(task, seniors);
      throw conflict('senior_busy', `task ${task.key} waits for a developer whose limit reaches its points`, {
        seniors,
        waitDecidedBy,
      });
    }
    this.seniorWait?.awaitSenior({
      projectKey,
      taskKey: task.key,
      from: task.stageId,
      to: workStage.id,
      actor: opts.actor,
      seniors,
      waitDecidedBy,
      despitePrerequisites: opts.despitePrerequisites,
    });
    this.seniorWaits.open(task, seniors);
    return {
      task: this.tasks.get(projectKey, task.key),
      session: null,
      hired: null,
      seniorWait: { seniors },
    };
  }

  /** Binds the fix round limit (PM-262), which starts cards through this class and is built after it. */
  useFixLimit(fixLimit: FixLimitStart): void {
    this.fixLimit = fixLimit;
  }

  /**
   * PM-236: when the gate before the work stage refuses the card only for labels AI members set,
   * starts those members' sessions on the card (the usual admission checks apply; a refusal
   * propagates and nothing is kept) and keeps the developer's start waiting for the labels. Null
   * when the gate refuses for anything else: the start goes on to be refused as before.
   */
  private async startLabelSetters(
    config: ProjectConfig,
    task: Task,
    workStage: Stage,
    opts: StartTaskOptions,
  ): Promise<{ labels: string[]; members: string[] } | null> {
    const projectKey = config.project.key;
    const evaluation = evaluateStart(task, config, workStage.id);
    const setters = aiLabelSetters(config, evaluation.unmet, (handle) =>
      this.sessions
        .list(projectKey, { member: handle })
        .some((s) => s.workItem.type === 'task' && s.workItem.taskKey === task.key),
    );
    if (!setters || !this.labelWait) return null;
    const workItem = { type: 'task', taskKey: task.key } as const;
    for (const member of setters.members)
      await this.admission.start({
        config,
        member,
        workItem,
        cause: { kind: 'label_wait', labels: setters.labels, by: opts.actor },
      });
    const members = setters.members.map((m) => m.handle);
    this.labelWait.awaitLabels({
      projectKey,
      taskKey: task.key,
      from: task.stageId,
      to: workStage.id,
      actor: opts.actor,
      assignee: task.assignee,
      developer: opts.assignee,
      despitePrerequisites: opts.despitePrerequisites,
      labels: setters.labels,
      member: members[0]!,
    });
    return { labels: setters.labels, members };
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

  private tempWorkerCount(config: ProjectConfig): number {
    return config.team.members.filter((m) => m.kind === 'ai' && m.temp).length;
  }

  /** Whether a temp worker for the work stage may be hired now: the card allows it, and the limits and the role's duty do. */
  private mayHireTempWorker(config: ProjectConfig, workStage: Stage, tempAllowed: boolean): boolean {
    const temp = config.team.limits.tempWorkers;
    return (
      tempAllowed &&
      temp.enabled &&
      this.tempWorkerCount(config) < temp.max &&
      !(workStage.duty && !roleBundle(config, temp.role).duties.includes(workStage.duty))
    );
  }

  /** A temp worker of the configured role for the work stage, if the limits allow one. */
  private async hireTempWorker(
    config: ProjectConfig,
    workStage: Stage,
    opts: StartTaskOptions,
    tempAllowed: boolean,
  ): Promise<AiMemberConfig> {
    const temp = config.team.limits.tempWorkers;
    const tempCount = this.tempWorkerCount(config);
    if (!this.mayHireTempWorker(config, workStage, tempAllowed)) {
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
      {
        actor: opts.actor,
        author: opts.author,
        sponsor,
      },
      { temp: true, stageId: workStage.owners !== undefined ? workStage.id : undefined },
    );
  }

  /**
   * The explicit assignee (an owner of the work stage), else the current assignee if it owns
   * the stage, else the automatic choice (`chooseDeveloper`, PM-348, PM-1001) among the free AI owners
   * not on leave: a scored card goes to the free developer with the smallest limit that reaches its
   * points, or waits for one (`senior_busy`); else a human owner; null when nobody is free (a temp
   * worker is hired, if `tempAllowed`). An explicit or current assignee on leave is refused by
   * admission (`member_on_leave`) rather than replaced. `noneReaches`: a scored card went by the
   * "any" rule because no developer's limit of the work stage reaches its points. The automatic choice
   * skips members whose provider is on hold (a quota cooldown or a plan usage pause, PM-1051), and so
   * does `heldProviders`, the providers admission has just refused. A current assignee on such a
   * provider is replaced (`replaces`) when no work has begun on the card; otherwise it keeps the card.
   */
  private chooseMember(
    config: ProjectConfig,
    task: Task,
    stage: Stage,
    assignee: string | undefined,
    exclude: string[],
    heldProviders: ReadonlySet<AgentProvider> = new Set(),
    actor?: Actor,
  ): ChosenMember | { kind: 'senior_busy'; seniors: string[] } {
    const projectKey = config.project.key;
    const eligible = stageOwners(config, stage).filter(
      (handle) => assignee === handle || !exclude.includes(handle),
    );
    const given = (member: MemberConfig) =>
      ({ kind: 'member', member, tempAllowed: true, noneReaches: false }) as const;
    if (assignee) {
      const member = memberOf(config, assignee);
      if (!member) throw notFound('member', assignee);
      if (!eligible.includes(member.handle))
        throw invalid('not_stage_owner', 'assignee must own the work stage');
      // An AI member's explicit assignee has to fit the card when the project asks for it (PM-1136).
      if (actor)
        assertAssigneeFits({
          config,
          actor,
          task,
          workStage: stage,
          member: member.handle,
          anyDecided: this.seniorWaits.decisionFor(projectKey, task.key)?.decision === 'any',
        });
      return given(member);
    }
    // The current assignee keeps the card, unless its provider is on hold and the work has not begun (PM-1051).
    let replaces: string | undefined;
    if (task.assignee) {
      const current = memberOf(config, task.assignee);
      if (current && eligible.includes(current.handle)) {
        const held = current.kind === 'ai' && heldProviders.has(current.provider ?? DEFAULT_AGENT_PROVIDER);
        if (!this.admission.canReplaceAssignee(config, task, this.replacement(config, task, held)))
          return given(current);
        replaces = current.handle;
      }
    }
    const free = config.team.members
      .map((m, index) => ({ m, index }))
      .filter(
        (c): c is { m: AiMemberConfig; index: number } =>
          c.m.kind === 'ai' &&
          eligible.includes(c.m.handle) &&
          !isOnLeave(c.m) &&
          this.admission.providerAvailable(config, c.m.provider ?? DEFAULT_AGENT_PROVIDER, c.m.handle) &&
          !heldProviders.has(c.m.provider ?? DEFAULT_AGENT_PROVIDER),
      )
      .map((c) => ({ ...c, load: this.admission.memberLoad(config, c.m.handle) }))
      .filter(
        (c) =>
          c.load < c.m.capacity &&
          !(c.m.temp && (c.load > 0 || this.admission.hasOpenAssignment(projectKey, c.m.handle))),
      )
      .map((c) => ({
        handle: c.m.handle,
        limit: complexityLimitOf(config, c.m),
        specialtyLabels: c.m.specialtyLabels,
        temp: !!c.m.temp,
        load: c.load,
        index: c.index,
      }));
    const points = complexityOf(task);
    const reaching = reachingDevelopers(
      stageDevelopers(config, stage).filter((developer) => eligible.includes(developer.handle)),
      points,
      task.labels,
    );
    const pick = chooseDeveloper({
      points,
      labels: task.labels,
      anyDecided: this.seniorWaits.decisionFor(projectKey, task.key)?.decision === 'any',
      reaching,
      free,
      tempMaxPoints: tempMaxPointsOf(config),
    });
    // A replaced assignee stays with the card when nobody fitting is free: nothing is assigned, waited for or
    // written, and the refusal is the one a card without an assignee gets (PM-1051).
    if (pick.kind === 'senior_busy') {
      if (replaces)
        throw conflict(
          'senior_busy',
          `task ${task.key} waits for a developer whose limit reaches its points`,
          {
            seniors: pick.seniors,
          },
        );
      return pick;
    }
    const noneReaches = points !== null && reaching.length === 0;
    if (pick.kind === 'member')
      return {
        kind: 'member',
        member: memberOf(config, pick.handle) ?? null,
        tempAllowed: true,
        noneReaches,
        replaces,
      };
    return {
      kind: 'member',
      member: replaces ? null : humanStageOwner(config, eligible),
      tempAllowed: pick.tempAllowed,
      noneReaches,
      replaces,
    };
  }

  /** What `Admission.canReplaceAssignee` needs besides the card: the fix round limit's hold, and a provider just refused. */
  private replacement(config: ProjectConfig, task: Task, providerHeld: boolean) {
    return { fixLimitHeld: () => !!this.fixLimit?.heldFor(task, config), providerHeld };
  }

  /** The card still has the assignee that was to be replaced, and still nothing of its work has begun. */
  private stillReplaceable(config: ProjectConfig, current: Task, previous: string): boolean {
    return (
      current.assignee === previous &&
      this.admission.canReplaceAssignee(config, current, this.replacement(config, current, true))
    );
  }
}

/** The member a start chose: `replaces` is the unstarted assignee whose provider is on hold that it takes the card from (PM-1051). */
type ChosenMember = {
  kind: 'member';
  member: MemberConfig | null;
  tempAllowed: boolean;
  noneReaches: boolean;
  replaces?: string | undefined;
};
