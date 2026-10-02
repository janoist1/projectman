import { openPrerequisites } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { joinNames, t } from '../../i18n/t';
import styles from './PrerequisiteWarning.module.css';

/** The keys of the card's prerequisites that are not closed, as far as `tasks` shows them. */
export function openPrerequisiteKeys(task: Task, tasks: readonly Task[]): string[] {
  return openPrerequisites(task, tasks).map((card) => card.key);
}

/** The open prerequisites a refused start names (409 `prerequisite_open`); null for any other error. */
export function refusedPrerequisites(error: unknown): string[] | null {
  if (!isApiError(error) || error.code !== 'prerequisite_open') return null;
  const keys = (error.details as { prerequisites?: unknown } | undefined)?.prerequisites;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
}

/**
 * The warning before a person starts a card whose prerequisite is open (PM-204): it names the open
 * prerequisites, and the person starts anyway or leaves the card waiting.
 */
export function PrerequisiteWarning({
  keys,
  rows,
  tasks,
  loading,
  onConfirm,
  onWait,
  onClose,
}: {
  /** The open prerequisites; null: no warning shown. */
  keys: string[] | null;
  /** A group move (PM-121): one warning for the whole group, a row per card that would wait. */
  rows?: readonly { key: string; prerequisites: readonly string[] }[];
  tasks: readonly Task[];
  loading?: boolean;
  onConfirm: () => void;
  /** A move only: the card moves and waits for its prerequisites instead of starting. */
  onWait?: () => void;
  onClose: () => void;
}) {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  return (
    <Dialog
      open={keys !== null}
      onClose={onClose}
      title={t('prerequisiteWarning.title')}
      description={
        rows
          ? t('prerequisiteWarning.groupDescription')
          : t('prerequisiteWarning.description', { keys: joinNames(keys ?? []) })
      }
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {onWait ? (
            <Button variant="secondary" size="md" loading={loading} onClick={onWait}>
              {t('prerequisiteWarning.moveAndWait')}
            </Button>
          ) : null}
          <Button variant="primary" size="md" className={styles.start} loading={loading} onClick={onConfirm}>
            {t('prerequisiteWarning.confirm')}
          </Button>
        </>
      }
    >
      <ul className={styles.list}>
        {rows
          ? rows.map((row) => (
              <li key={row.key}>
                {t('prerequisiteWarning.groupRow', { key: row.key, keys: joinNames([...row.prerequisites]) })}
              </li>
            ))
          : (keys ?? []).map((key) => (
              <li key={key}>{byKey.get(key) ? `${key} – ${byKey.get(key)!.title}` : key}</li>
            ))}
      </ul>
    </Dialog>
  );
}
