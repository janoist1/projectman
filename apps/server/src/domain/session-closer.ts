import {
  hasStepOnTask,
  isMergeRunningFor,
  isOpenTask,
  isRefining,
  isReturnedWorkLabel,
  isSessionAtWork,
  labelDefinition,
  OPERATOR_GUEST_IDLE_CLOSE_MINUTES,
  reviewReturnedWork,
  SESSION_IDLE_CLOSE_MINUTES,
  SESSION_HEAVY_RUN_IDLE_MAX_MINUTES,
  stageIndex,
} from '@projectman/shared';
import type { EngineId, ProjectConfig, Session, SessionStop, Task } from '@projectman/shared';
import type { EngineDirectory } from '../contracts';
import { engineIdOf } from './engines';
import type { DomainContext } from './context';
import type { MessageDelivery, Messaging } from './messaging';
import type { ProjectService } from './projects';
import type { RefinementSteps } from './admission';
import type { SessionOrchestrator } from './sessions';
import type { StageChange, TaskService } from './tasks';

const MINUTE_MS = 60_000;

/**
 * Closes the sessions that are done (PM-288), so that their CLI processes do not hold the machine's
 * memory. A session closes when its member's step on the card is done (the card moved on, or the
 * refinement turn passed to another member), or after `SESSION_IDLE_CLOSE_MINUTES` of silence. It never
 * closes while it works, nor a meeting's. The session of a member whose merge the server queues or runs
 * closes at once as well, as the member has nothing to wait for (PM-552). The session of a member that
 * gave the card's work back closes at the first idle moment after the verdict (PM-570). The conversation stays: a message, an answer or a hand-over
 * resumes it. A session that is in a turn when its step ends is marked, and closes at its next idle
 * moment (`sessionIdle`); the periodic `sweep` catches what no event did.
 */
export class SessionCloser {
  private readonly ctx: DomainContext;
  private readonly engines: Pick<EngineDirectory, 'get'>;
  private readonly heavySeenAt = new Map<string, number>();
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly refinement: Pick<RefinementSteps, 'turnMember'>;
  private readonly messaging: Pick<Messaging, 'holdsMessagesOf' | 'wakeWaiting'>;
  private readonly delivery: Pick<MessageDelivery, 'deliverWaiting'>;

  constructor(deps: {
    ctx: DomainContext;
    engines: Pick<EngineDirectory, 'get'>;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    refinement: Pick<RefinementSteps, 'turnMember'>;
    messaging: Pick<Messaging, 'holdsMessagesOf' | 'wakeWaiting'>;
    delivery: Pick<MessageDelivery, 'deliverWaiting'>;
  }) {
    this.ctx = deps.ctx;
    this.engines = deps.engines;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.refinement = deps.refinement;
    this.messaging = deps.messaging;
    this.delivery = deps.delivery;
  }

  /**
   * The card changed stage: the running sessions of members that have no step on it any more close, once
   * they are idle. A card that is done or cancelled is the done-task cleanup's business.
   */
  async stageChanged(change: StageChange): Promise<void> {
    const task = this.tasks.find(change.task.projectKey, change.task.key);
    if (!task || !isOpenTask(task)) return;
    const config = await this.projects.config(task.projectKey);
    const turnMember = this.turnMemberOf(task, config);
    const wentBack = stageIndex(config.pipeline, change.to) < stageIndex(config.pipeline, change.from);
    const stop: SessionStop = wentBack
      ? { kind: 'sent_back', taskKey: task.key, stageId: change.to }
      : { kind: 'step_done', taskKey: task.key, stageId: change.to };
    for (const session of this.runningOn(task)) {
      // A member whose step it is (again) keeps its session, and a mark left by an earlier stage goes.
      if (hasStepOnTask(config, task, session.member, turnMember)) {
        this.sessions.cancelClose(session.id);
        continue;
      }
      this.sessions.closeWhenIdle(session, stop);
      await this.tryClose(session, stop);
    }
  }

  /**
   * A member's refinement turn on the card is over: its session on the card closes, unless the member
   * has a step on the card in its stage as well.
   */
  async refinementTurnLeft(task: Task, member: string): Promise<void> {
    const stop: SessionStop = { kind: 'step_done', taskKey: task.key };
    for (const session of this.runningOn(task)) {
      if (session.member !== member) continue;
      if (await this.stepRemains(session)) {
        this.sessions.cancelClose(session.id);
        continue;
      }
      this.sessions.closeWhenIdle(session, stop);
      await this.tryClose(session, stop);
    }
  }

