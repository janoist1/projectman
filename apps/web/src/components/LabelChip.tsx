import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import type { LabelView } from '@projectman/shared';
import { labelName } from '../lib/labels';
import styles from './LabelChip.module.css';

/** "+3": the process labels folded on a done card; a neutral chip of the labels' size, named for screen readers. */
export function LabelCountChip({ count, text }: { count: number; text: string }) {
  return (
    <span className={clsx(styles.chip, styles.plain)} title={text}>
      <span aria-hidden="true">+{count}</span>
      <span className="visually-hidden">{text}</span>
    </span>
  );
}

/** A label in its colour, with its meaning on hover; plain tags (no definition) stay neutral. */
export function LabelChip({
  id,
  labels,
  className,
  wrap = false,
  children,
}: {
  id: string;
  labels: readonly LabelView[];
  className?: string;
  /** Let a long name break onto more lines instead of being cut with an ellipsis. */
  wrap?: boolean;
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
      className={clsx(styles.chip, !label && styles.plain, wrap && styles.wrap, className)}
      style={style}
      title={label?.meaning ?? undefined}
      data-label={id}
    >
      <span className={styles.name}>{labelName(id, labels)}</span>
      {children}
    </span>
  );
}
