import clsx from 'clsx';
import { useState } from 'react';
import { isOpenTask } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { percentOf, progressOf, sortedThemes } from './themeModel';
import styles from './ThemeStrip.module.css';

/**
 * The themes above the board (PM-192): one tile each with its name and progress. The tile's main part
 * turns the board's filter to that theme on and off, the arrow opens the theme's own card. The closed
 * themes stay out of sight until asked for. Shown only when the project has a theme.
 */
export function ThemeStrip({
  tasks,
  active,
  onFilter,
  onOpen,
  onNew,
}: {
  tasks: readonly Task[];
  /** The theme the board is filtered to. */
  active: string | null;
  onFilter: (themeKey: string | null) => void;
  onOpen: (themeKey: string) => void;
  /** Creating a theme, for those who may create cards. */
  onNew?: () => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const themes = sortedThemes(tasks);
  if (themes.length === 0) return null;
  const closedCount = themes.filter((theme) => !isOpenTask(theme)).length;
  // The theme the board is filtered to stays on show even when it is closed.
  const shown = themes.filter((theme) => isOpenTask(theme) || showClosed || theme.key === active);
  return (
    <section className={styles.strip} aria-label={t('board.themes.title')}>
      <h2 className={styles.title}>{t('board.themes.title')}</h2>
      <ul className={styles.tiles}>
        {shown.map((theme) => {
          const progress = progressOf(theme, tasks);
          const pressed = theme.key === active;
          return (
            <li
              key={theme.key}
              className={clsx(styles.tile, pressed && styles.active, !isOpenTask(theme) && styles.closed)}
            >
              <button
                type="button"
                className={styles.main}
                aria-pressed={pressed}
                aria-label={t('board.themes.filter', {
                  title: theme.title,
                  done: progress.done,
                  total: progress.total,
                })}
                onClick={() => onFilter(pressed ? null : theme.key)}
              >
                <span className={styles.name}>
                  {!isOpenTask(theme) ? <Icon name="lock" size={12} /> : null}
                  <span className={styles.nameText}>{theme.title}</span>
                </span>
                <span className={styles.progress}>
                  <span className={styles.bar} aria-hidden="true">
                    <span className={styles.barDone} style={{ width: `${percentOf(progress)}%` }} />
                  </span>
                  <span className={styles.count}>
                    {t('board.themes.progress', { done: progress.done, total: progress.total })}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className={styles.open}
                aria-label={t('board.themes.open', { title: theme.title })}
                onClick={() => onOpen(theme.key)}
              >
                <Icon name="chevronRight" size={16} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className={styles.actions}>
        {closedCount > 0 ? (
          <Button
            variant="muted"
            size="sm"
            aria-expanded={showClosed}
            onClick={() => setShowClosed((value) => !value)}
          >
            {showClosed ? t('board.themes.hideClosed') : t('board.themes.closed', { count: closedCount })}
          </Button>
        ) : null}
        {onNew ? (
          <Button variant="muted" size="sm" icon="plus" onClick={onNew}>
            {t('board.themes.new')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