  /**
   * The member gave the card's work back in this session (PM-570): it closes at its next idle moment.
   * `requested` are the labels the member asked for in the call; the mark goes on the request, not on a
   * change of the label, as the second round's verdict finds the label on the card already.
   */
  async workReturned(sessionId: string, task: Task, requested: readonly string[]): Promise<void> {
    const session = this.sessions.find(sessionId);
    if (!session || !this.sessions.isRunning(session.id)) return;
    if (session.workItem.type !== 'task' || session.workItem.taskKey !== task.key) return;
    if (!isOpenTask(task) || this.sessions.pendingClose(session.id)) return;
    const config = await this.projects.config(task.projectKey);
    const gaveBack = requested.some((raw) => {
      const id = raw.trim();
      return task.labels.includes(id) && isReturnedWorkLabel(labelDefinition(config, id));
    });
    if (gaveBack) this.sessions.closeWhenIdle(session, { kind: 'awaiting_fix', taskKey: task.key });
  }

  /**
   * A session went idle. One marked to close looks at its step again: the card may have come back to its
   * member meanwhile, and then the session stays open.
   */
  async sessionIdle(session: Session): Promise<void> {
    // The member's merge runs on the server: nothing to wait for here, whatever else is marked (PM-552).
    const mergeStop = this.mergeRunningStop(session);
    if (mergeStop) {
      await this.tryClose(session, mergeStop);
      return;
    }
    const stop = this.sessions.pendingClose(session.id);
    if (!stop) return;
    await this.closeMarked(session, stop);
  }

  /**
   * One round over the idle sessions: a marked one is tried again, any other closes when it has been
   * silent for `SESSION_IDLE_CLOSE_MINUTES` (since `lastActivityAt`, which is stored: a restart of the
   * server counts right). A meeting's session never closes.
   */
  async sweep(): Promise<void> {
    const now = this.ctx.now().getTime();
    const runs = new Map<EngineId, Promise<ReadonlySet<string>>>();
    for (const session of this.ctx.repos.sessions.listInStates(['idle'])) {
      if (session.workItem.type === 'meeting') continue;
      if (!this.sessions.isRunning(session.id) || this.sessions.isPaused(session)) continue;
      try {
        const mergeStop = this.mergeRunningStop(session);
        if (mergeStop) {
          await this.tryClose(session, mergeStop);
          continue;
        }
        const marked = this.sessions.pendingClose(session.id);
        if (marked) {
          await this.closeMarked(session, marked);
          continue;
        }
        const silent = Math.floor((now - Date.parse(session.lastActivityAt)) / MINUTE_MS);
        // A guest's conversation with the Operator frees the one place sooner (PM-475).
        const limit =
          session.workItem.type === 'general' && session.workItem.with
            ? OPERATOR_GUEST_IDLE_CLOSE_MINUTES
            : SESSION_IDLE_CLOSE_MINUTES;
        if (silent < limit) continue;
        if (
          silent < SESSION_HEAVY_RUN_IDLE_MAX_MINUTES &&
          (await this.heldByHeavyRun(session, now, limit, runs))
        )
          continue;
        await this.tryClose(session, { kind: 'idle', idleMinutes: silent });
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not close an idle session');
      }
    }
    const idle = new Set(
      this.ctx.repos.sessions
        .listInStates(['idle'])
        .filter((session) => this.sessions.isRunning(session.id))
        .map((session) => session.id),
    );
    for (const id of this.heavySeenAt.keys()) {
      if (!idle.has(id)) this.heavySeenAt.delete(id);
    }
  }

  /** Heavy runs extend only idle closure, including a full idle interval after the last sighting. */
  private async heldByHeavyRun(
    session: Session,
    now: number,
    limit: number,
    runs: Map<EngineId, Promise<ReadonlySet<string>>>,
  ): Promise<boolean> {
    const engineId = engineIdOf(session);
    let running = runs.get(engineId);
    if (!running) {
      running = Promise.resolve()
        .then(() => this.engines.get(engineId)?.heavyRunSessions() ?? [])
        .then(
          (ids) => new Set(ids),
          () => new Set<string>(),
        );
      runs.set(engineId, running);
    }
    if ((await running).has(session.id)) {
      if (!this.heavySeenAt.has(session.id))
        this.ctx.logger.info(
          { sessionId: session.id, member: session.member },
          'an idle session stays open while its heavy run is queued or running',
        );
      this.heavySeenAt.set(session.id, now);
      return true;
    }
    const seen = this.heavySeenAt.get(session.id);
    return seen !== undefined && now - seen < limit * MINUTE_MS;
  }

