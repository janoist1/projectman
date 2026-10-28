import { useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  canSetComplexity,
  COMPLEXITY_POINTS,
  COMPLEXITY_REASON_MAX,
  isComplexityPoints,
  isOpenTask,
  isTheme,
  reachingDevelopers,
  stageDevelopers,
  workStageOf,
} from '@projectman/shared';
import type { ProjectConfig, Task } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useConfig, useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { TextAreaField } from '../../components/Field';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import drawer from './drawer.module.css';
import styles from './TaskComplexity.module.css';

function noneReach(config: ProjectConfig, task: Task, points: number | null) {
  const stage = workStageOf(config, task);
  return (
    isComplexityPoints(points) &&
    !!stage &&
    reachingDevelopers(stageDevelopers(config, stage), points, task.labels).length === 0
  );
}

export function TaskComplexity({ task }: { task: Task }) {
  const { key, can, myHandle } = useProject();
  const configQuery = useConfig(key, can.readConfig);
  const config = can.readConfig ? configQuery.data?.config : undefined;
  const editable = !!config && myHandle !== null && canSetComplexity(config, myHandle) && isOpenTask(task);
  const [editing, setEditing] = useState(false);
  const pencil = useRef<HTMLButtonElement>(null);
  if (isTheme(task) || (!task.complexity && !editable)) return null;
  const points = task.complexity?.points ?? null;
  const close = () => {
    setEditing(false);
    requestAnimationFrame(() => pencil.current?.focus());
  };
  return (
    <div className={drawer.prop}>
      <span className={drawer.propLabel}>{t('task.complexity.label')}</span>
      <span>
        {!editing ? (
          points === null ? (
            <span className={drawer.propMuted}>{t('task.complexity.empty')}</span>
          ) : (
            <span className={styles.value}>
              <span className={styles.points} aria-hidden="true">
                {points}
              </span>
              {t('task.complexity.points', { points })}
            </span>
          )
        ) : null}
      </span>
      {editable && !editing ? (
        <Button
          ref={pencil}
          variant="muted"
          size="sm"
          iconOnly
          icon="pencil"
          aria-label={t('task.complexity.edit')}
          onClick={() => setEditing(true)}
        />
      ) : (
        <span />
      )}
      {task.complexity?.reason && !editing ? (
        <span className={`${drawer.propWide} ${drawer.propMuted}`}>{task.complexity.reason}</span>
      ) : null}
      {config && noneReach(config, task, points) && !editing ? (
        <span className={`${drawer.propWide} ${styles.warning}`}>
          {t('task.complexity.noneReach', { points: points! })}
        </span>
      ) : null}
      {editing && config ? <ComplexityEditor task={task} config={config} onClose={close} /> : null}
    </div>
  );
}

function ComplexityEditor({
  task,
  config,
  onClose,
}: {
  task: Task;
  config: ProjectConfig;
  onClose: () => void;
}) {
  const { key } = useProject();
  const update = useUpdateTask(key);
  const toast = useToast();
  const [value, setValue] = useState(String(task.complexity?.points ?? ''));
  const [reason, setReason] = useState(task.complexity?.reason ?? '');
  const points = Number(value);
  return (
    <form
      className={`${drawer.propWide} ${styles.editor}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (update.isPending) return;
        update.mutate(
          {
            taskKey: task.key,
            body: {
              complexity: {
                points: isComplexityPoints(points) ? points : null,
                reason: value ? reason.trim() || null : null,
              },
            },
          },
          {
            onSuccess: () => {
              toast.show(value ? t('task.complexity.saved', { points }) : t('task.complexity.removed'));
              onClose();
            },
          },
        );
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <fieldset disabled={update.isPending} className={styles.fields}>
        <SegmentedControl
          asRadioGroup
          label={t('task.complexity.choice')}
          size="sm"
          className={styles.segments}
          value={value}
          onChange={setValue}
          options={[
            { value: '', label: '–', ariaLabel: t('task.complexity.empty') },
            ...COMPLEXITY_POINTS.map((points) => ({
              value: String(points),
              label: String(points),
              ariaLabel: t('task.complexity.points', { points }),
            })),
          ]}
        />
        <p className={styles.note}>{t('task.complexity.maximum')}</p>
        {value ? (
          <TextAreaField
            label={t('task.complexity.reason')}
            placeholder={t('task.complexity.reasonPlaceholder')}
            rows={2}
            maxLength={COMPLEXITY_REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        ) : null}
        {noneReach(config, task, points) ? (
          <p className={styles.note}>
            {t('task.complexity.noneReachEditor', { points })}{' '}
            <Link to={`/p/${key}/team`}>{t('task.complexity.teamLink')}</Link>
          </p>
        ) : null}
        {task.assignee ? <p className={styles.note}>{t('task.complexity.keepsAssignee')}</p> : null}
      </fieldset>
      {update.isError ? (
        <p role="alert" className={drawer.error}>
          {isApiError(update.error) && update.error.status < 500
            ? errorMessage(update.error)
            : t('task.complexity.saveFailed')}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" size="sm" loading={update.isPending}>
          {update.isPending ? t('task.complexity.saving') : t('task.complexity.save')}
        </Button>
        <Button variant="secondary" size="sm" disabled={update.isPending} onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
