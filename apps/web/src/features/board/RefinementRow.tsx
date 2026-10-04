import clsx from 'clsx';
import { useId, useState } from 'react';
import type { LabelView, RefinementProgress } from '@projectman/shared';
import { Icon } from '../../components/Icon';
import { joinNames, t } from '../../i18n/t';
import { labelName } from '../../lib/labels';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import styles from './RefinementRow.module.css';

type StepState = 'done' | 'current' | 'held' | 'todo';

const MARKS: Record<StepState, string> = { done: '✓', current: '●', held: '●', todo: '○' };

/**
 * The standing of a card's refinement (PM-291), under the status line in the same box: how many steps are
 * done with a small bar, and the steps themselves on request. The steps are the labels the gates before the
 * work stage ask for; the first one left is on turn, or stands still while a label holds the card.
 */
export function RefinementRow({
  refinement,
  labels,
  members,
  myHandle,
  pipeline,
}: {
  refinement: RefinementProgress;
  labels: readonly LabelView[];
  members: MemberIndex;
  myHandle: string | null;
  pipeline: PipelineIndex;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { steps, turn, targetStageId } = refinement;
  const done = steps.filter((step) => step.done).length;
  const firstLeft = steps.findIndex((step) => !step.done);
  const quoted = (id: string) => t('taskStatus.quoted', { name: labelName(id, labels) });
  const stateOf = (index: number): StepState => {
    if (steps[index]!.done) return 'done';
    if (index !== firstLeft) return 'todo';
    return turn.kind === 'step' ? 'current' : turn.kind === 'blocked' ? 'held' : 'todo';
  };
  const detailOf = (index: number): string | null => {
    const state = stateOf(index);
    if (state === 'current' && turn.kind === 'step') {
      const setters = turn.aiSetters.length > 0 ? turn.aiSetters : turn.humanSetters;
      return setters.length > 0
        ? t('taskStatus.refinement.stepTurn', {
            names: joinNames(setters.map((handle) => nameOf(handle, members, myHandle))),
          })
        : null;
    }
    if (state === 'held' && turn.kind === 'blocked')
      return t('taskStatus.refinement.stepHeld', { labels: quoted(turn.label) });
    return null;
  };
  const targetName = targetStageId ? pipeline.stageById.get(targetStageId)?.name : undefined;
  return (
    <div className={styles.refinement}>
      <div className={styles.row}>
        <span className={styles.progress}>
          {t('taskStatus.refinement.progress', { done, total: steps.length })}
        </span>
        <span className={styles.segments} aria-hidden="true">
          {steps.map((step, index) => (
            <span key={step.label} className={styles.segment} data-state={stateOf(index)} />
          ))}
        </span>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
        >
          {t('taskStatus.refinement.steps')}
          <span className={clsx(styles.chevron, open && styles.chevronOpen)}>
            <Icon name="chevronDown" size={14} />
          </span>
        </button>
      </div>
      <div id={listId} hidden={!open}>
        {open ? (
          <div className={styles.details}>
            <ol className={styles.steps} aria-label={t('taskStatus.refinement.stepsList')}>
              {steps.map((step, index) => {
                const state = stateOf(index);
                const detail = detailOf(index);
                return (
                  <li
                    key={step.label}
                    className={styles.step}
                    data-state={state}
                    aria-current={state === 'current' || state === 'held' ? 'step' : undefined}
                  >
                    <span className={styles.mark} aria-hidden="true">
                      {MARKS[state]}
                    </span>
                    <span>
                      {quoted(step.label)}
                      {detail ? ` · ${detail}` : ''}
                      <span className="visually-hidden">{`, ${t(`taskStatus.refinement.stepState.${state}`)}`}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className={styles.next}>
              {targetName
                ? t('taskStatus.refinement.next', { stage: targetName })
                : t('taskStatus.refinement.nextHere')}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
