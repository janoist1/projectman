import { stageIndex, stageOwners } from '@projectman/shared';
import type { ProjectConfig, Stage, Task } from '@projectman/shared';
import { LIVE_SESSION_STATES } from './sessions';
import type { SessionOrchestrator } from './sessions';

/** The work stage before `stageId` that a task sent back from it goes to; none when there is no such stage. */
export function workStageBefore(config: ProjectConfig, stageId: string): Stage | undefined {
  return config.pipeline.stages
    .slice(0, stageIndex(config.pipeline, stageId))
    .reverse()
    .find((s) => s.kind === 'work');
}

/**
 * Stops the sessions of a stage's reviewers on a card that was sent back from it: what they judge is
 * out of date. Their conversations stay; others working on the card (an architect, an analyst) and the
 * card's developer are left alone.
 */
export async function stopStageReviewers(
  sessions: Pick<SessionOrchestrator, 'list' | 'isRunning' | 'stop'>,
  config: ProjectConfig,
  task: Pick<Task, 'projectKey' | 'key' | 'assignee'>,
  stage: Stage,
): Promise<void> {
  const reviewers = stageOwners(config, stage).filter((handle) => handle !== task.assignee);
  for (const session of sessions.list(task.projectKey, { taskKey: task.key })) {
    if (session.workItem.type !== 'task' || !reviewers.includes(session.member)) continue;
    if (LIVE_SESSION_STATES.includes(session.state) || sessions.isRunning(session.id))
      await sessions.stop(task.projectKey, session.id);
  }
}
