import clsx from 'clsx';
import { Fragment, useEffect, useRef, useState } from 'react';
import { isArchivedTheme, isOpenTask } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { Button } from '../../components/Button';
import { ColumnBar } from '../../components/ColumnBar';
import { Icon } from '../../components/Icon';
import { PriorityMark } from '../../components/PriorityMark';
import { t } from '../../i18n/t';
import type { PipelineIndex } from '../../lib/pipeline';
import { columnProgressOf, progressOf, themeGroups } from './themeModel';
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
  const [showHidden, setShowHidden] = useState(false);
  const firstHidden = useRef<HTMLLIElement | null>(null);
  // The closed and archived tiles open at the end of the row, maybe out of sight: bring the first into view.
  useEffect(() => {
    if (!showHidden) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    firstHidden.current?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [showHidden]);
  const { open, closed, archived } = themeGroups(tasks);
  if (open.length + closed.length + archived.length === 0) return null;
  const hiddenCount = closed.length + archived.length;
  // The theme the board is filtered to stays on show even when it is closed or archived.
  const visible = (theme: Task) => showHidden || theme.key === active;
  const shown = [...open, ...closed.filter(visible), ...archived.filter(visible)];
  const hiddenLabel =
    archived.length === 0
      ? t('board.themes.closed', { count: hiddenCount })
      : closed.length === 0
        ? t('board.themes.archived', { count: hiddenCount })
        : t('board.themes.closedArchived', { count: hiddenCount });
  return (
    <section className={styles.strip} aria-label={t('board.themes.title')}>
      <ul className={styles.tiles}>
        {shown.map((theme, index) => {
          const progress = progressOf(theme, tasks);
          const isArchived = isArchivedTheme(theme);
          const firstArchived = isArchived && !(shown[index - 1] && isArchivedTheme(shown[index - 1]!));
          const segments = columnProgressOf(theme, tasks, pipeline);
          const distribution = segments
            .map(({ column, count }) => t('board.themes.columnCount', { column: column.name, count }))
            .join(', ');
          const pressed = theme.key === active;
          return (
            <Fragment key={theme.key}>
              {firstArchived && showHidden ? (
                <li className={styles.heading}>{t('board.themes.archivedHeading')}</li>
              ) : null}
              <li
                ref={index === open.length ? firstHidden : undefined}
                className={clsx(
                  styles.tile,
                  pressed && styles.active,
                  (isArchived || !isOpenTask(theme)) && styles.closed,
                )}
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
                    {isArchived ? (
                      <Icon name="archive" size={12} />
                    ) : !isOpenTask(theme) ? (
                      <Icon name="lock" size={12} />
                    ) : null}
                    {theme.priority === 'urgent' || theme.priority === 'high' ? (
                      <PriorityMark priority={theme.priority} />
                    ) : null}
                    <span className={styles.nameText}>{theme.title}</span>
                  </span>
                  <span className={styles.progress}>
                    <ColumnBar segments={segments} total={progress.total} />
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
            </Fragment>
          );
        })}
      </ul>
      <div className={styles.actions}>
        {hiddenCount > 0 ? (
          <Button
            variant="muted"
            size="sm"
            aria-expanded={showHidden}
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden
              ? t(archived.length === 0 ? 'board.themes.hideClosed' : 'board.themes.hideHidden')
              : hiddenLabel}
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
