import { gateRequestOf, isOpenTask, isSessionAtWork, isTheme, stageAdvance } from '@projectman/shared';
import type { InboxItem, Task } from '@projectman/shared';
import type { DomainContext } from '../context';
import { DomainError } from '../errors';
import type { ProjectService } from '../projects';
import type { SessionOrchestrator } from '../sessions';
import { KeyedMutex, SYSTEM_ACTOR } from '../util';
import type { TaskService } from './service';

type AdvanceSessions = Pick<
  SessionOrchestrator,
  'cardWorkers' | 'awaitsFirstTurn' | 'hasPendingInput' | 'messageWaiting'
>;

/**
 * A card whose stage is done and whose next gate lacks nothing but humans' approvals (PM-445) must not
 * sit there unseen. The rule is `stageAdvance` in `packages/shared`; this is the system's side of it: it
 * moves the card when nothing is missing, or opens the same decision a move attempt would open (source:
 * system), which lands in the approvers' "waiting for you" list. It looks at a card when its labels or
 * stage change, when a session of it goes idle or ends, and at every open card once after the start (cards
 * that got stuck before this).
 *
 * It never moves a card someone works on (that would pull the stage from under them; the end of the
 * round looks at the card again), never acts on a closed or blocked card or on a theme, and does not ask
 * again after the approvers rejected the request until the card's labels change.
 */
export class AutoAdvance {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: AdvanceSessions;
  /** One look at a card at a time. */
  private readonly cards = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: AdvanceSessions;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
  }

  /** A card's labels or stage changed or a session of it stopped: it may lack only an approval now. */
  async check(task: Task): Promise<void> {
    await this.cards.run(task.key, () => this.advance(task.projectKey, task.key));
  }

  /** Every open card of every project, once (at the start): the cards that got stuck before. */
  async sweep(): Promise<void> {
    for (const project of this.projects.summaries()) {
      for (const task of this.tasks.list(project.key)) {
        if (!isOpenTask(task)) continue;
        await this.check(task);
      }
    }
  }

  private async advance(projectKey: string, taskKey: string): Promise<void> {
    const task = this.tasks.find(projectKey, taskKey);
    if (!task || !isOpenTask(task) || task.status === 'blocked' || isTheme(task)) return;
    const config = await this.projects.config(projectKey);
    const advance = stageAdvance(task, config);
    if (!advance) return;
    // Asking for an approval disturbs nobody; moving the card under a member who works on it would. A
    // session that sits idle (a reviewer who is done) does not work on it.
    if (
      advance.kind === 'move' &&
      this.sessions.cardWorkers(projectKey, task, config).some((s) =>
        isSessionAtWork(s, {
          awaitsFirstTurn: this.sessions.awaitsFirstTurn(s.id),
          pendingInput: this.sessions.hasPendingInput(s.id),
          messageOnItsWay: this.sessions.messageWaiting(s),
        }),
      )
    )
      return;
    if (this.rejected(task, advance.to.id)) return;
    try {
      await this.tasks.moveToStage(projectKey, taskKey, advance.to.id, SYSTEM_ACTOR);
    } catch (err) {
      // Nobody may give the approval, the head of the branch is not committed, a gate changed under us:
      // nothing to do for the system; the card shows why it waits.
      if (!(err instanceof DomainError)) throw err;
      this.ctx.logger.debug(
        { taskKey, to: advance.to.id, code: err.code },
        'automatic stage advance refused',
      );
    }
  }

  /**
   * Whether approvers rejected a request for this move since the card entered its stage, and its labels
   * have not changed since: a new label may change their mind, nothing else does.
   */
  private rejected(task: Task, toStageId: string): boolean {
    const since = task.stageEnteredAt ?? task.createdAt;
    const rejections = this.ctx.repos.inbox
      .list(task.projectKey, { taskKey: task.key, kind: 'decision' })
      .filter((item) => rejectedRequest(item, task, toStageId, since))
      .map((item) => item.resolution!.at);
    if (rejections.length === 0) return false;
    const latest = rejections.reduce((a, b) => (a > b ? a : b));
    return !this.ctx.repos.timeline
      .list(task.projectKey, { taskKey: task.key })
      .some((event) => event.type === 'task_labels_changed' && event.createdAt > latest);
  }
}

function rejectedRequest(item: InboxItem, task: Task, toStageId: string, since: string): boolean {
  const gate = gateRequestOf(item);
  return (
    !!gate &&
    gate.fromStageId === task.stageId &&
    gate.toStageId === toStageId &&
    item.state === 'resolved' &&
    item.resolution?.optionId !== 'approve' &&
    item.createdAt >= since
  );
}
