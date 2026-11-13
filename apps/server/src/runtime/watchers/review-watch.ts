import {
  LIVE_SESSION_STATES,
  cardStageOwners,
  isOpenTask,
  isReturnedWorkLabel,
  isTheme,
  labelDefinition,
  memberOf,
  reviewReturnedWork,
  stageOf,
} from '@projectman/shared';
import type { ProjectConfig, Session, Task } from '@projectman/shared';
import type { Messaging } from '../../core/messages';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import type { SessionOrchestrator } from '../sessions';
import { stopStageReviewers, workStageBefore } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { KeyedMutex, SYSTEM_ACTOR } from '../../kernel';

/** What a check of one task may do besides sending it back. */
interface CheckOptions {
  /** Remind the developer of the unasked new round (the check follows the end of their session). */
  remindUnaskedRound?: boolean;
}

/** The reminder text for a developer whose fix commits were not handed over (PM-1405). */
function unaskedRoundText(
  taskKey: string,
  stageName: string,
  labels: string[],
  pin: { branch: string; commit: string },
  head: string,
  reviewers: string[],
): string {
  return `Task ${taskKey}: ${stageName} gave the work back (${labels.join(', ')}), and your branch ${pin.branch} has moved on from the commit it judged (${pin.commit}) to ${head}, but no new round was requested, so ${stageName} still waits on the old commit. A note or an info message does not start a new round. If the fix is finished, send a message of kind action to ${reviewers.join(', ')} naming the new commits: that pins ${head} for the next round. If you are still working or waiting for an answer, carry on; this reminder comes once per commit.`;
}

/**
 * Reviews and tests work on the commit that was handed over (PM-183): the task's review pin. This
 * watches the tasks that are in review with a pin, and when the developer's branch is no longer at
 * the pinned commit, the review no longer judges what is there. The reviewers' sessions stop (their
 * conversations stay) and the system moves the task back to the work stage before it, with the old
 * and the new commit on the move; the developer is told, and hands the task over again.
 *
 * It is not a fault when the developer asked for a new round themselves (PM-138): that pins the new
 * head first (`TaskService.repinReview`), so the branch and the pin agree and nothing happens here. Nor
 * is it when the review already gave the work back (`reviewReturnedWork`): the developer's fixes are
 * the expected commits, and their message asking for a re-review pins the new head. Only an approved
 * or not yet judged branch must not move unnoticed.
 *
 * A request for a new round is the only thing that pins the head: a note or an info message does not
 * (PM-1405). When the developer's round ends with commits after the work was given back and no such
 * request, the developer gets one system reminder per commit (`remindUnaskedRound`, only from the session's
 * end, as the periodic check may find a developer still at work); the system never pins the head itself.
 */
