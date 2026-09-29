import clsx from 'clsx';
import { t } from '../i18n/t';
import type { PipelineIndex } from '../lib/pipeline';
import { stagePosition } from '../lib/pipeline';
import type { TaskPhase } from '../lib/taskState';
import styles from './StageProgress.module.css';

interface StageProgressProps {
  pipeline: PipelineIndex;
  stageId: string;
  phase: TaskPhase;
  /** card: thin segments; stepper: segments grouped by column with names; chip: compact. */
  variant?: 'card' | 'stepper' | 'chip';
  className?: string;
}

type SegmentState = 'done' | 'current' | 'todo' | 'finished';

function segmentState(index: number, current: number, phase: TaskPhase): SegmentState {
  if (phase === 'done') return 'finished';
  if (index < current) return 'done';
  if (index === current) return 'current';
  return 'todo';
}

/** Pipeline progress: one segment per stage; stages sharing a board column sit closer. */
export function StageProgress({ pipeline, stageId, phase, variant = 'card', className }: StageProgressProps) {
  const current = pipeline.stageIndex.get(stageId) ?? 0;
  const stage = pipeline.stageById.get(stageId);
  const { index, total } = stagePosition(pipeline, stageId);
  const label = t('taskCard.stageProgress', { stage: stage?.name ?? stageId, index, total });

  if (variant === 'stepper') {
    const currentColumn = pipeline.columnOfStage.get(stageId)?.id;
    return (
      <ol className={clsx(styles.stepper, className)} aria-label={label}>
        {pipeline.columns.map((column) => {
          const stages = pipeline.stages.filter(
            (entry) => pipeline.columnOfStage.get(entry.id)?.id === column.id,
          );
          if (stages.length === 0) return null;
          const isCurrent = column.id === currentColumn;
          const firstIndex = pipeline.stageIndex.get(stages[0]!.id) ?? 0;
          const passed = phase === 'done' || firstIndex < current;
          return (
            <li
              key={column.id}
              className={clsx(
                styles.step,
                isCurrent && styles.stepCurrent,
                passed && !isCurrent && styles.stepPassed,
              )}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className={styles.stepSegments}>
                {stages.map((entry) => (
                  <span
                    key={entry.id}
                    className={styles.segment}
                    data-state={segmentState(pipeline.stageIndex.get(entry.id) ?? 0, current, phase)}
                    data-phase={phase}
                    title={entry.name}
                  />
                ))}
              </span>
              <span className={styles.stepName}>
                {isCurrent && stages.length > 1 && stage ? `${column.name} · ${stage.name}` : column.name}
              </span>
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <span
      className={clsx(styles.bar, variant === 'chip' && styles.chip, className)}
      role="img"
      aria-label={label}
    >
      {pipeline.stages.map((entry, i) => {
        const previous = pipeline.stages[i - 1];
        const newColumn =
          previous &&
          pipeline.columnOfStage.get(previous.id)?.id !== pipeline.columnOfStage.get(entry.id)?.id;
        return (
          <span
            key={entry.id}
            className={clsx(styles.segment, newColumn && styles.columnStart)}
            data-state={segmentState(i, current, phase)}
            data-phase={phase}
          />
        );
      })}
    </span>
  );
}
