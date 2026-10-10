import clsx from 'clsx';
import { t } from '../../i18n/t';
import type { TaskNext } from '../../lib/taskNext';
import styles from './NextLine.module.css';

/**
 * "Miért áll?" on a card row (PM-461): "{ki} · {mire vár}", the name in bold. The title and the
 * accessible name carry the todo as well; the row itself is ellipsized to one line.
 */
export function NextLine({
  next,
  className,
  prefix,
}: {
  next: TaskNext;
  className?: string;
  /** Text before the row (a stale map card says so), as part of the same line. */
  prefix?: string;
}) {
  return (
    <span className={clsx(styles.line, className)} title={next.title}>
      <span className="visually-hidden">{next.title}</span>
      <span aria-hidden="true" className={styles.text}>
        {prefix ? `${prefix}${t('taskStatus.next.between')}` : null}
        <strong className={styles.head}>{next.head}</strong>
        {t('taskStatus.next.between')}
        <span className={styles.waiting}>{next.waiting}</span>
      </span>
    </span>
  );
}
