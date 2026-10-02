import { isHumanOnlyLabel, REFINE_LABEL } from '../domain/label';
import type { Stage } from '../domain/pipeline';
import { isOpenTask, isTheme } from '../domain/task';
import type { Task } from '../domain/task';
import { conditionHolds, stageIndex } from './gates';
import { labelDefinition, labelSetters } from './labels';
import { memberOf, stageOf } from './lookup';
import type { ProjectConfig } from './schema';

/**
 * Refinement (decision 31): a card is worked out before development, one step at a time and by one
 * member at a time. It is being refined when it carries the `refine` label ("waiting to be worked
 * out") or sits in a stage that exists for it (a `step` stage with the `task_breakdown` duty, the
 * column version). The steps are the labels the gates before the work stage lack, in the order of the
 * gates and of their conditions: the same set a person's Start is refused for (`evaluateStart`).
 */

type RefinementConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;
type RefinementTask = Pick<Task, 'status' | 'kind' | 'stageId' | 'labels' | 'assignee' | 'links'>;

/** A stage that exists for refinement: a step whose duty is breaking the task down. */
export function isRefinementStage(stage: Pick<Stage, 'kind' | 'duty'>): boolean {
  return stage.kind === 'step' && stage.duty === 'task_breakdown';
}

/** The stage a refined card goes to: the first work stage of the pipeline. */
export function developmentStage(config: Pick<ProjectConfig, 'pipeline'>): Stage | undefined {
  return config.pipeline.stages.find((stage) => stage.kind === 'work');
}

/** Whether the project has refinement: it knows the `refine` label, or has a stage for it. */
export function projectRefines(config: Pick<ProjectConfig, 'pipeline'>): boolean {
  return (
    labelDefinition(config, REFINE_LABEL) !== undefined || config.pipeline.stages.some(isRefinementStage)
  );
}

/**
 * Whether the card is being refined: it is open, a card (not a theme), still before the work stage, and
 * either carries the `refine` label (which the project knows) or stands in a refinement stage.
 */
export function isRefining(task: RefinementTask, config: RefinementConfig): boolean {
  if (!isOpenTask(task) || isTheme(task)) return false;
  const stage = stageOf(config, task.stageId);
  const work = developmentStage(config);
  if (!stage || !work || stageIndex(config.pipeline, stage.id) >= stageIndex(config.pipeline, work.id))
    return false;
  return (
    isRefinementStage(stage) ||
    (task.labels.includes(REFINE_LABEL) && labelDefinition(config, REFINE_LABEL) !== undefined)
  );
}

/**
 * Whose turn it is on a card that is being refined:
 * - `step`: the gate lacks `label` (a condition of the gate of `stageId`); `aiSetters` and
 *   `humanSetters` are the members who may put it on this card;
 * - `blocked`: the card cannot go on by itself, because a blocking label is on it (such as "waiting
 *   for an answer") or a gate asks for a label to be absent (`label`);
 * - `done`: every label is on: the card moves to `targetStageId` (the last stage before the work
 *   stage, null when the card is there already) and the system takes `refine` off.
 * Null when the card is not being refined.
 */
export type RefinementTurn =
  | { kind: 'step'; stageId: string; label: string; aiSetters: string[]; humanSetters: string[] }
  | { kind: 'blocked'; label: string }
  | { kind: 'done'; targetStageId: string | null }
  | null;

export function refinementTurn(task: RefinementTask, config: RefinementConfig): RefinementTurn {
  if (!isRefining(task, config)) return null;
  const { stages } = config.pipeline;
  const from = stageIndex(config.pipeline, task.stageId);
  const to = stageIndex(config.pipeline, developmentStage(config)!.id);
  const blocking = task.labels.find((id) => labelDefinition(config, id)?.blocks);
  if (blocking !== undefined) return { kind: 'blocked', label: blocking };

  let forbidden: string | undefined;
  for (const stage of stages.slice(from, to + 1)) {
    for (const condition of stage.gate?.conditions ?? []) {
      if (conditionHolds(task, condition)) continue;
      if (condition.type === 'lacks_label') {
        forbidden ??= condition.label;
        continue;
      }
      const definition = labelDefinition(config, condition.label);
      const setters = definition ? labelSetters(config, definition, task) : [];
      // A label only humans set stands for an approval: its setters are people by definition.
      const aiSetters =
        definition && isHumanOnlyLabel(definition)
          ? []
          : setters.filter((handle) => memberOf(config, handle)?.kind === 'ai');
      return {
        kind: 'step',
        stageId: stage.id,
        label: condition.label,
        aiSetters,
        humanSetters: setters.filter((handle) => !aiSetters.includes(handle)),
      };
    }
  }
  if (forbidden !== undefined) return { kind: 'blocked', label: forbidden };
  return { kind: 'done', targetStageId: to - 1 > from ? stages[to - 1]!.id : null };
}
