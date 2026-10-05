import { useId, useRef } from 'react';
import { TASK_PRIORITIES } from '@projectman/shared';
import type { Task, TaskPriority as Priority } from '@projectman/shared';
import { useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { PriorityMark } from '../../components/PriorityMark';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import drawer from './drawer.module.css';
import styles from './TaskLifecycle.module.css';

/** Shared by the drawer and expanded view; saves immediately and follows live card updates. */
export function TaskPrioritySelect({ task }: { task: Task }) {
  const { key, can } = useProject();
  const update = useUpdateTask(key);
  const id = useId();
  const select = useRef<HTMLSelectElement>(null);
  const priority = update.isPending ? (update.variables?.body.priority ?? null) : task.priority;
  if (!can.createTasks && !priority) return null;
  return (
    <div className={drawer.prop}>
      <label htmlFor={can.createTasks ? id : undefined} className={drawer.propLabel}>
        {t('priority.label')}
      </label>
      <span className={styles.priorityValue}>
        {priority ? <PriorityMark priority={priority} /> : null}
        {can.createTasks ? (
          <select
            id={id}
            ref={select}
            className={styles.select}
            style={!priority ? { color: 'var(--c-ink-3)' } : undefined}
            value={priority ?? ''}
            disabled={update.isPending}
            onChange={(event) =>
              update.mutate(
                { taskKey: task.key, body: { priority: (event.target.value || null) as Priority | null } },
                { onError: () => requestAnimationFrame(() => select.current?.focus()) },
              )
            }
          >
            <option value="">{t('priority.none')}</option>
            {TASK_PRIORITIES.map((level) => (
              <option key={level} value={level}>
                {t(`priority.levels.${level}`)}
              </option>
            ))}
          </select>
        ) : priority ? (
          <span>{t(`priority.levels.${priority}`)}</span>
        ) : null}
      </span>
      {update.isError ? (
        <p role="alert" className={`${drawer.propWide} ${drawer.error}`}>
          {errorMessage(update.error) === t('errors.generic')
            ? t('priority.saveFailed')
            : errorMessage(update.error)}
        </p>
      ) : null}
    </div>
  );
}
