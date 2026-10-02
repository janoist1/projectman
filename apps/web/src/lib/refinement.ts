import {
  developmentStage,
  isOpenTask,
  isRefining,
  isTheme,
  labelDefinition,
  projectRefines,
  REFINE_LABEL,
  stageIndex,
} from '@projectman/shared';
import type { ProjectConfig, Task } from '@projectman/shared';
import { viewerLabelRefusal } from './labels';

type RefinementConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;

/**
 * Whether the viewer is offered the "Kidolgozás" button (decision 31): the project knows the
 * `refine` label, the card is open and stands before the work stage, is not being refined yet, and
 * the viewer may put the label on it (the label's own rule, the server's).
 */
export function canStartRefinement(task: Task, config: RefinementConfig, me: string): boolean {
  if (!isOpenTask(task) || isTheme(task) || task.labels.includes(REFINE_LABEL)) return false;
  if (!labelDefinition(config, REFINE_LABEL) || isRefining(task, config)) return false;
  const work = developmentStage(config);
  if (!work || stageIndex(config.pipeline, task.stageId) >= stageIndex(config.pipeline, work.id))
    return false;
  return viewerLabelRefusal(config, REFINE_LABEL, me, task) === null;
}

/** Whether the project works its cards out before development: a refused Start points at the button. */
export function suggestsRefinement(config: Pick<ProjectConfig, 'pipeline'> | undefined): boolean {
  return config !== undefined && projectRefines(config);
}
