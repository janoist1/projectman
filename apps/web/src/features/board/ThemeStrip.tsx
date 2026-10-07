import clsx from 'clsx';
import { useState } from 'react';
import { isOpenTask } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import type { PipelineIndex } from '../../lib/pipeline';
import { columnProgressOf, progressOf, sortedThemes } from './themeModel';
import styles from './ThemeStrip.module.css';

/**
 * The themes above the board (PM-192): one tile each with its name and progress. The tile's main part
 * turns the board's filter to that theme on and off, the arrow opens the theme's own card. The closed
 * themes stay out of sight until asked for. Shown only when the project has a theme.
 */
export function ThemeStrip({
  tasks,
  pipeline,
  active,
  onFilter,
  onOpen,
  onNew,
}: {
  tasks: readonly Task[];
  pipeline: PipelineIndex;
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
      <ul className={styles.tiles}>
        {shown.map((theme) => {
          const progress = progressOf(theme, tasks);
          const segments = columnProgressOf(theme, tasks, pipeline);
          const distribution = segments
            .map(({ column, count }) => t('board.themes.columnCount', { column: column.name, count }))
            .join(', ');
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
                aria-describedby={segments.length > 0 ? `theme-distribution-${theme.key}` : undefined}
                title={distribution || undefined}
                onClick={() => onFilter(pressed ? null : theme.key)}
              >
                <span className={styles.name}>
                  {!isOpenTask(theme) ? <Icon name="lock" size={12} /> : null}
                  <span className={styles.nameText}>{theme.title}</span>
                </span>
                <span className={styles.progress}>
                  <span className={styles.bar} aria-hidden="true">
                    {segments.map(({ column, count }) => (
                      <span
                        key={column.id}
                        className={styles.segment}
                        data-column-color={column.color}
                        style={{ width: `${(count / progress.total) * 100}%` }}
                        title={t('board.themes.columnCount', { column: column.name, count })}
                      />
                    ))}
                  </span>
                  {segments.length > 0 ? (
                    <span id={`theme-distribution-${theme.key}`} className="visually-hidden">
                      {distribution}
                    </span>
                  ) : null}
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
