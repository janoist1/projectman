import {
  SYSTEM_SENDER,
  cardMoverHandle,
  compareStartOrder,
  developmentStage,
  isHandleOnLeave,
  isOpenTask,
  memberOf,
  operatorOf,
  planStarts,
  projectManagerOf,
  pullSourceStage,
  seniorsOf,
  stageOwners,
  startableCards,
} from '@projectman/shared';
import type {
  FocusPlace,
  ProjectConfig,
  StartPlanEntry,
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
import type { ProjectFocusService, TaskService, TaskWaits } from '../../core/tasks';
import type { Admission, StartRounding } from './admission';
import type { SeniorWaits } from './senior-waits';

interface ProjectRound {
  sourceStageId: string;
  frame: TaskReadyHold | null;
  holds: Map<string, TaskReadyHold>;
  /** The cards the round offers or pulls: an open offer on one of them stands. */
  wanted: Set<string>;
  /** The open `start` offers of the project's cards, by card key. */
  offers: Map<string, TaskStartOffer>;
}

/** The part of the obligation tracking the round needs (the assembly adapts `ObligationsService.open`). */
export interface StartOfferObligations {
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
  focus: Pick<ProjectFocusService, 'covered'>;
  seniorWaits: Pick<SeniorWaits, 'decisionFor'>;
  admission: Pick<Admission, 'freeDevelopers' | 'startFrame' | 'engineOffline'>;
  messaging: Pick<Messaging, 'send'>;
  waits: Pick<TaskWaits, 'of'>;
}

/**
 * Computes intentional queue waits after the focus pull, and asks the card mover to start the cards that can
 * start now (PM-804): one `start` obligation per card, then one action message per card or collecting card.
 * The round never starts a card itself (decision 3 of PM-427); the obligation tracking reminds the mover.
 */
export class StartRound implements StartRounding {
  private readonly states = new Map<string, ProjectRound>();
  private active: Promise<void> | null = null;
  private readonly deps: StartRoundDeps;
  private obligations: StartOfferObligations | undefined;

  constructor(deps: StartRoundDeps) {
    this.deps = deps;
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
    const state = this.stateOfQueued(task);
    if (!state || state.frame || state.holds.has(task.key) || !state.wanted.has(task.key)) return undefined;
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
    if (state.frame || state.holds.has(taskKey)) return 'paused';
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

  private stateOfQueued(task: Task): ProjectRound | undefined {
    const state = this.states.get(task.projectKey);
    if (!state || task.stageId !== state.sourceStageId || task.status !== 'active' || task.assignee)
      return undefined;
    return state;
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
    const { ctx, projects, tasks, focus, seniorWaits, admission } = this.deps;
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
      frame: null,
      holds: new Map(),
      wanted: new Set(),
      offers: new Map(live.map((row) => [row.taskKey, { to: row.responsible, since: row.openedAt }])),
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
    const cards = startableCards({
      config,
      tasks: startContext(tasks, key, queued),
      fromStageId: source.id,
      toStageId: development.id,
    });
    const owners = stageOwners(config, development);
    const seniors = seniorsOf(config, development)
      .map((member) => member.handle)
      .filter((handle) => owners.includes(handle));
    const anyDecided = new Set(
      cards
        .filter((card) => seniorWaits.decisionFor(key, card.key)?.decision === 'any')
        .map((card) => card.key),
    );
    const places = focus.covered(key).places;
    const plan = planStarts({
      cards,
      places,
      free,
      seniors,
      anyDecided,
      offered: new Set(live.map((row) => row.taskKey)),
    });
    for (const [taskKey, entry] of plan) {
      if (entry.kind === 'hold') {
        const { kind: _kind, ...hold } = entry;
        state.holds.set(taskKey, keepSince({ ...hold, since }, old?.frame ?? old?.holds.get(taskKey)));
      } else state.wanted.add(taskKey);
    }
    // The state is set before the offers open: the obligation tracking asks the round about every row it reads.
    this.states.set(key, state);
    await this.offer({ config, state, cards, plan, places, toStageId: development.id });
  }

  /** The cards without an open offer that the plan offers now: the obligation opens, then the message goes. */
  private async offer(round: {
    config: ProjectConfig;
    state: ProjectRound;
    cards: readonly Task[];
    plan: ReadonlyMap<string, StartPlanEntry>;
    places: ReadonlyMap<string, FocusPlace>;
    toStageId: string;
  }): Promise<void> {
    const { config, state, cards, plan, places, toStageId } = round;
    const { ctx, tasks, messaging } = this.deps;
    const projectKey = config.project.key;
    const recipient =
      cardMoverHandle(config) ?? projectManagerOf(config)?.handle ?? operatorOf(config)?.handle;
    // A member on leave is not started, so an offer to them would only stand and pause (decision 23): the
    // round offers again once they are back, and the Operator's ready signal covers the time between.
    if (!recipient || memberOf(config, recipient)?.kind !== 'ai' || !this.obligations) return;
    if (isHandleOnLeave(config, recipient)) return;
    const fresh = cards
      .filter((card) => plan.get(card.key)?.kind === 'offer' && !state.offers.has(card.key))
      .sort((a, b) => compareStartOrder(a, b, places));
    if (fresh.length === 0) return;
    // The parts of a collecting card go together, the other cards alone, in the order of their first card.
    const groups = new Map<string, Task[]>();
    for (const card of fresh) {
      const subject = card.parentKey ?? card.key;
      groups.set(subject, [...(groups.get(subject) ?? []), card]);
    }
    const parents = [...groups.keys()].filter((subject) => groups.get(subject)![0]!.parentKey);
    const siblings =
      parents.length === 0
        ? []
        : tasks.readSchedulingTasks(projectKey, { kind: 'children', parentKeys: parents });
    const backStageId = config.pipeline.stages[0]?.id ?? toStageId;
    for (const [subjectKey, group] of groups) {
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
