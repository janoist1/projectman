import clsx from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import styles from './Chip.module.css';

export type ChipTone = 'neutral' | 'outline' | 'accent' | 'needs' | 'ok' | 'blocked' | 'kind' | 'phase' | 'status' | 'dark';

interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  size?: 'sm' | 'md';
  icon?: IconName;
  mono?: boolean;
  children: ReactNode;
}

/** Small label: stage, PR, labels, kinds. `tone="kind"`/"phase"/"status" read the data-* colours. */
export function Chip({ tone = 'neutral', size = 'sm', icon, mono, className, children, ...rest }: ChipProps) {
  return (
    <span className={clsx(styles.chip, styles[tone], styles[size], mono && styles.mono, className)} {...rest}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 13 : 14} strokeWidth={2.1} /> : null}
      <span className={styles.text}>{children}</span>
    </span>
  );
}

interface DotProps {
  /** Colour comes from the closest data-phase / data-status ancestor or these props. */
  phase?: string;
  status?: string;
  pulse?: boolean;
  size?: number;
  className?: string;
}

/** Status dot; pulses while working. Always paired with a text label. */
export function StatusDot({ phase, status, pulse, size = 8, className }: DotProps) {
  return (
    <span
      className={clsx(styles.dot, status ? styles.dotStatus : phase ? styles.dotPhase : null, pulse && 'pulse', className)}
      data-phase={phase}
      data-status={status}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
