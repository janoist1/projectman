import { isOpenTask, openPrerequisites } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import type { DomainContext } from '../context';
import type { TimelineService } from '../timeline';
import { SYSTEM_ACTOR } from '../util';

/**
 * What closing a card means to the cards that need it first (PM-192, PM-204). A card closes when it
 * is done or cancelled (a withdrawal frees its dependents like a finish does); every open card that
 * has it as a prerequisite records that on its timeline, with the prerequisites still open. The
 * dependents are returned, so that whoever waits for them (the deferred starts) can try again.
 */
export class PrerequisiteClosures {
  private readonly ctx: DomainContext;
  private readonly timeline: TimelineService;

  constructor(deps: { ctx: DomainContext; timeline: TimelineService }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
  }

  /** The open cards that have `task` as a prerequisite. */
  dependents(task: Pick<Task, 'projectKey' | 'key'>): Task[] {
    return this.ctx.repos.tasks.linking(task.projectKey, ['prerequisite'], task.key).filter(isOpenTask);
  }

  /** Records the closing of `task` on each dependent's timeline; returns the dependents. */
  closed(task: Task): Task[] {
    if (isOpenTask(task)) return [];
    const dependents = this.dependents(task);
    if (dependents.length === 0) return dependents;
    const cards = this.ctx.repos.tasks.list(task.projectKey);
    for (const dependent of dependents) {
      this.timeline.append({
        projectKey: task.projectKey,
        taskKey: dependent.key,
        actor: SYSTEM_ACTOR,
        type: 'task_prerequisite_closed',
        data: {
          ref: task.key,
          status: task.status,
          remaining: openPrerequisites(dependent, cards).map((card) => card.key),
        },
      });
    }
    return dependents;
  }
}
