import {
  SENIOR_WAIT_OPTIONS,
  SENIOR_WAIT_OPTION_ANY,
  SENIOR_WAIT_OPTION_WAIT,
  developerLevelOf,
  isOpenTask,
  isSenior,
  memberOf,
  seniorWaitDecisionOf,
  seniorWaitMinutesOf,
  seniorsOf,
  stageOf,
} from '@projectman/shared';
import type { InboxItem, ProjectConfig, SeniorWaitDecisionPayload, Task } from '@projectman/shared';
import type { SeniorWaitEndReason, SeniorWaitRecord } from '../../db';
import { ownerHandles } from '../access';
import { isoNow } from '../context';
import type { DomainContext } from '../context';
import type { InboxService } from '../inbox';
import type { ConfigChange, ProjectService } from '../projects';
import type { TaskService } from '../tasks';
import type { TimelineService } from '../timeline';
import { SYSTEM_ACTOR, newId } from '../util';

const MINUTE_MS = 60_000;

/**
 * The wait of a card recommended for the Senior (PM-348, decisions K2 and K3 of PM-338). While every
 * Senior is busy or away the card waits for one; it gets no other developer. After the wait limit
 * (`seniorWaitMinutes`, 30 by default) the owners get one question: wait on, or let a free developer
 * take the card. A Senior who frees up in the meantime takes the card, and the question closes. An
 * unanswered question leaves the card waiting.
 *
 * One row per card (`senior_waits`) holds when the wait began, the question and the answer, so that
 * a restart loses none of it. The card's start itself is a deferred start (`work-start:...`, reason
 * `senior_busy`). Everything here runs synchronously, so that the events and the timer do not
 * interleave.
 */
export class SeniorWaits {
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'cachedConfig'>;
  private readonly tasks: TaskService;
  private readonly inbox: InboxService;
  private readonly timeline: TimelineService;
  /** The deferred starts are tried again (an answer arrived). */
  private readonly retry: () => void;

  constructor(deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'cachedConfig'>;
    tasks: TaskService;
    inbox: InboxService;
    timeline: TimelineService;
    retry: () => void;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.inbox = deps.inbox;
    this.timeline = deps.timeline;
    this.retry = deps.retry;
  }

  /** The card begins to wait for one of the Seniors; a card that already waits keeps its wait. */
  open(task: Pick<Task, 'projectKey' | 'key'>, seniors: readonly string[]): void {
    if (this.ctx.repos.seniorWaits.open(task.projectKey, task.key)) return;
    this.ctx.repos.seniorWaits.create({
      id: newId('swait'),
      projectKey: task.projectKey,
      taskKey: task.key,
      since: isoNow(this.ctx),
    });
    this.ctx.logger.info({ taskKey: task.key, seniors }, 'card waits for a Senior');
  }

  /** What the owners decided about the card's wait, as the start reads it; null before an answer. */
  decisionFor(projectKey: string, taskKey: string): { decision: 'wait' | 'any'; by: string } | null {
    const wait = this.ctx.repos.seniorWaits.open(projectKey, taskKey);
    return wait?.decision && wait.decidedBy ? { decision: wait.decision, by: wait.decidedBy } : null;
  }

  /**
   * An automatic assignment gave a Senior card out by the "any" rule because the team has no Senior
   * (the wait that may have been open ends with it). Said once per time the card is in its stage.
   */
  noSenior(task: Task): void {
    const open = this.ctx.repos.seniorWaits.open(task.projectKey, task.key);
    if (open) this.end(open, 'no_senior', task);
    else this.announceNoSenior(task);
  }

  /** Ends the card's open wait when it no longer waits for a Senior (see the end reasons). */
  settle(task: Task, config: ProjectConfig): void {
    const wait = this.ctx.repos.seniorWaits.open(task.projectKey, task.key);
    if (!wait) return;
    const reason = endReasonOf(task, config);
    if (reason) this.end(wait, reason, task);
  }

  /** The configuration changed: the waits of the project are looked at again with the new roster. */
  configChanged(change: ConfigChange): void {
    for (const wait of this.ctx.repos.seniorWaits.listOpen(change.projectKey))
      this.settleWait(wait, change.next);
  }

  /**
   * The timer: looks at every open wait. A wait whose card went another way ends; one that has lasted
   * the wait limit, with the card still shown as waiting for a Senior and no question or answer yet,
   * asks the owners, once.
   */
  sweep(): void {
    for (const wait of this.ctx.repos.seniorWaits.listOpen()) {
      try {
        const config = this.projects.cachedConfig(wait.projectKey);
        if (!config || !this.settleWait(wait, config)) continue;
        this.askWhenDue(wait, config);
      } catch (err) {
        this.ctx.logger.warn({ err, taskKey: wait.taskKey }, 'could not check the Senior wait of a card');
      }
    }
  }