  /** The running task sessions of a card (a meeting's session is not one). */
  private runningOn(task: Pick<Task, 'projectKey' | 'key'>): Session[] {
    return this.sessions
      .list(task.projectKey, { taskKey: task.key })
      .filter((s) => s.workItem.type === 'task' && this.sessions.isRunning(s.id));
  }

  /**
   * The reason to close a task session whose member started the card's merge while the server queues or
   * runs it (PM-552); null for any other session. A failure or a block wakes the member by message.
   */
  private mergeRunningStop(session: Session): SessionStop | null {
    if (session.workItem.type !== 'task') return null;
    const task = this.tasks.find(session.projectKey, session.workItem.taskKey);
    if (!task || !isMergeRunningFor(task.merge, session.member)) return null;
    return { kind: 'merge_running', taskKey: task.key };
  }

  /** Whether the session's member has a step on the session's card now (a task session only). */
  private async stepRemains(session: Session): Promise<boolean> {
    if (session.workItem.type !== 'task') return false;
    const task = this.tasks.find(session.projectKey, session.workItem.taskKey);
    if (!task) return false;
    const config = await this.projects.config(task.projectKey);
    return hasStepOnTask(config, task, session.member, this.turnMemberOf(task, config));
  }

  /**
   * The member whose refinement turn it is, while the card is being refined. The last turn event stays
   * on a card whose refinement ended without a `done` (the label was taken off): that turn is over.
   */
  private turnMemberOf(task: Task, config: ProjectConfig): string | null {
    return isRefining(task, config) ? this.refinement.turnMember(task.projectKey, task.key) : null;
  }

  /**
   * Closes a session marked to close, unless its member has the card's step again by now. A session that
   * wrote its handoff note (PM-342) closes whatever step its member has: the card is no longer theirs.
   */
  private async closeMarked(session: Session, stop: SessionStop): Promise<void> {
    // A member that gave the work back waits for the fix: its step stays, so only the labels count (PM-570).
    if (stop.kind === 'awaiting_fix') {
      if (await this.workStillReturned(session)) await this.tryClose(session, stop);
      else this.sessions.cancelClose(session.id);
      return;
    }
    if (stop.kind !== 'handed_off' && (await this.stepRemains(session))) {
      this.sessions.cancelClose(session.id);
      return;
    }
    await this.tryClose(session, stop);
  }

  /** Whether the session's card is open and still carries a label that gives its work back (PM-570). */
  private async workStillReturned(session: Session): Promise<boolean> {
    if (session.workItem.type !== 'task') return false;
    const task = this.tasks.find(session.projectKey, session.workItem.taskKey);
    if (!task || !isOpenTask(task)) return false;
    return reviewReturnedWork(await this.projects.config(task.projectKey), task);
  }

  /** Whether the session works, or a message that is not held back is on its way to it. */
  private async atWork(session: Session): Promise<boolean> {
    const messageOnItsWay =
      this.sessions.messageWaiting(session) && !(await this.messaging.holdsMessagesOf(session));
    return isSessionAtWork(session, {
      awaitsFirstTurn: this.sessions.awaitsFirstTurn(session.id),
      pendingInput: this.sessions.hasPendingInput(session.id),
      messageOnItsWay,
    });
  }

  /**
   * Closes the session if it does not work. A session kept open by a message that waits is given that
   * message instead, so that one that is stuck does not hold it open for good; it closes at its next
   * idle moment. A message that came as it closed wakes it again.
   */
  private async tryClose(session: Session, stop: SessionStop): Promise<void> {
    const current = this.sessions.find(session.id);
    if (!current) return;
    if (await this.atWork(current)) {
      if (this.sessions.messageWaiting(current) && !(await this.messaging.holdsMessagesOf(current)))
        this.delivery.deliverWaiting(current);
      return;
    }
    const closed = await this.sessions.close(current.projectKey, current.id, stop);
    if (closed) await this.messaging.wakeWaiting(closed);
  }
}
