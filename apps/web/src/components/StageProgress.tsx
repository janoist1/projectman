import clsx from 'clsx';
import { useState } from 'react';
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
  const [openColumn, setOpenColumn] = useState<string | null>(null);
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
          // Only a multi-step column has anything more to show than its name.
          const expandable = stages.length > 1;
          const open = expandable && openColumn === column.id;
          // A tap focuses the step (and emulates a hover), so touch needs no handler of its own;
          // tapping elsewhere blurs it.
          const close = () => setOpenColumn((id) => (id === column.id ? null : id));
          return (
            <li
              key={column.id}
              className={clsx(
                styles.step,
                isCurrent && styles.stepCurrent,
                passed && !isCurrent && styles.stepPassed,
                expandable && styles.stepExpandable,
              )}
              data-column-color={column.color}
              aria-current={isCurrent ? 'step' : undefined}
              tabIndex={expandable ? 0 : undefined}
              aria-expanded={expandable ? open : undefined}
              onMouseEnter={expandable ? () => setOpenColumn(column.id) : undefined}
              onMouseLeave={expandable ? close : undefined}
              onFocus={expandable ? () => setOpenColumn(column.id) : undefined}
              onBlur={
                expandable
                  ? (event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) close();
                    }
                  : undefined
              }
              onKeyDown={
                expandable
                  ? (event) => {
                      if (event.key === 'Escape') {
                        event.currentTarget.blur();
                        close();
                      }
                    }
                  : undefined
              }
            >
              <span className={styles.stepSegments}>
                {stages.map((entry) => (
                  <span
                    key={entry.id}
                    className={styles.segment}
                    data-state={segmentState(pipeline.stageIndex.get(entry.id) ?? 0, current, phase)}
                    data-phase={phase}
                  />
                ))}
              </span>
              <span className={styles.stepName}>
                {isCurrent && stages.length > 1 && stage ? `${column.name} · ${stage.name}` : column.name}
              </span>
              {open ? (
                <ul
                  className={styles.stepList}
                  aria-label={t('taskCard.columnSteps', { column: column.name })}
                >
                  {stages.map((entry) => {
                    const state = segmentState(pipeline.stageIndex.get(entry.id) ?? 0, current, phase);
                    return (
                      <li key={entry.id} className={styles.stepItem} data-state={state}>
                        <span className={styles.stepMark} aria-hidden="true" />
                        <span className={styles.stepItemName}>{entry.name}</span>
                        <span className={styles.stepItemState}>{t(`taskCard.stepState.${state}`)}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
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
            data-column-color={pipeline.columnOfStage.get(entry.id)?.color}
            data-state={segmentState(i, current, phase)}
            data-phase={phase}
          />
        );
      })}
    </span>
  );
}
