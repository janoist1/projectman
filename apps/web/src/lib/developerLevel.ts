import { developerLevelOf, isOpenTask } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { t } from '../i18n/t';
import type { PipelineIndex } from './pipeline';

/**
 * Whether the card shows the "Senior" mark (PM-349): a Senior task, still open, in a queue or work stage.
 * Not while its status line says "A Seniorra vár" (it would be said twice on one card).
 */
export function showsSeniorMark(task: Task, pipeline: PipelineIndex): boolean {
  const kind = pipeline.stageById.get(task.stageId)?.kind;
  return (
    developerLevelOf(task) === 'senior' &&
    isOpenTask(task) &&
    (kind === 'queue' || kind === 'work') &&
    task.startWaiting?.reason !== 'senior_busy'
  );
}

/** The mark's title and accessible name: "Senior-feladat: {reason}". */
export function seniorMarkLabel(task: Task): string {
  const reason = task.developerLevel?.reason?.trim();
  return reason ? t('task.level.markLabel', { reason }) : t('task.level.markLabelNoReason');
}
