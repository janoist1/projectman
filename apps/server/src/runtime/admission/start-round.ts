import {
  SYSTEM_SENDER,
  cardMoverHandle,
  compareStartOrder,
  developmentStage,
  isHandleOnLeave,
  isOpenTask,
  memberOf,
  planStarts,
  projectManagerOf,
  pullSourceStage,
  stageDevelopers,
  stageOwners,
  startableCards,
  tempMaxPointsOf,
} from '@projectman/shared';
import type {
  ProjectConfig,
  StartPlanEntry,
  Stage,
  Task,
  TaskReadyHold,
  TaskStartOffer,
} from '@projectman/shared';
import { collectorNotReadyText, startOfferText, taskWaitShort } from '../../agent-text';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import type { Messaging } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import { startContext } from '../../core/tasks';
import type { TaskService, TaskWaits } from '../../core/tasks';
import type { Admission, StartRounding } from './admission';
import type { SeniorWaits } from './senior-waits';
import { DomainError } from '../../kernel';

interface ProjectRound {
  sourceStageId: string;
  /** The work stage, where an assigned card nobody started waits for its start (PM-879). */
  workStageId: string;
  frame: TaskReadyHold | null;
  holds: Map<string, TaskReadyHold>;
  /** The cards the round offers or pulls: an open offer on one of them stands. */
  wanted: Set<string>;
  /** The open `start` offers of the project's cards, by card key. */
  offers: Map<string, TaskStartOffer>;
  /** Admission refusals already reported, by card, developer and reason. */
  refusals: Map<string, string>;
}

/** The part of the obligation tracking the round needs (the assembly adapts `ObligationsService.open`). */
interface StartOfferObligations {
  open(input: {
    projectKey: string;
    taskKey: string;
    responsible: string;
    subject: string;
    openedAt: string;
  }): void;
}

interface StartRoundDeps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'config'>;
  tasks: Pick<TaskService, 'readSchedulingTasks'>;
  seniorWaits: Pick<SeniorWaits, 'decisionFor'>;
  admission: Pick<
    Admission,
    'freeDevelopers' | 'startFrame' | 'engineOffline' | 'check' | 'canReplaceAssignee'
  >;
  messaging: Pick<Messaging, 'send'>;
  waits: Pick<TaskWaits, 'of'>;
}

/**
 * Computes intentional queue waits after the urgent pull, and asks the card mover to start the cards that can
 * start now (PM-804): one `start` obligation per card, then one action message per card or collecting card.
 * The round never starts a card itself (decision 3 of PM-427); the obligation tracking reminds the mover.
 */
export class StartRound implements StartRounding {
  private readonly states = new Map<string, ProjectRound>();
  private active: Promise<void> | null = null;
  private readonly deps: StartRoundDeps;
  private obligations: StartOfferObligations | undefined;
  private fixLimit: { heldFor(task: Task, config: ProjectConfig): boolean } | undefined;

  constructor(deps: StartRoundDeps) {
    this.deps = deps;
  }

  /** Binds the fix round limit (PM-262), which is built after the round: a card it holds is not offered. */
  useFixLimit(fixLimit: { heldFor(task: Task, config: ProjectConfig): boolean }): void {
    this.fixLimit = fixLimit;
  }

  /** Binds the obligation tracking, which is built after the round (it asks the round about its offers). */
  useObligations(obligations: StartOfferObligations): void {
    this.obligations = obligations;
  }

