import {
  hasStepOnTask,
  isOpenTask,
  isSessionAtWork,
  SESSION_IDLE_CLOSE_MINUTES,
  stageIndex,
} from '@projectman/shared';
import type { Session, SessionStop, Task } from '@projectman/shared';
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
 * closes while it works, nor a meeting's. The conversation stays: a message, an answer or a hand-over
 * resumes it. A session that is in a turn when its step ends is marked, and closes at its next idle
 * moment (`sessionIdle`); the periodic `sweep` catches what no event did.
 */
export class SessionCloser {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly refinement: Pick<RefinementSteps, 'turnMember'>;
  private readonly messaging: Pick<Messaging, 'holdsMessagesOf' | 'wakeWaiting'>;
  private readonly delivery: Pick<MessageDelivery, 'deliverWaiting'>;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    refinement: Pick<RefinementSteps, 'turnMember'>;
    messaging: Pick<Messaging, 'holdsMessagesOf' | 'wakeWaiting'>;
    delivery: Pick<MessageDelivery, 'deliverWaiting'>;
  }) {
    this.ctx = deps.ctx;
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
    const turnMember = this.refinement.turnMember(task.projectKey, task.key);
    const wentBack = stageIndex(config.pipeline, change.to) < stageIndex(config.pipeline, change.from);
    const stop: SessionStop = wentBack
      ? { kind: 'sent_back', taskKey: task.key, stageId: change.to }
      : { kind: 'step_done', taskKey: task.key, stageId: change.to };
    for (const session of this.runningOn(task)) {
      if (hasStepOnTask(config, task, session.member, turnMember)) continue;
      this.sessions.closeWhenIdle(session, stop);
      await this.tryClose(session, stop);
    }
  }

  /** A member's refinement turn on the card is over: its session on the card closes. */
  async refinementTurnLeft(task: Task, member: string): Promise<void> {
    const stop: SessionStop = { kind: 'step_done', taskKey: task.key };
    for (const session of this.runningOn(task)) {
      if (session.member !== member) continue;
      this.sessions.closeWhenIdle(session, stop);
      await this.tryClose(session, stop);
    }
  }

  /**
   * A session went idle. One marked to close looks at its step again: the card may have come back to its
   * member meanwhile, and then the session stays open.
   */
  async sessionIdle(session: Session): Promise<void> {
    const stop = this.sessions.pendingClose(session.id);
    if (!stop) return;
    if (session.workItem.type === 'task') {
      const task = this.tasks.find(session.projectKey, session.workItem.taskKey);
      if (task) {
        const config = await this.projects.config(task.projectKey);
        const turnMember = this.refinement.turnMember(task.projectKey, task.key);
        if (hasStepOnTask(config, task, session.member, turnMember)) {
          this.sessions.cancelClose(session.id);
          return;
        }
      }
    }
    await this.tryClose(session, stop);
  }

  /**
   * One round over the idle sessions: a marked one is tried again, any other closes when it has been
   * silent for `SESSION_IDLE_CLOSE_MINUTES` (since `lastActivityAt`, which is stored: a restart of the
   * server counts right). A meeting's session never closes.
   */
  async sweep(): Promise<void> {
    const now = this.ctx.now().getTime();
    for (const session of this.ctx.repos.sessions.listInStates(['idle'])) {
      if (session.workItem.type === 'meeting') continue;
      if (!this.sessions.isRunning(session.id) || this.sessions.isPaused(session)) continue;
      try {
        const marked = this.sessions.pendingClose(session.id);
        if (marked) {
          await this.tryClose(session, marked);
          continue;
        }
        const silent = Math.floor((now - Date.parse(session.lastActivityAt)) / MINUTE_MS);
        if (silent >= SESSION_IDLE_CLOSE_MINUTES)
          await this.tryClose(session, { kind: 'idle', idleMinutes: silent });
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not close an idle session');
      }
    }
  }

  /** The running task sessions of a card (a meeting's session is not one). */
  private runningOn(task: Pick<Task, 'projectKey' | 'key'>): Session[] {
    return this.sessions
      .list(task.projectKey, { taskKey: task.key })
      .filter((s) => s.workItem.type === 'task' && this.sessions.isRunning(s.id));
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
