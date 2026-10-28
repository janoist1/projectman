import type { Stage } from '../domain/pipeline';
import type { Task } from '../domain/task';
import { stageOf } from './lookup';
import type { ProjectConfig } from './schema';

/** The task's work stage: the one it is in, else the pipeline's first. */
export function workStageOf(
  config: Pick<ProjectConfig, 'pipeline'>,
  task: Pick<Task, 'stageId'>,
): Stage | undefined {
  const current = stageOf(config, task.stageId);
  return current?.kind === 'work' ? current : config.pipeline.stages.find((s) => s.kind === 'work');
}