  run(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.round().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  holdOf(task: Task): TaskReadyHold | undefined {
    const state = this.stateOfQueued(task);
    return state && (state.frame ?? state.holds.get(task.key));
  }

  /** The open offer to start the card, while the round still stands behind it (a hold or a frame shows the hold). */
  startOfferOf(task: Task): TaskStartOffer | undefined {
    const state = this.stateOfQueued(task, true);
    if (
      !state ||
      state.frame ||
      state.holds.has(task.key) ||
      state.refusals.has(task.key) ||
      !state.wanted.has(task.key)
    )
      return undefined;
    return state.offers.get(task.key);
  }

  /**
   * How the round sees the open offer of a card, for the obligation tracking: it stands (`offered`), a frame
   * lock or a hold keeps the card for now (`paused`), or the card is not among the startable ones any more
   * (`ended`). Null: the round has no view of the project now.
   */
  offerState(projectKey: string, taskKey: string): 'offered' | 'paused' | 'ended' | null {
    const state = this.states.get(projectKey);
    if (!state) return null;
    if (this.started(projectKey, taskKey, state)) return 'ended';
    if (state.frame || state.holds.has(taskKey) || state.refusals.has(taskKey)) return 'paused';
    return state.wanted.has(taskKey) ? 'offered' : 'ended';
  }

  /**
   * A card has just been worked out (PM-804). A card that can start needs no message of its own: the next
   * round offers it, or writes its hold. Only a collecting card none of whose open parts can start yet tells
   * the recipient so, once, without an obligation: each part gets its own message when it can start.
   */
  async refined(task: Task, recipient: string): Promise<void> {
    const { ctx, projects, tasks, messaging, waits } = this.deps;
    try {
      const config = await projects.config(task.projectKey);
      const source = pullSourceStage(config);
      const development = developmentStage(config);
      if (!source || !development) return;
      const parts = tasks
        .readSchedulingTasks(task.projectKey, { kind: 'children', parentKeys: [task.key] })
        .filter(isOpenTask);
      if (parts.length === 0) return;
      const queued = tasks.readSchedulingTasks(task.projectKey, { kind: 'queue', stageId: source.id });
      const startable = startableCards({
        config,
        tasks: startContext(tasks, task.projectKey, queued),
        fromStageId: source.id,
        toStageId: development.id,
      });
      if (startable.some((card) => card.parentKey === task.key)) return;
      await messaging.send(
        task.projectKey,
        SYSTEM_SENDER,
        {
          to: [recipient],
          taskKey: task.key,
          text: collectorNotReadyText({ key: task.key, parts: this.waitingParts(config, parts, new Map()) }),
        },
        { kind: 'info' },
      );
    } catch (err) {
      ctx.logger.warn({ err, taskKey: task.key, recipient }, 'refinement completion notice failed');
    }
  }

  /** The card is in the work stage and its assignee has a session on it: the offer to start it is answered (PM-879). */
  private started(projectKey: string, taskKey: string, state: ProjectRound): boolean {
    const { repos } = this.deps.ctx;
    const task = repos.tasks.get(taskKey);
    return (
      !!task?.assignee &&
      task.stageId === state.workStageId &&
      !!repos.sessions.findByWorkItem(projectKey, task.assignee, { type: 'task', taskKey })
    );
  }

  /** The round's view of a card in the source stage; with `inWork` also of one in the work stage (PM-879). */
  private stateOfQueued(task: Task, inWork = false): ProjectRound | undefined {
    const state = this.states.get(task.projectKey);
    if (!state || task.status !== 'active') return undefined;
    if (task.stageId === state.sourceStageId || (inWork && task.stageId === state.workStageId)) return state;
    return undefined;
  }

  /**
   * The cards of the work stage whose assignee has not started them (PM-879): an AI member is the assignee,
   * who has no session on the card at all, no handoff is open on it and the fix round limit does not hold
   * it. Going forward into the work stage is the Start button's business (PM-119), so nothing else starts them.
   */
  private unstarted(config: ProjectConfig, work: Stage): Task[] {
    const { ctx, tasks } = this.deps;
    const projectKey = config.project.key;
    const stored = tasks.readSchedulingTasks(projectKey, { kind: 'queue', stageId: work.id });
    const mine = stored.filter((task) => task.assignee && memberOf(config, task.assignee)?.kind === 'ai');
    if (mine.length === 0) return [];
    const ofMine = new Set(mine.map((task) => task.key));
    return startableCards({
      config,
      tasks: startContext(tasks, projectKey, mine),
      fromStageId: work.id,
      toStageId: work.id,
      assigned: true,
    }).filter(
      (task) =>
        ofMine.has(task.key) &&
        !ctx.repos.sessions.findByWorkItem(projectKey, task.assignee!, { type: 'task', taskKey: task.key }) &&
        !ctx.repos.taskHandoffs.open(task.key) &&
        !this.fixLimit?.heldFor(task, config),
    );
  }

  private async round(): Promise<void> {
    const { ctx } = this.deps;
    const projects = ctx.repos.projects.list();
    const keys = new Set(projects.map(({ key }) => key));
    for (const key of this.states.keys()) if (!keys.has(key)) this.states.delete(key);
    for (const { key } of projects) {
      try {
        await this.forProject(key);
      } catch (err) {
        this.states.delete(key);
        ctx.logger.warn({ err, projectKey: key }, 'start round failed for a project');
      }
    }
  }

  private async forProject(key: string): Promise<void> {
    const { ctx, projects, tasks, seniorWaits, admission } = this.deps;
    const config = await projects.config(key).catch(() => null);
    const source = config && pullSourceStage(config);
    const development = config && developmentStage(config);
    if (!config || !source || !development) {
      this.states.delete(key);
      return;
    }
    const previous = this.states.get(key);
    const old = previous?.sourceStageId === source.id ? previous : undefined;
    const since = isoNow(ctx);
    const keepSince = (hold: TaskReadyHold, prior?: TaskReadyHold | null): TaskReadyHold => ({
      ...hold,
      since: prior?.reason === hold.reason ? prior.since : since,
    });
    // The open offers are read first: they stay with their developer, and they stand while a frame holds.
    const live = ctx.repos.obligations.listLive(key).filter((row) => row.kind === 'start');
    const state: ProjectRound = {
      sourceStageId: source.id,
      workStageId: development.id,
      frame: null,
      holds: new Map(),
      wanted: new Set(),
      offers: new Map(live.map((row) => [row.taskKey, { to: row.responsible, since: row.openedAt }])),
      refusals: new Map(),
    };
    const frame = (hold: TaskReadyHold) => {
      state.frame = keepSince(hold, old?.frame);
      this.states.set(key, state);
    };
    const reason = admission.startFrame(config);
    if (reason) {
      frame({ reason, since });
      return;
    }
    const available = admission.freeDevelopers(config, development.id);
    if (available.length === 0) {
      frame({ reason: 'no_free_member', since });
      return;
    }
    const offline = available.map((member) => admission.engineOffline(key, member.handle));
    const free = available.filter((_member, index) => offline[index] === null);
    if (free.length === 0) {
      const engines = new Set(offline.flatMap((entry) => (entry?.engine ? [entry.engine] : [])));
      const engine = engines.size === 1 ? [...engines][0] : undefined;
      frame({ reason: 'engine_offline', since, ...(engine ? { engine } : {}) });
      return;
    }
    const queued = tasks.readSchedulingTasks(key, { kind: 'queue', stageId: source.id });
    const cards = [
      ...startableCards({
        config,
        tasks: startContext(tasks, key, queued),
        fromStageId: source.id,
        toStageId: development.id,
        assigned: true,
      }),
      ...this.unstarted(config, development),
    ];
    const owners = stageOwners(config, development);
    const developers = stageDevelopers(config, development).filter((developer) =>
      owners.includes(developer.handle),
    );
    const anyDecided = new Set(
      cards
        .filter((card) => seniorWaits.decisionFor(key, card.key)?.decision === 'any')
        .map((card) => card.key),
    );
    // An assigned card whose assignee's provider is on hold and who has not begun it goes to another member (PM-1051).
    const reassignableTaskKeys = new Set(
      cards
        .filter(
          (card) =>
            card.assignee &&
            owners.includes(card.assignee) &&
            admission.canReplaceAssignee(config, card, {
              fixLimitHeld: () => !!this.fixLimit?.heldFor(card, config),
            }),
        )
        .map((card) => card.key),
    );
    // The cards with their parents and themes: a priority they carry ranks the card (`effectivePriority`).
    const context = startContext(tasks, key, cards);
    const plan = planStarts({
      cards,
      tasks: context,
      free,
      developers,
      anyDecided,
      tempMaxPoints: tempMaxPointsOf(config),
      offered: new Set(live.map((row) => row.taskKey)),
      reassignableTaskKeys,
    });
    for (const [taskKey, entry] of plan) {
      if (entry.kind === 'hold') {
        const { kind: _kind, ...hold } = entry;
        state.holds.set(taskKey, keepSince({ ...hold, since }, old?.frame ?? old?.holds.get(taskKey)));
      } else state.wanted.add(taskKey);
    }
    // The state is set before the offers open: the obligation tracking asks the round about every row it reads.
    this.states.set(key, state);
    for (const card of cards) {
      const entry = plan.get(card.key);
      if (entry?.kind !== 'offer') continue;
      const member = memberOf(config, entry.developer);
      if (member?.kind !== 'ai') continue;
      try {
        await admission.check({ config, member, workItem: { type: 'task', taskKey: card.key } });
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        const refusal = `${card.stageId}:${member.handle}:${err.code}`;
        state.refusals.set(card.key, refusal);
        if (old?.refusals.get(card.key) === refusal) continue;
        const recipient = cardMoverHandle(config) ?? projectManagerOf(config)?.handle;
        if (recipient && memberOf(config, recipient)?.kind === 'ai' && !isHandleOnLeave(config, recipient))
          await this.deps.messaging.send(
            key,
            SYSTEM_SENDER,
            {
              to: [recipient],
              taskKey: card.parentKey ?? card.key,
              text: `${card.key} cannot start: ${member.handle} is blocked (${err.code}). The system will offer it when admission allows the start.`,
            },
            { kind: 'info' },
          );
      }
    }
    await this.offer({ config, state, cards, context, plan, toStageId: development.id });
  }

  /** The cards without an open offer that the plan offers now: the obligation opens, then the message goes. */
  private async offer(round: {
    config: ProjectConfig;
    state: ProjectRound;
    cards: readonly Task[];
    /** The cards with their parents and themes, for the start order. */
    context: readonly Task[];
    plan: ReadonlyMap<string, StartPlanEntry>;
    toStageId: string;
  }): Promise<void> {
    const { config, state, cards, context, plan, toStageId } = round;
    const { ctx, tasks, messaging } = this.deps;
    const projectKey = config.project.key;
    const recipient = cardMoverHandle(config) ?? projectManagerOf(config)?.handle;
    // A member on leave is not started, so an offer to them would only stand and pause (decision 23): the
    // round offers again once they are back.
    if (!recipient || memberOf(config, recipient)?.kind !== 'ai' || !this.obligations) return;
    if (isHandleOnLeave(config, recipient)) return;
    const fresh = cards
      .filter(
        (card) =>
          plan.get(card.key)?.kind === 'offer' &&
          !state.offers.has(card.key) &&
          !state.refusals.has(card.key),
      )
      .sort((a, b) => compareStartOrder(a, b, context));
    if (fresh.length === 0) return;
    // The parts of a collecting card go together, the other cards alone, in the order of their first card.
    // An assigned card is started with start_task, not moved (a move starts nobody), so it has its own message.
    const groups = new Map<string, Task[]>();
    const subjectOf = (card: Task) => card.parentKey ?? card.key;
    for (const card of fresh) {
      const id = `${card.assignee ? 'assigned' : 'free'}:${subjectOf(card)}`;
      groups.set(id, [...(groups.get(id) ?? []), card]);
    }
    const parents = [
      ...new Set([...groups.values()].map((group) => group[0]!).filter((card) => card.parentKey)),
    ].map((card) => card.parentKey!);
    const siblings =
      parents.length === 0
        ? []
        : tasks.readSchedulingTasks(projectKey, { kind: 'children', parentKeys: parents });
    const backStageId = config.pipeline.stages[0]?.id ?? toStageId;
    for (const group of groups.values()) {
      const subjectKey = subjectOf(group[0]!);
      const collector = group[0]!.parentKey === subjectKey;
      const at = isoNow(ctx);
      try {
        for (const card of group) {
          this.obligations.open({
            projectKey,
            taskKey: card.key,
            responsible: recipient,
            subject: `offer@${at}`,
            openedAt: at,
          });
          state.offers.set(card.key, { to: recipient, since: at });
        }
      } catch (err) {
        ctx.logger.warn({ err, projectKey, taskKey: subjectKey }, 'could not open the start offer');
        continue;
      }
      try {
        const named = new Set(group.map((card) => card.key));
        await messaging.send(
          projectKey,
          SYSTEM_SENDER,
          {
            to: [recipient],
            taskKey: subjectKey,
            text: startOfferText({
              subjectKey,
              collector,
              cards: group.map((card) => ({ key: card.key, title: card.title })),
              waiting: collector
                ? this.waitingParts(
                    config,
                    siblings.filter(
                      (part) => part.parentKey === subjectKey && isOpenTask(part) && !named.has(part.key),
                    ),
                    state.holds,
                  )
                : [],
              toStageId,
              backStageId,
              ...(group[0]!.assignee ? { assigned: true } : {}),
            }),
          },
          { kind: 'action' },
        );
      } catch (err) {
        // The obligation stays open: its reminder makes up for the message.
        ctx.logger.warn({ err, projectKey, taskKey: subjectKey }, 'could not send the start offer');
      }
    }
  }

  /** Why each of the parts does not start now, in the words of `list_tasks`. */
  private waitingParts(
    config: ProjectConfig,
    parts: readonly Task[],
    holds: ReadonlyMap<string, TaskReadyHold>,
  ): { key: string; why: string }[] {
    const shown = parts.map((part) => {
      const hold = holds.get(part.key);
      return hold ? { ...part, readyHold: hold } : part;
    });
    const waits = this.deps.waits.of(config, shown);
    return shown.map((part) => {
      const wait = waits.get(part.key);
      return { key: part.key, why: wait ? taskWaitShort(wait) : part.status };
    });
  }
}
