import clsx from 'clsx';
import { formatPercent } from '../i18n/format';
import { t } from '../i18n/t';
import styles from './MiniMeter.module.css';

export type MeterLevel = 'ok' | 'high' | 'critical';

/** The level of a percentage: critical from 95, high from the pause limit, otherwise ok. */
export function meterLevel(value: number | null, pauseAbove: number): MeterLevel {
  if (value === null) return 'ok';
  if (value >= 95) return 'critical';
  if (value >= pauseAbove) return 'high';
  return 'ok';
}

/**
 * A label and a value on one line with a thin bar under them. Used by the plan usage in the top bar
 * and by the machine meter. The bar is a `role="meter"` unless the whole meter is `decorative`
 * (its button already says the same), and `bar={false}` leaves it out.
 */
export function MiniMeter({
  label,
  value,
  pauseAbove,
  ariaLabel = label,
  valueText,
  decorative = false,
  bar = true,
  level: explicitLevel,
  displayValue,
}: {
  label: string;
  /** Percent 0–100, or null when unknown. */
  value: number | null;
  pauseAbove: number;
  /** The accessible name of the bar; the label by default. */
  ariaLabel?: string;
  /** What a screen reader says for the bar; the shown value by default. */
  valueText?: string;
  decorative?: boolean;
  bar?: boolean;
  /** Shared machine rules can supply their own level and non-percent display. */
  level?: MeterLevel | null;
  displayValue?: string;
}) {
  const display = displayValue ?? (value === null ? t('planUsage.unknown') : formatPercent(value));
  const level = explicitLevel === undefined ? meterLevel(value, pauseAbove) : explicitLevel;
  return (
    <span
      className={clsx(styles.meter, value === null && styles.unknown)}
      aria-hidden={decorative || undefined}
    >
      <span className={styles.row}>
        <span className={styles.label}>{label}</span>
        <span className={clsx(styles.value, styles[`value_${level}`])}>{display}</span>
      </span>
      {bar ? (
        <span
          className={styles.track}
          role={decorative ? undefined : 'meter'}
          aria-label={decorative ? undefined : ariaLabel}
          aria-valuemin={decorative ? undefined : 0}
          aria-valuemax={decorative ? undefined : 100}
          aria-valuenow={decorative ? undefined : (value ?? undefined)}
          aria-valuetext={decorative ? undefined : (valueText ?? display)}
        >
          <span
            className={clsx(styles.fill, styles[`fill_${level}`])}
            style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }}
          />
        </span>
      ) : null}
    </span>
  );
}
