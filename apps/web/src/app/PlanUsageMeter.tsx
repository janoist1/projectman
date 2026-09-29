import clsx from 'clsx';
import type { PlanUsage } from '@projectman/shared';
import { formatPercent, formatStamp } from '../i18n/format';
import { t } from '../i18n/t';
import styles from './PlanUsageMeter.module.css';

function level(value: number | null, pauseAbove: number): 'ok' | 'high' | 'critical' {
  if (value === null) return 'ok';
  if (value >= 95) return 'critical';
  if (value >= pauseAbove) return 'high';
  return 'ok';
}

function Bar({
  label,
  value,
  pauseAbove,
  resetsAt,
}: {
  label: string;
  value: number | null;
  pauseAbove: number;
  resetsAt: string | null;
}) {
  const display = value === null ? t('planUsage.unknown') : formatPercent(value);
  return (
    <span className={styles.meter}>
      <span className={styles.row}>
        <span>{label}</span>
        <span className={styles.value}>{display}</span>
      </span>
      <span
        className={styles.track}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? undefined}
        aria-valuetext={
          resetsAt ? `${display}, ${t('planUsage.resets', { time: formatStamp(resetsAt) })}` : display
        }
      >
        <span
          className={clsx(styles.fill, styles[level(value, pauseAbove)])}
          style={{ width: `${Math.min(100, value ?? 0)}%` }}
        />
      </span>
    </span>
  );
}

/** "Keret" meter: the Claude subscription's 5-hour and weekly usage. */
export function PlanUsageMeter({
  usage,
  pauseAbove = 80,
  compact = false,
}: {
  usage: PlanUsage | null | undefined;
  pauseAbove?: number;
  compact?: boolean;
}) {
  if (!usage) {
    return (
      <span className={clsx(styles.box, compact && styles.compact)} title={t('planUsage.unavailable')}>
        <span className={styles.label}>{t('planUsage.label')}</span>
        <span className={styles.unknown}>{t('planUsage.unknown')}</span>
      </span>
    );
  }
  const five = usage.fiveHourPercent;
  const week = usage.weeklyPercent;
  const paused = (five ?? 0) >= pauseAbove || (week ?? 0) >= pauseAbove;
  const title = [
    t('planUsage.title', {
      fiveHour: five === null ? t('planUsage.unknown') : formatPercent(five),
      weekly: week === null ? t('planUsage.unknown') : formatPercent(week),
    }),
    paused ? t('planUsage.paused', { limit: pauseAbove }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={clsx(styles.box, compact && styles.compact, paused && styles.paused)} title={title}>
      <span className={styles.label}>{t('planUsage.label')}</span>
      <Bar
        label={t('planUsage.fiveHour')}
        value={five}
        pauseAbove={pauseAbove}
        resetsAt={usage.fiveHourResetsAt}
      />
      <Bar
        label={t('planUsage.weekly')}
        value={week}
        pauseAbove={pauseAbove}
        resetsAt={usage.weeklyResetsAt}
      />
    </span>
  );
}
