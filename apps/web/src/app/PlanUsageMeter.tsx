import clsx from 'clsx';
import { Link } from 'react-router';
import type { AgentProvider, PlanUsage } from '@projectman/shared';
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

/**
 * Phone header: one small figure, the highest plan usage across providers and both windows,
 * coloured like the bars; it opens the Team page, where each member's profile has the meter.
 */
export function PlanUsageBadge({
  usages,
  pauseAbove = 80,
  to,
}: {
  usages: ReadonlyArray<PlanUsage | null | undefined>;
  pauseAbove?: number;
  to: string;
}) {
  const known = usages.flatMap((usage) =>
    [usage?.fiveHourPercent, usage?.weeklyPercent].filter((value): value is number => value != null),
  );
  if (known.length === 0) return null;
  const peak = Math.max(...known);
  const percent = formatPercent(peak);
  return (
    <Link
      to={to}
      className={clsx(styles.badge, styles[`badge_${level(peak, pauseAbove)}`])}
      aria-label={t('planUsage.badgeLabel', { percent })}
    >
      <span className={styles.badgeValue} aria-hidden="true">
        {percent}
      </span>
    </Link>
  );
}

/** Subscription usage for one provider, with both plan windows. */
export function PlanUsageMeter({
  usage,
  provider = 'claude',
  pauseAbove = 80,
  compact = false,
}: {
  usage: PlanUsage | null | undefined;
  provider?: AgentProvider;
  pauseAbove?: number;
  compact?: boolean;
}) {
  const five = usage?.fiveHourPercent ?? null;
  const week = usage?.weeklyPercent ?? null;
  const paused = (five ?? 0) >= pauseAbove || (week ?? 0) >= pauseAbove;
  const title = [
    t('planUsage.title', {
      provider: t(`providers.${provider}`),
      fiveHour: five === null ? t('planUsage.unknown') : formatPercent(five),
      weekly: week === null ? t('planUsage.unknown') : formatPercent(week),
    }),
    paused ? t('planUsage.paused', { limit: pauseAbove }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={clsx(styles.box, compact && styles.compact, paused && styles.paused)} title={title}>
      <span className={styles.label}>
        {t('planUsage.providerLabel', { provider: t(`providers.${provider}`) })}
      </span>
      <Bar
        label={t('planUsage.fiveHour')}
        value={five}
        pauseAbove={pauseAbove}
        resetsAt={usage?.fiveHourResetsAt ?? null}
      />
      <Bar
        label={t('planUsage.weekly')}
        value={week}
        pauseAbove={pauseAbove}
        resetsAt={usage?.weeklyResetsAt ?? null}
      />
    </span>
  );
}