  /** A person answered the question: the answer is kept and the waiting start is tried again. */
  decided(item: InboxItem): void {
    if (!seniorWaitDecisionOf(item) || item.resolution?.rule) return;
    const wait = this.ctx.repos.seniorWaits.ofInboxItem(item.id);
    const optionId = item.resolution?.optionId;
    const decision =
      optionId === SENIOR_WAIT_OPTION_WAIT ? 'wait' : optionId === SENIOR_WAIT_OPTION_ANY ? 'any' : null;
    if (!wait || wait.endedAt || !decision || !item.resolution) return;
    this.ctx.repos.seniorWaits.decide(wait.id, decision, item.resolution.by, item.resolution.at);
    this.timeline.append({
      projectKey: wait.projectKey,
      taskKey: wait.taskKey,
      actor: SYSTEM_ACTOR,
      type: 'task_senior_wait',
      data: { phase: 'decided', decision, by: item.resolution.by },
    });
    this.publish(wait);
    this.retry();
  }

  /** Whether the wait is still open after looking at its card. */
  private settleWait(wait: SeniorWaitRecord, config: ProjectConfig): boolean {
    const task = this.tasks.find(wait.projectKey, wait.taskKey);
    if (!task) {
      this.ctx.repos.seniorWaits.close(wait.id, isoNow(this.ctx), 'closed');
      return false;
    }
    this.settle(task, config);
    return this.ctx.repos.seniorWaits.open(wait.projectKey, wait.taskKey) !== null;
  }

  private askWhenDue(wait: SeniorWaitRecord, config: ProjectConfig): void {
    if (wait.askedAt || wait.decision) return;
    const minutes = seniorWaitMinutesOf(config.team.limits);
    if (this.ctx.now().getTime() - Date.parse(wait.since) < minutes * MINUTE_MS) return;
    const task = this.tasks.find(wait.projectKey, wait.taskKey);
    if (!task || task.startWaiting?.reason !== 'senior_busy') return;
    const deciders = ownerHandles(config);
    const seniors = task.startWaiting.seniors ?? [];
    const now = isoNow(this.ctx);
    if (deciders.length === 0) {
      // Nobody can be asked: said once, and the card goes on waiting.
      this.ctx.repos.seniorWaits.markAsked(wait.id, now, null);
      this.ctx.logger.warn(
        { taskKey: task.key },
        'card waits for a Senior past the limit, and the project has no owner to ask',
      );
      return;
    }
    const payload: SeniorWaitDecisionPayload = {
      taskKey: task.key,
      since: wait.since,
      minutes,
      seniors,
      reason: task.developerLevel?.reason ?? null,
    };
    this.ctx.unitOfWork(() => {
      const item = this.inbox.create({
        projectKey: task.projectKey,
        kind: 'decision',
        assignees: deciders,
        source: 'system',
        taskKey: task.key,
        title: `${task.key} waits for the Senior`,
        payload: { seniorWait: payload },
        options: SENIOR_WAIT_OPTIONS,
      });
      this.ctx.repos.seniorWaits.markAsked(wait.id, now, item.id);
      this.timeline.append({
        projectKey: task.projectKey,
        taskKey: task.key,
        actor: SYSTEM_ACTOR,
        type: 'task_senior_wait',
        data: { phase: 'asked', minutes, seniors, deciders },
      });
    });
  }

  /** The wait is over: its row closes, its open question closes by the system, the card is published again. */
  private end(wait: SeniorWaitRecord, reason: SeniorWaitEndReason, task: Task): void {
    this.ctx.unitOfWork(() => {
      this.ctx.repos.seniorWaits.close(wait.id, isoNow(this.ctx), reason);
      const closed = wait.inboxItemId
        ? this.inbox.resolveByRule(
            wait.inboxItemId,
            'ended',
            reason === 'senior' ? 'senior_took' : 'senior_wait_ended',
          )
        : null;
      if (closed && reason === 'senior')
        this.timeline.append({
          projectKey: wait.projectKey,
          taskKey: wait.taskKey,
          actor: SYSTEM_ACTOR,
          type: 'task_senior_wait',
          data: { phase: 'senior_took' },
        });
      if (reason === 'no_senior') this.announceNoSenior(task);
    });
    this.publish(wait);
  }

  private announceNoSenior(task: Pick<Task, 'projectKey' | 'key'>): void {
    const said = this.timeline.latest(task.projectKey, task.key, 'task_senior_wait');
    const moved = this.timeline.latest(task.projectKey, task.key, 'task_stage_changed');
    if (said?.data.phase === 'no_senior' && (!moved || said.createdAt >= moved.createdAt)) return;
    this.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor: SYSTEM_ACTOR,
      type: 'task_senior_wait',
      data: { phase: 'no_senior' },
    });
  }

  private publish(wait: Pick<SeniorWaitRecord, 'projectKey' | 'taskKey'>): void {
    const task = this.tasks.find(wait.projectKey, wait.taskKey);
    if (task) this.tasks.publish(task);
  }
}

/** Why a card no longer waits for a Senior, or null when it still does. */
function endReasonOf(task: Task, config: ProjectConfig): SeniorWaitEndReason | null {
  if (!isOpenTask(task)) return 'closed';
  const stage = stageOf(config, task.stageId);
  if (stage?.kind !== 'work') return 'moved';
  if (task.assignee) return isSenior(memberOf(config, task.assignee)) ? 'senior' : 'assigned';
  if (developerLevelOf(task) !== 'senior') return 'level_changed';
  if (seniorsOf(config, stage).length === 0) return 'no_senior';
  return null;
}
