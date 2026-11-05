import { introducedErrors, ownerOnlyChanges } from '@projectman/shared';
import type { Pipeline, ProjectConfig } from '@projectman/shared';
import { t } from '../../../i18n/t';
import { issueMessage } from '../../../lib/configIssues';
import { columnMoveStep, columnSpan, moveStage, stageMoveStep } from './flow';

/** Why the pipeline cannot be saved in this order, as a sentence; null when it can. Only a new error forbids it. */
export function moveRefusal(config: ProjectConfig, pipeline: Pipeline, isOwner: boolean): string | null {
  const next = { ...config, pipeline };
  const [first] = introducedErrors(config, next);
  if (first) return issueMessage(first);
  if (!isOwner && ownerOnlyChanges(config, next).length > 0) return t('settings.edit.approvalOwnerOnly');
  return null;
}

/** What a menu item moves, or why it cannot. */
export interface MovePlan {
  /** The pipeline after the move; null when nothing can move there. */
  pipeline: Pipeline | null;
  /** The column the stage joins, when the step changes it. */
  columnName: string | null;
  reason: string | null;
}

const NOTHING = { pipeline: null, columnName: null } as const;

/** One step of a stage from its ⋯ menu. */
export function stageMovePlan(
  config: ProjectConfig,
  stageId: string,
  direction: 'up' | 'down',
  isOwner: boolean,
): MovePlan {
  const step = stageMoveStep(config.pipeline, stageId, direction);
  if (!step)
    return {
      ...NOTHING,
      reason: t(
        direction === 'up' ? 'settings.pipeline.move.firstStage' : 'settings.pipeline.move.lastStage',
      ),
    };
  const pipeline = moveStage(config.pipeline, stageId, step);
  const stage = config.pipeline.stages.find((candidate) => candidate.id === stageId);
  const columnName =
    stage?.columnId === step.columnId
      ? null
      : (config.pipeline.columns.find((column) => column.id === step.columnId)?.name ?? step.columnId);
  return { pipeline, columnName, reason: moveRefusal(config, pipeline, isOwner) };
}

/** One step of a column, with its stages, from its ⋯ menu. */
export function columnMovePlan(
  config: ProjectConfig,
  columnId: string,
  direction: 'up' | 'down',
  isOwner: boolean,
): MovePlan {
  const span = columnSpan(config.pipeline, columnId);
  if (span === 'scattered') return { ...NOTHING, reason: t('settings.pipeline.move.scattered') };
  const pipeline = columnMoveStep(config.pipeline, columnId, direction);
  if (!pipeline)
    return {
      ...NOTHING,
      reason: t(
        direction === 'up' ? 'settings.pipeline.move.columnFirst' : 'settings.pipeline.move.columnLast',
      ),
    };
  return { pipeline, columnName: null, reason: moveRefusal(config, pipeline, isOwner) };
}
