import { isTheme } from '@projectman/shared';
import type { LabelView } from '@projectman/shared';
import type { BoardColumnView, Task } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { joinNames, t } from '../../i18n/t';
import { errorMessage, isGateBlocked } from '../../lib/errors';
import { unmetGateTexts } from '../../lib/gates';
import type { PipelineIndex } from '../../lib/pipeline';
import { isTaskClosed } from '../../lib/taskState';
import { openPrerequisiteKeys } from './PrerequisiteWarning';

export function canMoveTask(task: Task, allowed: boolean): boolean {
  return allowed && !isTaskClosed(task) && !isTheme(task);
}

export function enteredStages(pipeline: PipelineIndex, from: string, to: string) {
  const start = pipeline.stageIndex.get(from) ?? -1;
  const end = pipeline.stageIndex.get(to);
  if (end === undefined) return [];
  return end > start ? pipeline.stages.slice(start + 1, end + 1) : [pipeline.stages[end]!];
}

/** Columns may contain several stages: dropping enters their first stage in pipeline order. */
export function dropStage(task: Task, column: BoardColumnView, pipeline: PipelineIndex): string | null {
  if (pipeline.columnOfStage.get(task.stageId)?.id === column.id) return null;
  return pipeline.stages.find((stage) => pipeline.columnOfStage.get(stage.id)?.id === column.id)?.id ?? null;
}

/**
 * The open prerequisites of a card that a move into `stageId` would start work on regardless
 * (PM-204): a card without an assignee that enters a work stage starts by itself, and with an open
 * prerequisite it would rather wait. Empty when the move starts nothing, or nothing is open.
 */
export function prerequisitesToWarnAbout(
  task: Task,
  stageId: string,
  pipeline: PipelineIndex,
  tasks: readonly Task[],
): string[] {
  if (task.assignee || pipeline.stageById.get(stageId)?.kind !== 'work') return [];
  return openPrerequisiteKeys(task, tasks);
}

export function moveErrorText(error: unknown, labels: readonly LabelView[]): string {
  const unmet = isGateBlocked(error) && isApiError(error) ? unmetGateTexts(error.details, labels) : [];
  return [errorMessage(error), unmet.length ? t('errors.gateUnmet', { conditions: joinNames(unmet) }) : '']
    .filter(Boolean)
    .join(' ');
}
