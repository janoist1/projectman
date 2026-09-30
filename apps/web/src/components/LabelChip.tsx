import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import type { LabelView } from '@projectman/shared';
import styles from './LabelChip.module.css';

/** A label in its colour, with its meaning on hover; plain tags (no definition) stay neutral. */
export function LabelChip({
  id,
  labels,
  className,
  children,
}: {
  id: string;
  labels: readonly LabelView[];
  className?: string;
  children?: ReactNode;
}) {
  const label = labels.find((entry) => entry.id === id);
  const style = label?.color
    ? ({
        '--label-fg': `var(--column-${label.color}-fg)`,
        '--label-bg': `var(--column-${label.color}-bg)`,
      } as CSSProperties)
    : undefined;
  return (
    <span
      className={clsx(styles.chip, !label && styles.plain, className)}
      style={style}
      title={label?.meaning ?? undefined}
      data-label={id}
    >
      <span className={styles.name}>{label?.name ?? id}</span>
      {children}
    </span>
  );
}