export class ReviewWatch {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly messaging: Messaging;
  private readonly locks = new KeyedMutex();
  private readonly safetyNetMs: number;
  private lastFullCheckAt = 0;
  /** The head commit the developer was last reminded about, per task (in memory: a restart may repeat one). */
  private readonly remindedCommits = new Map<string, string>();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    messaging: Messaging;
    /** How often every pin is read, whoever works (default 10 minutes). */
    safetyNetMs?: number;
  }) {
    this.safetyNetMs = deps.safetyNetMs ?? 10 * 60_000;
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.messaging = deps.messaging;
  }

  /**
   * The periodic round (PM-1374): looks at the tasks in review whose branch can be moving. A branch moves while
   * its developer's session runs, and that session's end checks the task once (`sessionStopped`), as does a push
   * the GitHub sync sees. Every pin is read only once in the safety-net interval, which catches a commit made by
   * hand. A quiet round reads nothing over the engine link.
   */
  async checkDue(): Promise<void> {
    const now = this.ctx.now().getTime();
    if (now - this.lastFullCheckAt >= this.safetyNetMs) {
      this.lastFullCheckAt = now;
      return this.check();
    }
    const withDeveloper = this.tasksWithLiveDeveloper();
    if (withDeveloper.size > 0) await this.check((pin) => withDeveloper.has(pin.taskKey));
  }

  /** Looks at every task in review that has a pinned commit (or those `only` accepts). */
  async check(only?: (pin: { taskKey: string }) => boolean): Promise<void> {
    const pins = this.ctx.repos.reviewPins.list();
    // A reminder is only kept while its task has a pin: a closed or moved-on card forgets it.
    const pinned = new Set(pins.map((pin) => pin.taskKey));
    for (const taskKey of this.remindedCommits.keys())
      if (!pinned.has(taskKey)) this.remindedCommits.delete(taskKey);
    for (const pin of pins) {
      if (only && !only(pin)) continue;
      try {
        await this.checkTask(pin.projectKey, pin.taskKey);
      } catch (err) {
        this.ctx.logger.warn({ err, taskKey: pin.taskKey }, 'could not check the pinned review commit');
      }
    }
  }

  /** A session of a task ended or went idle: its developer's last commit is looked at now. */
  async sessionStopped(session: Pick<Session, 'projectKey' | 'member' | 'workItem'>): Promise<void> {
    if (session.workItem.type !== 'task') return;
    const taskKey = session.workItem.taskKey;
    if (!this.ctx.repos.reviewPins.get(taskKey)) return;
    if (this.tasks.find(session.projectKey, taskKey)?.assignee !== session.member) return;
    try {
      await this.checkTask(session.projectKey, taskKey, { remindUnaskedRound: true });
    } catch (err) {
      this.ctx.logger.warn({ err, taskKey }, 'could not check the pinned review commit');
    }
  }

  /** The tasks whose assignee has a live session on them. */
  private tasksWithLiveDeveloper(): Set<string> {
    const keys = new Set<string>();
    for (const session of this.ctx.repos.sessions.listInStates(LIVE_SESSION_STATES)) {
      if (session.workItem.type !== 'task') continue;
      const { taskKey } = session.workItem;
      if (this.tasks.find(session.projectKey, taskKey)?.assignee === session.member) keys.add(taskKey);
    }
    return keys;
  }

  /** Whether the task was sent back because its branch moved. */
  checkTask(projectKey: string, taskKey: string, options: CheckOptions = {}): Promise<boolean> {
    return this.locks.run(taskKey, () => this.sendBackIfMoved(projectKey, taskKey, options));
  }

  /**
   * The developer's round ended with commits on the branch after the review gave the work back, and no
   * request for a new round (PM-1405): a note or an info message does not pin the head. The developer is
   * reminded once per commit; whether the fix is finished is theirs to say, so nothing is pinned here.
   */
  private async remindUnaskedRound(
    projectKey: string,
    task: Task,
    config: ProjectConfig,
    pin: { branch: string; commit: string },
    head: string,
  ): Promise<void> {
    if (!task.assignee || this.remindedCommits.get(task.key) === head) return;
    const stage = stageOf(config, task.stageId);
    if (!stage) return;
    // A message can only ask an AI member for a round.
    const reviewers = cardStageOwners(config, stage, task).filter((h) => memberOf(config, h)?.kind === 'ai');
    if (reviewers.length === 0) return;
    this.remindedCommits.set(task.key, head);
    const labels = task.labels.filter((id) => isReturnedWorkLabel(labelDefinition(config, id)));
    await this.messaging.send(
      projectKey,
      'system',
      {
        to: [task.assignee],
        taskKey: task.key,
        text: unaskedRoundText(task.key, stage.name, labels, pin, head, reviewers),
      },
      { actor: SYSTEM_ACTOR },
    );
  }

  private async sendBackIfMoved(
    projectKey: string,
    taskKey: string,
    options: CheckOptions,
  ): Promise<boolean> {
    const task = this.tasks.find(projectKey, taskKey);
    const pin = this.ctx.repos.reviewPins.get(taskKey);
    // A pin of a stage the task left is stale, whatever the branch does.
    if (!task || !pin || !isOpenTask(task) || isTheme(task) || task.stageId !== pin.stageId) return false;
    const config = await this.projects.config(projectKey);
    const head = await this.sessions.sourceHead(config, task);
    if (!head || head.commit === pin.commit) return false;
    // A new round the developer asked for may have pinned the head while it was read.
    if (this.ctx.repos.reviewPins.get(taskKey)?.commit === head.commit) return false;
    // The review already gave the work back ("changes needed", "failed"): the commits on the branch
    // are the expected fixes, and the developer's message asking for a new round pins the new head.
    if (reviewReturnedWork(config, task)) {
      if (options.remindUnaskedRound)
        await this.remindUnaskedRound(projectKey, task, config, pin, head.commit);
      return false;
    }

    const stage = stageOf(config, task.stageId);
    const back = workStageBefore(config, task.stageId);
    if (!stage || !back) {
      this.ctx.logger.warn({ taskKey }, 'the branch moved in review, but no work stage is before it');
      return false;
    }
    this.ctx.logger.info(
      { taskKey, pinned: pin.commit, head: head.commit },
      'the branch moved after the hand-over; sending the task back',
    );
    await this.tasks.moveToStage(projectKey, taskKey, back.id, SYSTEM_ACTOR, {
      branchMoved: { branch: pin.branch, pinned: pin.commit, head: head.commit },
    });
    // The stage's reviewers stop once the task is back: what they judge is out of date.
    await stopStageReviewers(this.sessions, config, task, stage, back);
    if (task.assignee)
      await this.messaging.send(
        projectKey,
        'system',
        {
          to: [task.assignee],
          taskKey,
          text: `Task ${taskKey} came back from ${stage.name} to ${back.name}: its branch ${pin.branch} moved from the commit handed over (${pin.commit}) to ${head.commit} while it was in ${stage.name}, so the review stopped. Commit your work, then move the task to ${stage.name} again so it is reviewed on the latest commit.`,
        },
        { actor: SYSTEM_ACTOR },
      );
    return true;
  }
}
