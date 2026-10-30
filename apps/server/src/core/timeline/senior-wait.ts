import { complexityOf } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { SYSTEM_ACTOR } from '../../kernel';
import type { TimelineService } from './timeline';

/**
 * An automatic assignment gave a scored card out by the "any" rule because the team has no developer whose
 * limit reaches its points (PM-348). Said once per time the card is in its stage: the start that gives the
 * card out and the end of its Senior wait both say it, and the second finds it said.
 */
export function announceNoSenior(
  timeline: Pick<TimelineService, 'append' | 'latest'>,
  task: Pick<Task, 'projectKey' | 'key' | 'complexity'>,
): void {
  const said = timeline.latest(task.projectKey, task.key, 'task_senior_wait');
  const moved = timeline.latest(task.projectKey, task.key, 'task_stage_changed');
  if (said?.data.phase === 'no_senior' && (!moved || said.createdAt >= moved.createdAt)) return;
  const points = complexityOf(task);
  timeline.append({
    projectKey: task.projectKey,
    taskKey: task.key,
    actor: SYSTEM_ACTOR,
    type: 'task_senior_wait',
    data: { phase: 'no_senior', ...(points === null ? {} : { points }) },
  });
}
