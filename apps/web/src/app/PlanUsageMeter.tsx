import clsx from 'clsx';
import { Link } from 'react-router';
import type { AgentProvider, PlanUsage } from '@projectman/shared';
import { pausesOnPlanUsage } from '@projectman/shared';
import { MiniMeter, meterLevel } from '../components/MiniMeter';
import { Tooltip } from '../components/Tooltip';
import { formatPercent, formatStamp } from '../i18n/format';
import { t } from '../i18n/t';
import styles from './PlanUsageMeter.module.css';

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
      className={clsx(styles.badge, styles[`badge_${meterLevel(peak, pauseAbove)}`])}
      aria-label={t('planUsage.badgeLabel', { percent })}
    >
      <span className={styles.badgeValue} aria-hidden="true">
        {percent}
      </span>
    </Link>
  );
}

/** "27% (visszaáll: 21:40)", or just "n. a." when the usage is unknown. */
function valueWithReset(value: number | null, resetsAt: string | null): string {
  if (value === null) return t('planUsage.unknown');
  const percent = formatPercent(value);
  return resetsAt ? t('planUsage.withReset', { value: percent, time: formatStamp(resetsAt) }) : percent;
}

/**
 * Subscription usage for one provider. `full` shows both plan windows; `peak` one meter with the
 * higher of the two. Either way the tooltip (hover, focus) has both windows and when they reset.
 */
export function PlanUsageMeter({
  usage,
  provider = 'claude',
  pauseAbove = 80,
  variant = 'full',
}: {
  usage: PlanUsage | null | undefined;
  provider?: AgentProvider;
  pauseAbove?: number;
  variant?: 'full' | 'peak';
}) {
  const name = t(`providers.${provider}`);
  const five = usage?.fiveHourPercent ?? null;
  const week = usage?.weeklyPercent ?? null;
  const paused = pausesOnPlanUsage(provider) && ((five ?? 0) >= pauseAbove || (week ?? 0) >= pauseAbove);
  const tip = [
    t('planUsage.title', {
      provider: name,
      fiveHour: valueWithReset(five, usage?.fiveHourResetsAt ?? null),
      weekly: valueWithReset(week, usage?.weeklyResetsAt ?? null),
    }),
    paused ? t('planUsage.paused', { limit: pauseAbove }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const known = [five, week].filter((value): value is number => value !== null);
  const peak = known.length > 0 ? Math.max(...known) : null;
  const resetText = (value: number | null, resetsAt: string | null | undefined) => {
    const percent = value === null ? t('planUsage.unknown') : formatPercent(value);
    return resetsAt ? `${percent}, ${t('planUsage.resets', { time: formatStamp(resetsAt) })}` : percent;
  };
  return (
    <Tooltip label={name} content={tip} className={styles.provider}>
      {variant === 'full' ? (
        <>
          <span className={styles.name}>{name}</span>
          <MiniMeter
            label={t('planUsage.fiveHour')}
            value={five}
            pauseAbove={pauseAbove}
            valueText={resetText(five, usage?.fiveHourResetsAt)}
          />
          <MiniMeter
            label={t('planUsage.weekly')}
            value={week}
            pauseAbove={pauseAbove}
            valueText={resetText(week, usage?.weeklyResetsAt)}
          />
        </>
      ) : (
        <MiniMeter
          label={name}
          value={peak}
          pauseAbove={pauseAbove}
          valueText={`${peak === null ? t('planUsage.unknown') : formatPercent(peak)} · ${tip}`}
        />
      )}
    </Tooltip>
  );
}
