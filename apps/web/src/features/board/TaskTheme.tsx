import { Link } from 'react-router';
import { isOpenTask } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useCardLink } from './cardSize';
import { useDrawerBase } from './drawerBase';
import { sortedThemes } from './themeModel';
import drawer from './drawer.module.css';
import styles from './TaskLifecycle.module.css';

/**
 * The "Téma" row of a card (PM-192): the theme it belongs to. A card that is not a subtask picks one of the
 * open themes (saved the moment it changes); a collecting card says that its subtasks follow. A subtask
 * reads its collecting card's theme and cannot change it. Shown only when the project has a theme.
 */
export function TaskTheme({ task, tasks }: { task: Task; tasks: readonly Task[] }) {
  const { key, can } = useProject();
  const cardLink = useCardLink();
  const drawerBase = useDrawerBase();
  const update = useUpdateTask(key);
  const toast = useToast();
  const themes = sortedThemes(tasks);
  if (themes.length === 0) return null;
  const current = themes.find((theme) => theme.key === task.themeKey) ?? null;
  const subtaskCount = tasks.filter((child) => child.parentKey === task.key).length;

  if (task.parentKey) {
    return (
      <div className={drawer.prop}>
        <span className={drawer.propLabel}>{t('task.theme')}</span>
        <span>
          {current ? (
            <Link to={cardLink(drawerBase.card(current.key))}>{current.title}</Link>
          ) : (
            <span className={drawer.propMuted}>{t('task.themeNone')}</span>
          )}{' '}
          <span className={drawer.propMuted}>· {t('task.themeFromParent', { key: task.parentKey })}</span>
        </span>
      </div>
    );
  }

  if (!can.createTasks) {
    return (
      <div className={drawer.prop}>
        <span className={drawer.propLabel}>{t('task.theme')}</span>
        {current ? (
          <Link to={cardLink(drawerBase.card(current.key))}>{current.title}</Link>
        ) : (
          <span className={drawer.propMuted}>{t('task.themeNone')}</span>
        )}
      </div>
    );
  }

  // The open themes, and the card's own when it was closed after the card joined it.
  const choices = themes.filter((theme) => isOpenTask(theme) || theme.key === current?.key);
  const value = update.isPending ? (update.variables?.body.themeKey ?? '') : (task.themeKey ?? '');
  return (
    <div className={drawer.prop}>
      <label className={drawer.propLabel} htmlFor={`theme-${task.key}`}>
        {t('task.theme')}
      </label>
      <select
        id={`theme-${task.key}`}
        className={styles.select}
        value={value}
        disabled={update.isPending}
        onChange={(event) => {
          const next = event.target.value;
          update.mutate(
            { taskKey: task.key, body: { themeKey: next || null } },
            {
              onSuccess: () => {
                const title = themes.find((theme) => theme.key === next)?.title;
                toast.show(title ? t('task.themeSet', { title }) : t('task.themeSetNone'));
              },
            },
          );
        }}
      >
        <option value="">{t('task.themeNone')}</option>
        {choices.map((theme) => (
          <option key={theme.key} value={theme.key}>
            {isOpenTask(theme) ? theme.title : t('task.themeClosed', { title: theme.title })}
          </option>
        ))}
      </select>
      {subtaskCount > 0 ? (
        <span className={`${drawer.propWide} ${drawer.propMuted}`}>
          {t('task.themeKids', { count: subtaskCount })}
        </span>
      ) : null}
      {update.isError ? (
        <p role="alert" className={`${drawer.propWide} ${drawer.error}`}>
          {errorMessage(update.error)}
        </p>
      ) : null}
    </div>
  );
}
