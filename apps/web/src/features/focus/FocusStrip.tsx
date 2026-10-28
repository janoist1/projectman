import clsx from 'clsx';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { isOpenTask, isTheme } from '@projectman/shared';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { useIsMobile } from '../../lib/hooks';
import { useDrawerBase } from '../board/drawerBase';
import { useFocus } from './FocusContext';
import { FocusPanel } from './FocusPanel';
import { useFocusFilter } from './useFocusFilter';
import styles from './FocusStrip.module.css';

/** How many chips the strip shows before "+N": the rest are in the panel. On a phone it is one row without chips. */
const VISIBLE_CHIPS = 5;

/**
 * The project's focus above the board and the map (PM-438): what the team works on now, in order, with
 * the way into the panel and the "Csak a fókusz" filter. Nothing is drawn for a viewer who may not see
 * the focus, and nothing for an empty focus that the viewer cannot set up either.
 */
export function FocusStrip({
  flush = false,
}: {
  /** The page around it already has its own side padding. */ flush?: boolean;
}) {
  const { visible, loading, loadFailed, reload, items, canEdit, tasksByKey } = useFocus();
  const filter = useFocusFilter();
  const mobile = useIsMobile();
  const location = useLocation();
  const base = useDrawerBase();
  const [open, setOpen] = useState(false);
  if (!visible) return null;

  const panel = <FocusPanel open={open} onClose={() => setOpen(false)} />;
  const stripClass = clsx(styles.strip, flush && styles.flush);

  if (loading) {
    return (
      <section className={stripClass} aria-label={t('focus.title')}>
        <p className={styles.note} role="status">
          {t('focus.loading')}
        </p>
      </section>
    );
  }
  if (loadFailed) {
    return (
      <section className={stripClass} aria-label={t('focus.title')}>
        <p className={styles.note} role="alert">
          {t('focus.loadFailed')}
        </p>
        <Button variant="secondary" size="sm" onClick={reload}>
          {t('focus.retry')}
        </Button>
      </section>
    );
  }
  if (items.length === 0) {
    // A viewer who cannot set the focus up has nothing to look at: no strip.
    if (!canEdit) return null;
    return (
      <section className={stripClass} aria-label={t('focus.title')}>
        <span className={styles.title}>
          <Icon name="target" size={15} strokeWidth={2.2} />
          {t('focus.title')}
        </span>
        <p className={styles.note}>{t('focus.empty')}</p>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          {t('focus.setUp')}
        </Button>
        {panel}
      </section>
    );
  }

  const shown = items.slice(0, VISIBLE_CHIPS);
  const hidden = items.length - shown.length;
  return (
    <section className={stripClass} aria-label={t('focus.title')}>
      <button
        type="button"
        className={styles.open}
        aria-haspopup="dialog"
        aria-label={t('focus.open', { count: items.length })}
        onClick={() => setOpen(true)}
      >
        <Icon name="target" size={15} strokeWidth={2.2} />
        <span>{t('focus.title')}</span>
        {mobile ? (
          <>
            <span className={styles.countText}>{t('focus.itemCount', { count: items.length })}</span>
            <Icon name="chevronRight" size={14} strokeWidth={2.4} />
          </>
        ) : (
          <span className={styles.count}>{items.length}</span>
        )}
      </button>
      {mobile ? null : (
        <ol className={styles.chips} aria-label={t('focus.chipsLabel')}>
          {shown.map((item, index) => {
            const task = tasksByKey.get(item.key);
            const closed = task ? !isOpenTask(task) : false;
            // A title the board does not know (a closed card) is shown by its key.
            const name = task?.title ?? item.key;
            return (
              <li key={item.key} className={styles.chipItem}>
                <Link
                  className={clsx(styles.chip, closed && styles.closed)}
                  to={{ pathname: base.card(item.key), search: location.search }}
                  title={closed ? t('focus.chipClosed', { title: name }) : name}
                >
                  <span className={styles.number}>{index + 1}</span>
                  {task && !isTheme(task) ? <span className={styles.key}>{item.key}</span> : null}
                  <span className={styles.chipTitle}>{name}</span>
                  {closed ? <span className="visually-hidden">{t('focus.chipClosedHidden')}</span> : null}
                </Link>
              </li>
            );
          })}
          {hidden > 0 ? (
            <li className={styles.chipItem}>
              <button
                type="button"
                className={clsx(styles.chip, styles.more)}
                title={t('focus.moreTitle', { count: hidden })}
                aria-label={t('focus.moreTitle', { count: hidden })}
                onClick={() => setOpen(true)}
              >
                +{hidden}
              </button>
            </li>
          ) : null}
        </ol>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.only}
          aria-pressed={filter.requested}
          onClick={() => filter.set(!filter.requested)}
        >
          {t('focus.only')}
        </button>
        {/* On a phone the whole title button opens the panel. */}
        {mobile ? null : (
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            {canEdit ? t('focus.edit') : t('focus.details')}
          </Button>
        )}
      </div>
      {panel}
    </section>
  );
}
