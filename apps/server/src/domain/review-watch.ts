import {
  isOpenTask,
  isTheme,
  reviewReturnedWork,
  stageIndex,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type { Messaging } from './messaging';
import type { DomainContext } from './context';
import type { ProjectService } from './projects';
import { LIVE_SESSION_STATES } from './sessions';
import type { SessionOrchestrator } from './sessions';
import type { TaskService } from './tasks';
import { KeyedMutex, SYSTEM_ACTOR } from './util';

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
 */
export class ReviewWatch {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly messaging: Messaging;
  private readonly locks = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    messaging: Messaging;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.messaging = deps.messaging;
  }

  /** Looks at every task in review that has a pinned commit. */
  async check(): Promise<void> {
    for (const pin of this.ctx.repos.reviewPins.list()) {
      try {
        await this.checkTask(pin.projectKey, pin.taskKey);
      } catch (err) {
        this.ctx.logger.warn({ err, taskKey: pin.taskKey }, 'could not check the pinned review commit');
      }
    }
  }

  /** Whether the task was sent back because its branch moved. */
  checkTask(projectKey: string, taskKey: string): Promise<boolean> {
    return this.locks.run(taskKey, () => this.sendBackIfMoved(projectKey, taskKey));
  }

  private async sendBackIfMoved(projectKey: string, taskKey: string): Promise<boolean> {
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
    if (reviewReturnedWork(config, task)) return false;

    const stage = stageOf(config, task.stageId);
    const back = config.pipeline.stages
      .slice(0, stageIndex(config.pipeline, task.stageId))
      .reverse()
      .find((s) => s.kind === 'work');
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
    // The stage's reviewers stop once the task is back: what they judge is out of date. Their
    // conversations stay; others working on the card (an architect, an analyst) are left alone.
    const reviewers = stageOwners(config, stage).filter((handle) => handle !== task.assignee);
    for (const session of this.sessions.list(projectKey, { taskKey })) {
      if (session.workItem.type !== 'task' || !reviewers.includes(session.member)) continue;
      if (LIVE_SESSION_STATES.includes(session.state) || this.sessions.isRunning(session.id))
        await this.sessions.stop(projectKey, session.id);
    }
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
