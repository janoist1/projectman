import { seniorWaitAnswerOf, seniorWaitMinutesOf, stageDevelopers } from '@projectman/shared';
import type { InboxItem, ProjectConfig, Task } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { ConfigChange } from '../../core/projects';
import { seniorWaitDecisionFor } from '../../core/tasks';
import type { TaskService } from '../../core/tasks';
import { announceNoSenior } from '../../core/timeline';
import type { TimelineService } from '../../core/timeline';
import { SYSTEM_ACTOR } from '../../kernel';

/**
 * What the owners decided about the wait of a scored card for a developer whose limit reaches its points
 * (PM-348, PM-1001, PM-1150). The wait itself is the `senior_wait` obligation (`services/obligations`):
 * its clock, its question and its end. This is what the starts need of it: the answer, as the start reads
 * it, and a retry of the deferred starts when an answer or the roster changes what they would do.
 */
export class SeniorDecisions {
  private readonly ctx: DomainContext;
  private readonly tasks: Pick<TaskService, 'find' | 'publish'>;
  private readonly timeline: Pick<TimelineService, 'append' | 'latest'>;
  /** The deferred starts are tried again. */
  private readonly retry: () => void;

  constructor(deps: {
    ctx: DomainContext;
    tasks: Pick<TaskService, 'find' | 'publish'>;
    timeline: Pick<TimelineService, 'append' | 'latest'>;
    retry: () => void;
  }) {
    this.ctx = deps.ctx;
    this.tasks = deps.tasks;
    this.timeline = deps.timeline;
    this.retry = deps.retry;
  }

  /** What the owners decided about the card's wait, as the start reads it; null before an answer. */
  decisionFor(projectKey: string, taskKey: string): { decision: 'wait' | 'any'; by: string } | null {
    return seniorWaitDecisionFor(this.ctx, projectKey, taskKey);
  }

  /**
   * An automatic assignment gave a Senior card out by the "any" rule because the team has no Senior
   * (the wait that may have been open ends with the assignment). Said once per time the card is in its stage.
   */
  noSenior(task: Task): void {
    announceNoSenior(this.timeline, task);
  }

  /** A person answered the question: the answer is recorded and the waiting start is tried again. */
  decided(item: InboxItem): void {
    const answer = seniorWaitAnswerOf(item);
    const wait = answer ? this.ctx.repos.obligations.ofInboxItem(item.id) : null;
    if (
      !answer ||
      !wait ||
      wait.kind !== 'senior_wait' ||
      (wait.state !== 'open' && wait.state !== 'handed_over')
    )
      return;
    this.ctx.unitOfWork(() => {
      this.timeline.append({
        projectKey: wait.projectKey,
        taskKey: wait.taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_senior_wait',
        data: { phase: 'decided', decision: answer.decision, by: answer.by },
      });
      this.ctx.journal.record(wait.projectKey, 'task', wait.taskKey);
    });
    const task = this.tasks.find(wait.projectKey, wait.taskKey);
    if (task) this.tasks.publish(task);
    this.retry();
  }

  /** A changed roster or wait limit can release a deferred start. */
  configurationChanged(change: ConfigChange): void {
    const { previous, next } = change;
    if (
      previous &&
      (developersSignature(previous) !== developersSignature(next) ||
        seniorWaitMinutesOf(previous.team.limits) !== seniorWaitMinutesOf(next.team.limits))
    )
      this.retry();
  }
}

/** The work stages' developers and their limits as one text, to see whether a roster change matters. */
function developersSignature(config: ProjectConfig): string {
  return config.pipeline.stages
    .filter((stage) => stage.kind === 'work')
    .flatMap((stage) => stageDevelopers(config, stage))
    .map((developer) => JSON.stringify([developer.handle, developer.limit, developer.specialtyLabels]))
    .sort()
    .join(',');
}
