import clsx from 'clsx';
import type { BoardColumnView } from '@projectman/shared';
import { t } from '../i18n/t';
import styles from './ColumnBar.module.css';

export interface ColumnBarProps {
  segments: { column: BoardColumnView; count: number }[];
  total: number;
  className?: string;
}

/**
 * A horizontal bar that shows progress as colored segments of a whole.
 */
export function ColumnBar({ segments, total, className }: ColumnBarProps) {
  return (
    <span className={clsx(styles.bar, className)} aria-hidden="true">
      {segments.map(({ column, count }) => (
        <span
          key={column.id}
          className={styles.segment}
          data-column-color={column.color}
          style={{ width: `${total === 0 ? 0 : (count / total) * 100}%` }}
          title={t('board.themes.columnCount', { column: column.name, count })}
        />
      ))}
    </span>
  );
}
