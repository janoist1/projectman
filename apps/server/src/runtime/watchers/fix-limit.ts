import {
  FIX_ANOTHER_ROUND_OPTION,
  FIX_REASSIGN_OPTION,
  FIX_REPLAN_OPTION,
  FixLimitAssessment as FixLimitAssessmentSchema,
  MAX_FIX_EXTRA_ROUNDS,
  countFixRounds,
  fixLimitDeciders,
  fixRoundHistory,
  formatInjectedTeamMessage,
  fixLimitDecisionOf,
  fixLimitLead,
  fixLimitPlanner,
  fixLimitPlannerForOwner,
  fixLimitReached,
  inboxRecipientOf,
  isOpenTask,
  isWorkPaused,
  isTheme,
  maxFixRoundsOf,
  memberOf,
  remainingFixExtraRounds,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type {
  Actor,
  FixLimitAssessment,
  FixLimitDecisionPayload,
  FixRoundHistoryEntry,
  FixRounds,
  InboxItem,
  InboxOption,
  ProjectConfig,
  Task,
  TaskFixLimit,
  TimelineEventData,
} from '@projectman/shared';
import type { TaskFixLimitRecord } from '../../db';
import { ownerHandles } from '@projectman/shared';
import type { Admission, TaskStarts } from '../admission';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { conflict, forbidden, invalid } from '../../kernel';
import type { InboxService } from '../../core/inbox';
import type { MemberQueue } from '../../core/member-queue';
import type { Messaging } from '../../core/messages';
import type { MessageDelivery } from '../delivery';
import type { ProjectService } from '../../core/projects';
import type { SessionOrchestrator } from '../sessions';
import type { TaskService } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import { KeyedMutex, SYSTEM_ACTOR, SYSTEM_AUTHOR, aiActor, humanActor } from '../../kernel';
import { assertIntegratorAccess, assertOwnOrSuperApproval, integratorExecution } from '../../kernel';

type FixLimitEvent = TimelineEventData['task_fix_limit'];
type Phase = NonNullable<TaskFixLimitRecord['holdPhase']>;

/** What an AI decider of a fix round limit can decide (`decide_fix_limit`). */
export type FixLimitDecision = 'continue' | 'replan' | 'to_owner';

/** Where a decision left the card: let go on, with a planner, or with the people. */
export type FixLimitPhase = 'released' | 'replan' | 'owner';

/**
 * The fix round limit (PM-262). A card whose fix rounds (`countFixRounds` in `packages/shared`) reached the
 * project's limit is held back: what AI members write to its AI assignee is stored but does not wake it,
 * and the hand-over into the work stage does not tell it. Who decides how it goes on: the lead developer
 * first (an AI member; it continues, asks for a more exact plan, or passes the card to the people), a
 * planner when it asked for a plan, the people when no AI member can decide or when the lead passed it on.
 * The lead decides at every limit reach while fewer than `MAX_FIX_EXTRA_ROUNDS` extra rounds were given
 * since the count began; after the third the decision goes to the people at every reach (PM-714). A
 * person's Start of the card is one more round, counted the same way. The item for the people goes to the
 * integrator first when one is available (`InboxService.createFixLimitDecision`). The hold ends with a
 * decision, a change of the assignee or the card's closing.
 *
 * Opening a hold and the checks around it are synchronous (so that no message slips between the count and
 * the hold); only what starts sessions waits for the card's lock.
 */
export class FixLimitWatch {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly inbox: InboxService;
  private readonly timeline: TimelineService;
  private readonly messaging: Pick<Messaging, 'send' | 'releaseWaiting'>;
  private readonly admission: Admission;
  private readonly delivery: MessageDelivery;
  private readonly starts: Pick<TaskStarts, 'start'>;
  private readonly queue: Pick<MemberQueue, 'openFixLimit' | 'closeFixLimit'>;
  /** One decision about a card at a time. */
  private readonly cards = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    inbox: InboxService;
    timeline: TimelineService;
    messaging: Pick<Messaging, 'send' | 'releaseWaiting'>;
    admission: Admission;
    delivery: MessageDelivery;
    starts: Pick<TaskStarts, 'start'>;
    queue: Pick<MemberQueue, 'openFixLimit' | 'closeFixLimit'>;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.inbox = deps.inbox;
    this.timeline = deps.timeline;
    this.messaging = deps.messaging;
    this.admission = deps.admission;
    this.delivery = deps.delivery;
    this.starts = deps.starts;
    this.queue = deps.queue;
  }

  /** Whether `member` still has the lead decision of the hold that began at `heldAt` to make. */
  leadWaitsFor(taskKey: string, heldAt: string, member: string): boolean {
    const record = this.ctx.repos.taskFixLimits.get(taskKey);
    return record?.holdPhase === 'lead' && record.decider === member && record.heldAt === heldAt;
  }

  /** What the lead of the hold is told, as it stands now; null when the hold is not (or no longer) the lead's. */
  leadPromptOf(taskKey: string, heldAt: string, member: string): string | null {
    if (!this.leadWaitsFor(taskKey, heldAt, member)) return null;
    const record = this.ctx.repos.taskFixLimits.get(taskKey)!;
    const task = this.tasks.find(record.projectKey, taskKey);
    const config = this.projects.cachedConfig(record.projectKey);
    if (!task || !config) return null;
    return this.leadNoticeOf(config, task, record, this.roundsOf(task, config, record));
  }

  /** The notice of the lead decision: the card's rounds, the limit, and what the lead can decide. */
  private leadNoticeOf(
    config: ProjectConfig,
    task: Task,
    record: TaskFixLimitRecord,
    rounds: FixRounds,
  ): string {
    const lead = record.decider ?? '';
    const canReplan = fixLimitPlanner(config, [lead, ...(task.assignee ? [task.assignee] : [])]) !== null;
    return leadNotice(
      task,
      rounds,
      this.limitOf(config, record),
      { replan: canReplan, reassign: this.otherDevelopers(config, task).length > 0 },
      record.extraRounds,
      this.historyOf(task, config, record),
    );
  }

  /** The lead's item of the hold ends with the hold's own end: `actor` decided it, a person took it, or it lapsed. */
  private closeLeadItem(
    record: TaskFixLimitRecord,
    outcome: 'decided' | 'handed_off' | 'ended',
    actor?: Actor,
  ): void {
    if (record.holdPhase !== 'lead' || !record.heldAt) return;
    const decided = outcome === 'decided' && !!actor?.handle && actor.handle === record.decider;
    this.queue.closeFixLimit(
      record.projectKey,
      record.taskKey,
      record.heldAt,
      outcome === 'decided' && !decided ? 'ended' : outcome,
    );
  }

  /**
   * Whether `task` is held back: its AI assignee gets nothing from AI members and no hand-over notice. A
   * card that reached the limit without a hold yet gets one here, so the order of the events and messages
   * that follow a round does not matter.
   */
  heldFor(task: Task, config: ProjectConfig): boolean {
    if (!this.applies(task, config)) return false;
    const record = this.ctx.repos.taskFixLimits.get(task.key);
    if (record?.holdPhase) return true;
    const rounds = this.roundsOf(task, config, record);
    if (!fixLimitReached(rounds.rounds, maxFixRoundsOf(config.team.limits), record?.extraRounds ?? 0))
      return false;
    this.open(config, task, record, rounds);
    return true;
  }

  /** A card's labels changed or it changed stage: a round may have reached the limit. */
  check(task: Task): void {
    const config = this.projects.cachedConfig(task.projectKey);
    const current = this.tasks.find(task.projectKey, task.key);
    if (config && current) this.heldFor(current, config);
  }

  /** The card's assignee changed: the hold ends and the count begins again for the new one. */
  assigned(change: { task: Task; previous: string | null }): void {
    const { task, previous } = change;
    const record = this.ctx.repos.taskFixLimits.get(task.key);
    if (!record && previous === null) return;
    const base = record ?? this.blank(task);
    if (record?.holdPhase) this.finish(task, record, 'assignee_changed');
    this.ctx.repos.taskFixLimits.save({
      ...this.cleared(base),
      countedFrom: isoNow(this.ctx),
      extraRounds: 0,
    });
  }

  /** The card was cancelled or done: its hold ends. */
  closed(task: Task): void {
    const record = this.ctx.repos.taskFixLimits.get(task.key);
    if (record?.holdPhase) this.finish(task, record, 'closed');
  }

  /** What `Task.fixLimit` shows: the hold of the card, null when it has none. */
  view(task: Task): TaskFixLimit | undefined {
    if (!isOpenTask(task) || isTheme(task)) return undefined;
    const record = this.ctx.repos.taskFixLimits.get(task.key);
    const config = this.projects.cachedConfig(task.projectKey);
    if (!record?.holdPhase || !record.heldAt || !config) return undefined;
    const rounds = this.roundsOf(task, config, record);
    const item =
      record.holdPhase === 'owner' && record.inboxItemId
        ? this.ctx.repos.inbox.get(record.inboxItemId)
        : null;
    return {
      phase: record.holdPhase,
      rounds: rounds.rounds,
      limit: this.limitOf(config, record),
      changeRequests: rounds.changeRequests,
      designChangeRequests: rounds.designChangeRequests,
      sendBacks: rounds.sendBacks,
      testsFailed: rounds.testsFailed,
      extraRounds: record.extraRounds,
      remainingExtraRounds: remainingFixExtraRounds(record.extraRounds),
      extraRoundLimit: MAX_FIX_EXTRA_ROUNDS,
      decider: record.decider,
      deciders: record.deciders,
      reason: record.reason,
      ...(item?.state === 'open' ? { recipient: inboxRecipientOf(item) } : {}),
      heldAt: record.heldAt,
    };
  }

  /** The rounds of a card and the limit that holds it now (the limit plus the rounds people allowed). */
  fixRounds(task: Task, config: ProjectConfig): { rounds: number; limit: number } {
    const record = this.ctx.repos.taskFixLimits.get(task.key);
    return { rounds: this.roundsOf(task, config, record).rounds, limit: this.limitOf(config, record) };
  }

  /**
   * A person's Start of a held card is one more round: the hold ends before the session starts, so the
   * messages that waited are typed into it. Returns whether the card was held.
   */
  humanStart(task: Task, actor: Actor): boolean {
    const record = this.ctx.repos.taskFixLimits.get(task.key);
    if (!record?.holdPhase) return false;
    this.anotherRound(task, record, actor, null);
    return true;
  }

  /** The messages that waited on a card whose hold ended reach their assignee. */
  releaseMessages(task: Task): void {
    if (task.assignee)
      void this.messaging
        .releaseWaiting(task.projectKey, task.key, task.assignee)
        .catch((err: unknown) =>
          this.ctx.logger.warn(
            { err, taskKey: task.key },
            'could not release messages after the fix-limit hold',
          ),
        );
  }

  /**
   * The AI member who decides (the lead; the planner once it was asked for a plan) decides how a held
   * card goes on: `continue` (the lead: one more round; the planner: the card starts anew with the plan),
   * `replan` (the lead: another technical direction holder makes a more exact plan first), `to_owner`
   * (the people decide; `reason` goes with it, and so does the required `assessment` of the lead: whether
   * the fault comes back, where the work stands, and the outcome it recommends). A refused decision changes
   * nothing.
   */
  async decide(
    member: string,
    projectKey: string,
    taskKey: string,
    decision: FixLimitDecision,
    reason: string,
    assessment?: unknown,
  ): Promise<{ phase: FixLimitPhase }> {
    assertOwnOrSuperApproval();
    return this.cards.run(taskKey, async () => {
      const config = await this.projects.config(projectKey);
      assertIntegratorAccess(config, 'write');
      const task = this.tasks.get(projectKey, taskKey);
      const record = this.ctx.repos.taskFixLimits.get(taskKey);
      if (!record?.holdPhase || record.holdPhase === 'owner')
        throw conflict('fix_limit_not_held', `${taskKey} is not held for a decision of an AI member`);
      if (record.decider !== member)
        throw forbidden(
          'fix_limit_not_decider',
          `${member} does not decide the fix round limit of ${taskKey}`,
        );
      const actor = integratorExecution()?.actor ?? aiActor(member);
      if (decision === 'continue') {
        if (record.holdPhase === 'lead') this.anotherRound(task, record, actor, reason);
        else this.freshStart(task, record, actor, 'continue', reason);
        await this.tellAssignee(task, member, reason);
        return { phase: 'released' };
      }
      if (decision === 'to_owner') {
        const checked = this.checkAssessment(config, task, assessment);
        this.passOn(config, task, record, actor, reason, checked);
        return { phase: 'owner' };
      }
      const planner = fixLimitPlanner(config, [member, ...(task.assignee ? [task.assignee] : [])]);
      if (record.holdPhase !== 'lead' || !planner)
        throw conflict('fix_limit_no_planner', `no other member can make a more exact plan for ${taskKey}`);
      this.toPlanner(task, record, planner, actor, reason);
      return { phase: 'replan' };
    });
  }

  /** A person answered a decision item of a fix round limit. */
  decided(item: InboxItem): Promise<void> | void {
    if (!fixLimitDecisionOf(item) || !item.taskKey || item.resolution?.rule === 'fix_limit_ended') return;
    const taskKey = item.taskKey;
    return this.cards.run(taskKey, async () => {
      const record = this.ctx.repos.taskFixLimits.get(taskKey);
      const task = this.tasks.find(item.projectKey, taskKey);
      if (!record || record.inboxItemId !== item.id || record.holdPhase !== 'owner' || !task) return;
      const config = await this.projects.config(item.projectKey);
      const by = item.resolution?.by ?? 'system';
      // The integrator's decision keeps its authenticated origin (PM-714); a person's is theirs.
      const actor =
        (item.resolution?.integratorFixLimit || item.resolution?.superDecision) && item.resolution.actor
          ? item.resolution.actor
          : humanActor(by);
      const note = item.resolution?.note ?? null;
      switch (item.resolution?.optionId) {
        case FIX_ANOTHER_ROUND_OPTION.id:
          this.anotherRound(task, { ...record, inboxItemId: null }, actor, note);
          await this.tellAssignee(task, by, note);
          break;
        case FIX_REPLAN_OPTION.id: {
          const planner = this.plannerFor(config, task);
          if (planner) this.toPlanner(task, { ...record, inboxItemId: null }, planner, actor, note);
          // The planner is gone (the configuration changed since the item was made): one more round instead.
          else {
            this.anotherRound(task, { ...record, inboxItemId: null }, actor, note);
            await this.tellAssignee(task, by, note);
          }
          break;
        }
        case FIX_REASSIGN_OPTION.id:
          // Paused: another implementer would start and the first one stop. The card stays held with its
          // item answered, and `afterResume` makes the decision then.
          if (isWorkPaused(this.ctx.repos.pauses.open(), task.projectKey)) return;
          await this.reassign(task, { ...record, inboxItemId: null }, actor, note);
          break;
      }
    });
  }

  /**
   * The team is resumed (PM-219): the reassignments people decided while it was paused are made now. They
   * stay stored as a held card whose decision item is answered, so a restart does not lose them.
   */
  async afterResume(projectKey: string): Promise<void> {
    for (const record of this.ctx.repos.taskFixLimits.listHeld(projectKey)) {
      if (record.holdPhase !== 'owner' || !record.inboxItemId) continue;
      const item = this.ctx.repos.inbox.get(record.inboxItemId);
      if (item?.resolution?.optionId !== FIX_REASSIGN_OPTION.id) continue;
      try {
        await this.decided(item);
      } catch (err) {
        this.ctx.logger.warn({ err, taskKey: record.taskKey }, 'could not reassign a card after the resume');
      }
    }
  }

  /** Whether the hold rule is for this card at all: an AI assignee on an open card that is past the queue. */
  private applies(task: Task, config: ProjectConfig): boolean {
    if (!isOpenTask(task) || isTheme(task) || !task.assignee) return false;
    if (memberOf(config, task.assignee)?.kind !== 'ai') return false;
    const stage = stageOf(config, task.stageId);
    return !!stage && stage.kind !== 'queue' && stage.kind !== 'done';
  }

  private blank(task: Task): TaskFixLimitRecord {
    return {
      taskKey: task.key,
      projectKey: task.projectKey,
      countedFrom: null,
      extraRounds: 0,
      holdPhase: null,
      heldAt: null,
      decider: null,
      deciders: [],
      reason: null,
      inboxItemId: null,
    };
  }

  /** `record` with no hold: the count stays as it was. */
  private cleared(record: TaskFixLimitRecord): TaskFixLimitRecord {
    return {
      ...record,
      holdPhase: null,
      heldAt: null,
      decider: null,
      deciders: [],
      reason: null,
      inboxItemId: null,
    };
  }

  private roundsOf(task: Task, config: ProjectConfig, record: TaskFixLimitRecord | null): FixRounds {
    const events = this.ctx.repos.timeline.roundEvents(task.projectKey, task.key);
    return countFixRounds(events, config, record?.countedFrom ?? null);
  }

  private limitOf(config: ProjectConfig, record: TaskFixLimitRecord | null): number {
    return maxFixRoundsOf(config.team.limits) + (record?.extraRounds ?? 0);
  }

  /**
   * The card reached the limit: the lead decides while fewer than three extra rounds were given since the
   * count began, the people when those are used up or there is no AI lead (PM-714).
   */
  private open(
    config: ProjectConfig,
    task: Task,
    record: TaskFixLimitRecord | null,
    rounds: FixRounds,
  ): void {
    const base = record ?? this.blank(task);
    if (base.extraRounds >= MAX_FIX_EXTRA_ROUNDS) {
      this.toOwner(config, task, base, rounds, 'extra_exhausted', null, null, null);
      return;
    }
    const lead = fixLimitLead(config, task.assignee ? [task.assignee] : []);
    if (!lead) {
      this.toOwner(config, task, base, rounds, 'no_ai_decider', null, null, null);
      return;
    }
    // The lead decides at its desk (PM-926): the decision is queued with the hold, in one write.
    const held: TaskFixLimitRecord = {
      ...base,
      holdPhase: 'lead',
      heldAt: isoNow(this.ctx),
      decider: lead,
      deciders: [],
      reason: null,
      inboxItemId: null,
    };
    this.ctx.unitOfWork(() => {
      this.ctx.repos.taskFixLimits.save(held);
      this.event(task, SYSTEM_ACTOR, config, rounds, { phase: 'reached', decider: lead });
      this.queue.openFixLimit({
        projectKey: task.projectKey,
        taskKey: task.key,
        heldAt: held.heldAt!,
        member: lead,
        title: this.leadNoticeOf(config, task, held, rounds),
      });
    });
    this.tasks.publish(this.tasks.get(task.projectKey, task.key));
  }

  /**
   * The AI decider let the obligation lapse (or, with `no_ai_decider`, cannot be reached at all): hand it
   * over through the existing decision routing.
   */
  async timeOut(
    projectKey: string,
    taskKey: string,
    decider: string,
    reason: 'decider_timeout' | 'no_ai_decider' = 'decider_timeout',
  ): Promise<{ decisionItemId: string } | null> {
    const config = await this.projects.config(projectKey);
    return this.cards.run(taskKey, async () => {
      const record = this.ctx.repos.taskFixLimits.get(taskKey);
      const task = this.tasks.find(projectKey, taskKey);
      if (
        !task ||
        !isOpenTask(task) ||
        record?.projectKey !== projectKey ||
        (record.holdPhase !== 'lead' && record.holdPhase !== 'replan') ||
        record.decider !== decider
      )
        return null;
      this.toOwner(config, task, record, this.roundsOf(task, config, record), reason, decider, null, null);
      const decisionItemId = this.ctx.repos.taskFixLimits.get(taskKey)?.inboxItemId;
      return decisionItemId ? { decisionItemId } : null;
    });
  }

  /** The rounds list of the current count: what the lead reads in its notice and the item carries. */
  private historyOf(
    task: Pick<Task, 'projectKey' | 'key'>,
    config: ProjectConfig,
    record: TaskFixLimitRecord | null,
  ): FixRoundHistoryEntry[] {
    const events = this.ctx.repos.timeline.roundEvents(task.projectKey, task.key);
    return fixRoundHistory(events, config, record?.countedFrom ?? null);
  }

  /** The outcomes that can be carried out on this card now (`replan` needs a planner, `reassign` another developer). */
  private executableOptions(config: ProjectConfig, task: Task): InboxOption[] {
    const options: InboxOption[] = [];
    if (this.plannerFor(config, task)) options.push(FIX_REPLAN_OPTION);
    if (this.otherDevelopers(config, task).length > 0) options.push(FIX_REASSIGN_OPTION);
    options.push(FIX_ANOTHER_ROUND_OPTION);
    return options;
  }

  /**
   * The lead's judgement that goes with `to_owner`: required, well formed, and recommending an outcome the
   * people can pick. Throws before anything changed.
   */
  private checkAssessment(config: ProjectConfig, task: Task, assessment: unknown): FixLimitAssessment {
    if (assessment === undefined || assessment === null)
      throw invalid(
        'fix_limit_assessment_required',
        'to_owner needs an assessment: whether the same fault comes back, where the work stands now, and the outcome you recommend',
      );
    const parsed = FixLimitAssessmentSchema.safeParse(assessment);
    if (!parsed.success)
      throw invalid('invalid_request', 'invalid assessment', { issues: parsed.error.issues });
    const available = this.executableOptions(config, task).map((option) => option.id);
    if (!available.includes(parsed.data.recommendation.optionId))
      throw invalid(
        'fix_limit_invalid_recommendation',
        `the recommended outcome ${parsed.data.recommendation.optionId} cannot be carried out now; choose one of: ${available.join(', ')}`,
        { available },
      );
    return parsed.data;
  }

  /**
   * The card goes to the people: one decision item with the buttons that apply, in the project's language,
   * addressed to the integrator when one is available. It carries the extra rounds, every round and, when the
   * lead passed the card on, its assessment.
   */
  private toOwner(
    config: ProjectConfig,
    task: Task,
    base: TaskFixLimitRecord,
    rounds: FixRounds,
    reason: NonNullable<TaskFixLimitRecord['reason']>,
    decider: string | null,
    note: string | null,
    assessment: FixLimitAssessment | null,
  ): void {
    const deciders = fixLimitDeciders(config, ownerHandles(config));
    const options = this.executableOptions(config, task);
    const limit = maxFixRoundsOf(config.team.limits) + base.extraRounds;
    const fixLimit: FixLimitDecisionPayload = {
      taskKey: task.key,
      rounds: rounds.rounds,
      limit,
      changeRequests: rounds.changeRequests,
      designChangeRequests: rounds.designChangeRequests,
      sendBacks: rounds.sendBacks,
      testsFailed: rounds.testsFailed,
      extraRounds: base.extraRounds,
      remainingExtraRounds: remainingFixExtraRounds(base.extraRounds),
      extraRoundLimit: MAX_FIX_EXTRA_ROUNDS,
      history: this.historyOf(task, config, base),
      ...(assessment ? { assessment } : {}),
      reason,
      decider,
      note,
    };
    this.ctx.unitOfWork(() => {
      this.closeLeadItem(base, 'handed_off');
      const item =
        deciders.length > 0
          ? this.inbox.createFixLimitDecision(config, {
              projectKey: task.projectKey,
              taskKey: task.key,
              assignees: deciders,
              fixLimit,
              options,
            })
          : null;
      this.ctx.repos.taskFixLimits.save({
        ...base,
        holdPhase: 'owner',
        heldAt: base.holdPhase ? (base.heldAt ?? isoNow(this.ctx)) : isoNow(this.ctx),
        decider: null,
        deciders,
        reason,
        inboxItemId: item?.id ?? null,
      });
      this.event(
        task,
        decider ? aiActor(decider) : SYSTEM_ACTOR,
        config,
        rounds,
        base.holdPhase
          ? {
              phase: 'passed_on',
              decider,
              deciders,
              reason,
              ...(note ? { note } : {}),
              ...(assessment ? { assessment } : {}),
            }
          : { phase: 'reached', deciders, reason },
      );
    });
    this.tasks.publish(this.tasks.get(task.projectKey, task.key));
  }

  /** Who makes a more exact plan when a person asks for one: not the implementer and not the lead who passed the card on. */
  private plannerFor(config: ProjectConfig, task: Task): string | null {
    return fixLimitPlannerForOwner(config, task.assignee);
  }

  /** The AI members who own the work stage and are not the card's assignee. */
  private otherDevelopers(config: ProjectConfig, task: Task): string[] {
    const stage = config.pipeline.stages.find((s) => s.kind === 'work');
    if (!stage) return [];
    return stageOwners(config, stage).filter(
      (handle) => handle !== task.assignee && memberOf(config, handle)?.kind === 'ai',
    );
  }

  /** The lead passed the card on to the people. */
  private passOn(
    config: ProjectConfig,
    task: Task,
    record: TaskFixLimitRecord,
    actor: Actor,
    reason: string,
    assessment: FixLimitAssessment,
  ): void {
    this.toOwner(
      config,
      task,
      record,
      this.roundsOf(task, config, record),
      'passed_on',
      actor.handle ?? null,
      reason,
      assessment,
    );
  }

  /** The planner is asked for a more exact plan: the hold stays until it lets the card go on. */
  private toPlanner(
    task: Task,
    record: TaskFixLimitRecord,
    planner: string,
    actor: Actor,
    reason: string | null,
  ): void {
    const config = this.projects.cachedConfig(task.projectKey);
    if (!config) return;
    const rounds = this.roundsOf(task, config, record);
    this.ctx.unitOfWork(() => {
      this.closeLeadItem(record, 'decided', actor);
      if (record.inboxItemId) this.inbox.resolveByRule(record.inboxItemId, 'ended', 'fix_limit_ended');
      this.ctx.repos.taskFixLimits.save({
        ...record,
        holdPhase: 'replan',
        decider: planner,
        deciders: [],
        reason: null,
        inboxItemId: null,
      });
      this.event(task, actor, config, rounds, {
        phase: 'decided',
        decision: 'replan',
        decider: planner,
        by: actor.handle ?? 'system',
        ...(reason ? { note: reason } : {}),
      });
    });
    this.tasks.publish(this.tasks.get(task.projectKey, task.key));
    this.tell(task, planner, plannerNotice(task, rounds, reason));
  }

  /** One round more is allowed: the count goes on, the hold ends and the waiting messages are let through. */
  private anotherRound(task: Task, record: TaskFixLimitRecord, actor: Actor, reason: string | null): void {
    this.release(task, record, actor, 'another_round', reason, {
      ...this.cleared(record),
      extraRounds: record.extraRounds + 1,
    });
  }

  /** The count begins anew (the planner released the card, another implementer takes it). */
  private freshStart(
    task: Task,
    record: TaskFixLimitRecord,
    actor: Actor,
    decision: 'continue' | 'reassign',
    reason: string | null,
    wake = true,
  ): void {
    this.release(
      task,
      record,
      actor,
      decision,
      reason,
      { ...this.cleared(record), countedFrom: isoNow(this.ctx), extraRounds: 0 },
      wake,
    );
  }

  /** `wake` is false when the messages that waited stay where they are (the card goes to another assignee). */
  private release(
    task: Task,
    record: TaskFixLimitRecord,
    actor: Actor,
    decision: NonNullable<FixLimitEvent['decision']>,
    reason: string | null,
    next: TaskFixLimitRecord,
    wake = true,
  ): void {
    const config = this.projects.cachedConfig(task.projectKey);
    const rounds = config ? this.roundsOf(task, config, record) : null;
    this.ctx.unitOfWork(() => {
      this.closeLeadItem(record, 'decided', actor);
      if (record.inboxItemId) this.inbox.resolveByRule(record.inboxItemId, 'ended', 'fix_limit_ended');
      this.ctx.repos.taskFixLimits.save(next);
      if (config && rounds)
        this.event(task, actor, config, rounds, {
          phase: 'decided',
          decision,
          by: actor.handle ?? 'system',
          ...(reason ? { note: reason } : {}),
        });
    });
    this.tasks.publish(this.tasks.get(task.projectKey, task.key));
    if (wake) this.releaseMessages(task);
  }

  /** The hold ended without a decision: its item closes by the system. */
  private finish(
    task: Task,
    record: TaskFixLimitRecord,
    endReason: NonNullable<FixLimitEvent['endReason']>,
  ): void {
    const config = this.projects.cachedConfig(task.projectKey);
    this.ctx.unitOfWork(() => {
      this.closeLeadItem(record, 'ended');
      if (record.inboxItemId) this.inbox.resolveByRule(record.inboxItemId, 'ended', 'fix_limit_ended');
      this.ctx.repos.taskFixLimits.save(this.cleared(record));
      if (config)
        this.event(task, SYSTEM_ACTOR, config, this.roundsOf(task, config, record), {
          phase: 'ended',
          endReason,
        });
    });
    this.tasks.publish(this.tasks.get(task.projectKey, task.key));
  }

  /** Another implementer takes the card: the first one stops, the count begins anew, a person's start picks the next one. */
  private async reassign(
    task: Task,
    record: TaskFixLimitRecord,
    actor: Actor,
    note: string | null,
  ): Promise<void> {
    const previous = task.assignee;
    // The first implementer's own session stays until the handoff (PM-342) took its note; the others stop.
    await this.sessions.stopTask(
      task.projectKey,
      task.key,
      { kind: 'fix_limit_reassign', by: actor },
      { except: previous },
    );
    // The messages that waited stay with the first implementer: waking it would start a session on a card it no longer has.
    this.freshStart(task, record, actor, 'reassign', note, false);
    this.tasks.assign(task.projectKey, task.key, null, actor, {
      reason: 'handover',
      handoff: 'fix_limit_reassign',
    });
    try {
      await this.starts.start(task.projectKey, task.key, {
        actor,
        author: SYSTEM_AUTHOR,
        excludeMembers: previous ? [previous] : [],
      });
    } catch (err) {
      this.ctx.logger.warn(
        { err, taskKey: task.key },
        'could not start another implementer after the fix round limit; the card is left unassigned',
      );
    }
  }

  /**
   * The assignee is told the card goes on, by whom and why: typed into its running session, or the first
   * input of a new one. One that does not run is started (PM-420): the messages that waited for the end
   * of the hold may be none, and then nothing else would wake it. A start admission refuses now (the member
   * or the team is at its limit) is stored as a message and waits like any other wake-up.
   */
  private async tellAssignee(task: Task, by: string, reason: string | null): Promise<void> {
    if (!task.assignee) return;
    const running = this.sessions.findRunning(task.projectKey, task.assignee, {
      type: 'task',
      taskKey: task.key,
    });
    const text = [
      `The fix round limit on ${task.key} was lifted by ${by}: you can go on with the open change requests.`,
      reason ? `Reason: ${reason}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    if (running) this.delivery.notice(running, 'projectman', text, task.key);
    else this.tell(task, task.assignee, text);
  }

  /** A decider (or the released assignee) is told in the background: the hold does not wait for a session. */
  private tell(task: Task, handle: string, text: string): void {
    this.notify(task, handle, text).catch((err: unknown) => {
      this.ctx.logger.warn(
        { err, taskKey: task.key, member: handle },
        'could not tell the fix limit decider or the released assignee',
      );
    });
  }

  /**
   * A notice that is not stored as a team message (PM-261's pattern): typed into the member's running
   * session of the card, or the first input of a new one. Only when admission cannot start it now (the
   * member or the team is at its limit) is it stored, so it still reaches the member with its next session.
   */
  private async notify(task: Task, handle: string, text: string): Promise<void> {
    const workItem = { type: 'task', taskKey: task.key } as const;
    const running = this.sessions.findRunning(task.projectKey, handle, workItem);
    // A paused session takes nothing in: the notice is stored below (admission refuses with `team_paused`).
    if (running && !this.sessions.isPaused(running)) {
      this.delivery.notice(running, 'projectman', text, task.key);
      return;
    }
    const config = await this.projects.config(task.projectKey);
    const member = memberOf(config, handle);
    if (member?.kind !== 'ai') return;
    try {
      const fixLimit = this.timeline.latest(task.projectKey, task.key, 'task_fix_limit');
      await this.delivery.startAndDeliver(task.projectKey, handle, workItem, (messages) =>
        this.admission.start({
          config,
          member,
          workItem,
          cause: {
            kind: 'fix_limit',
            eventId: fixLimit?.id,
            rounds: fixLimit?.data.rounds as number | undefined,
            limit: fixLimit?.data.limit as number | undefined,
          },
          messages: [...messages, formatInjectedTeamMessage('projectman', text, task.key)],
        }),
      );
    } catch (err) {
      this.ctx.logger.info({ err, taskKey: task.key, member: handle }, 'fix limit notice stored for later');
      await this.messaging.send(
        task.projectKey,
        'system',
        { to: [handle], text, taskKey: task.key },
        { actor: SYSTEM_ACTOR },
      );
    }
  }

  private event(
    task: Pick<Task, 'projectKey' | 'key'>,
    actor: Actor,
    config: ProjectConfig,
    rounds: FixRounds,
    data: Pick<FixLimitEvent, 'phase'> & Partial<FixLimitEvent>,
  ): void {
    const record = this.ctx.repos.taskFixLimits.get(task.key);
    this.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_fix_limit',
      data: {
        rounds: rounds.rounds,
        limit: this.limitOf(config, record),
        changeRequests: rounds.changeRequests,
        designChangeRequests: rounds.designChangeRequests,
        sendBacks: rounds.sendBacks,
        testsFailed: rounds.testsFailed,
        // The extra rounds as the decision left them (the record is saved before its event).
        extraRounds: record?.extraRounds ?? 0,
        remainingExtraRounds: remainingFixExtraRounds(record?.extraRounds ?? 0),
        ...data,
      },
    });
  }
}

/** What the lead developer is told when a card reached the limit. */
function leadNotice(
  task: Task,
  rounds: FixRounds,
  limit: number,
  can: { replan: boolean; reassign: boolean },
  extraRounds: number,
  history: readonly FixRoundHistoryEntry[],
): string {
  const recommendable = [can.replan ? 'replan' : null, can.reassign ? 'reassign' : null, 'another_round']
    .filter(Boolean)
    .join(', ');
  const left = remainingFixExtraRounds(extraRounds);
  const summary = [
    `${task.key} has had ${rounds.rounds} fix rounds (the limit is ${limit}): ${rounds.changeRequests} code review change requests,`,
    `${rounds.designChangeRequests} UI/UX change requests and ${rounds.sendBacks} send-backs (${rounds.testsFailed} of them failed full tests).`,
    `Extra rounds given so far: ${extraRounds} of ${MAX_FIX_EXTRA_ROUNDS}; you can give ${left} more, after that the people decide at every limit.`,
    `Its implementer ${task.assignee ?? ''} is held back: what AI members write to it waits.`,
    `Read the card and decide with decide_fix_limit (task_key ${task.key}, a reason in one or two sentences):`,
    '"continue" lets the implementer have one more round;',
    can.replan ? '"replan" asks another technical direction holder for a more exact plan first;' : null,
    '"to_owner" gives the decision to the people and REQUIRES an assessment:',
    'recurrence (one sentence: does the same fault come back), current_state (where the work stands now)',
    `and recommendation (option_id: one of ${recommendable}, and its reason).`,
  ]
    .filter(Boolean)
    .join(' ');
  return history.length > 0
    ? `${summary}\nEvery round so far:\n${history.map(historyLine).join('\n')}`
    : summary;
}

/** One round of the list a decider reads, in English: the marker, the time, who, what and the note. */
function historyLine(entry: FixRoundHistoryEntry): string {
  const marker =
    entry.kind === 'extra_round'
      ? `+${entry.extraRound ?? 0}`
      : entry.round === null
        ? '-'
        : `${entry.round}.`;
  const what =
    entry.kind === 'tests_failed'
      ? `failed full test${entry.command ? ` (${entry.command})` : ''}`
      : entry.kind === 'branch_moved'
        ? 'branch moved (not counted)'
        : entry.kind === 'extra_round'
          ? 'one more round was given'
          : entry.kind.replace('_', ' ');
  const note = entry.note ? `: ${entry.note}` : '';
  return `${marker} ${entry.at.slice(0, 16).replace('T', ' ')} ${entry.actor.handle ?? 'system'} - ${what}${note}`;
}

/** What the planner is told when the lead asks it for a more exact plan. */
function plannerNotice(task: Task, rounds: FixRounds, reason: string | null): string {
  return [
    `The lead developer asked you for a more exact plan for ${task.key}, which has had ${rounds.rounds} fix rounds.`,
    reason ? `Its reason: ${reason}` : null,
    `Read the card and its timeline, write the plan on the card (a note or the description), then release it with decide_fix_limit (task_key ${task.key}, decision "continue", a reason):`,
    'the implementer then starts a new count with your plan. If a person has to decide instead, use "to_owner".',
  ]
    .filter(Boolean)
    .join(' ');
}
