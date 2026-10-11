import { REFINE_LABEL } from '../domain/label';
import type { Stage } from '../domain/pipeline';
import { isOpenTask, isTheme } from '../domain/task';
import type { Task } from '../domain/task';
import { stageIndex } from './gates';
import { labelDefinition, labelSetters } from './labels';
import { memberOf } from './lookup';
import { developmentStage, projectRefines } from './refinement';
import type { ProjectConfig } from './schema';

/**
 * A part left where nobody starts it (PM-480): the member who breaks a card down creates the parts, and
 * the same turn labels them, orders them and takes them out of the first stage. A part still in the first
 * stage with no `refine` on it was forgotten: one rule for the "why it stands" reason, the server's
 * reminder and the web. It only says; it never moves or labels (decision 48).
 */

type PartTask = Pick<
  Task,
  'status' | 'kind' | 'stageId' | 'labels' | 'parentKey' | 'createdBy' | 'assignee' | 'links'
>;
type PartConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;

/** Where a part goes when it can start: the stage before the development stage; null when that is the first stage or there is none. */
export function partReadyStage(config: Pick<ProjectConfig, 'pipeline'>): Stage | null {
  const work = developmentStage(config);
  if (!work) return null;
  const target = stageIndex(config.pipeline, work.id) - 1;
  return target > 0 ? (config.pipeline.stages[target] ?? null) : null;
}

/** Whether this part was left where nobody starts it, and whose it is; null otherwise. */
export function partLeft(task: PartTask, config: PartConfig): { member: string; parentKey: string } | null {
  if (!isOpenTask(task) || isTheme(task) || task.status === 'blocked' || !task.parentKey) return null;
  if (stageIndex(config.pipeline, task.stageId) !== 0 || partReadyStage(config) === null) return null;
  if (!projectRefines(config)) return null;
  const creator = memberOf(config, task.createdBy);
  const refine = labelDefinition(config, REFINE_LABEL);
  if (creator?.kind !== 'ai' || !refine || !labelSetters(config, refine, task).includes(creator.handle))
    return null;
  if (task.labels.includes(REFINE_LABEL)) return null;
  if (task.labels.some((id) => labelDefinition(config, id)?.blocks)) return null;
  return { member: creator.handle, parentKey: task.parentKey };
}
