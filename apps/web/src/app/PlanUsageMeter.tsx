import clsx from 'clsx';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { AgentProvider, PlanUsage } from '@projectman/shared';
import { pausesOnPlanUsage } from '@projectman/shared';
import { Icon } from '../components/Icon';
import { MiniMeter, meterLevel } from '../components/MiniMeter';
import { Tooltip } from '../components/Tooltip';
import { formatPercent, formatStamp } from '../i18n/format';
import { t } from '../i18n/t';
import { useDismiss } from '../lib/hooks';
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

/** Include the reset in the tooltip only when the usage is known. */
function valueWithReset(value: number | null, resetsAt: string | null): string {
  if (value === null) return t('planUsage.unknown');
  const percent = formatPercent(value);
  return resetsAt ? t('planUsage.withReset', { value: percent, time: formatStamp(resetsAt) }) : percent;
}

function resetText(value: number | null, resetsAt: string | null | undefined): string {
  const percent = value === null ? t('planUsage.unknown') : formatPercent(value);
  return resetsAt ? `${percent}, ${t('planUsage.resets', { time: formatStamp(resetsAt) })}` : percent;
}

function isPaused(provider: AgentProvider, usage: PlanUsage | null | undefined, pauseAbove: number) {
  return (
    pausesOnPlanUsage(provider) &&
    ((usage?.fiveHourPercent ?? 0) >= pauseAbove || (usage?.weeklyPercent ?? 0) >= pauseAbove)
  );
}

/** The same window details appear in the individual and combined dropdowns. */
function ProviderUsageDetails({
  provider,
  usage,
  pauseAbove,
}: {
  provider: AgentProvider;
  usage: PlanUsage | null | undefined;
  pauseAbove: number;
}) {
  return (
    <>
      {[
        {
          label: t('planUsage.fiveHour'),
          value: usage?.fiveHourPercent ?? null,
          resetsAt: usage?.fiveHourResetsAt,
        },
        {
          label: t('planUsage.weekly'),
          value: usage?.weeklyPercent ?? null,
          resetsAt: usage?.weeklyResetsAt,
        },
      ].map(({ label, value, resetsAt }) => (
        <div key={label} className={styles.dropdownSection}>
          <MiniMeter
            label={label}
            value={value}
            pauseAbove={pauseAbove}
            valueText={resetText(value, resetsAt)}
          />
          {resetsAt ? (
            <span className={styles.resetText}>{t('planUsage.resets', { time: formatStamp(resetsAt) })}</span>
          ) : null}
        </div>
      ))}
      {isPaused(provider, usage, pauseAbove) ? (
        <div className={styles.pausedNotice}>
          <Icon name="alertCircle" size={14} className={styles.pausedIcon} />
          <span>{t('planUsage.paused', { limit: pauseAbove })}</span>
        </div>
      ) : null}
    </>
  );
}

/** Shared trigger, dismissal and focus handling for both desktop presentations. */
function UsageDropdown({
  name,
  peak,
  pauseAbove,
  label,
  title,
  combined = false,
  children,
}: {
  name: string;
  peak: number;
  pauseAbove: number;
  label: string;
  title: string;
  combined?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [wrapRef, panelRef], []);
  const panelId = useId();
  useDismiss(open, () => setOpen(false), refs, triggerRef);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    // Shell unmounts this presentation at 1500px; CSS hides the meters at 1180px.
    const media = window.matchMedia('(max-width: 1180px)');
    const close = () => setOpen(false);
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, [open]);

  const level = meterLevel(peak, pauseAbove);
  return (
    <span ref={wrapRef} className={styles.compactWrap}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(styles.compactTrigger, open && styles.compactTriggerOpen, styles[`trigger_${level}`])}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label={label}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={styles.compactName}>{name}</span>
        <span className={clsx(styles.compactValue, styles[`value_${level}`])}>{formatPercent(peak)}</span>
        <span className={clsx(styles.compactChevron, open && styles.compactChevronOpen)} aria-hidden="true">
          <Icon name="chevronDown" size={12} strokeWidth={2.2} />
        </span>
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          tabIndex={-1}
          aria-label={title}
          className={combined ? styles.combinedPanel : styles.dropdownPanel}
        >
          <div className={styles.dropdownHeader}>
            <span className={styles.dropdownTitle}>{title}</span>
          </div>
          <div className={styles.dropdownContent}>{children}</div>
        </div>
      )}
    </span>
  );
}

/** Subscription usage: compact desktop trigger or full member-profile meters. */
export function PlanUsageMeter({
  usage,
  provider = 'claude',
  pauseAbove = 80,
  variant = 'full',
}: {
  usage: PlanUsage | null | undefined;
  provider?: AgentProvider;
  pauseAbove?: number;
  variant?: 'full' | 'compact';
}) {
  const name = t(`providers.${provider}`);
  const five = usage?.fiveHourPercent ?? null;
  const week = usage?.weeklyPercent ?? null;
  if (variant === 'compact') {
    const known = [five, week].filter((value): value is number => value !== null);
    if (known.length === 0) return null;
    const peak = Math.max(...known);
    return (
      <UsageDropdown
        name={name}
        peak={peak}
        pauseAbove={pauseAbove}
        label={t('planUsage.compactLabel', { provider: name, percent: formatPercent(peak) })}
        title={t('planUsage.dropdownTitle', { provider: name })}
      >
        <ProviderUsageDetails provider={provider} usage={usage} pauseAbove={pauseAbove} />
      </UsageDropdown>
    );
  }

  const tip = [
    t('planUsage.title', {
      provider: name,
      fiveHour: valueWithReset(five, usage?.fiveHourResetsAt ?? null),
      weekly: valueWithReset(week, usage?.weeklyResetsAt ?? null),
    }),
    isPaused(provider, usage, pauseAbove) ? t('planUsage.paused', { limit: pauseAbove }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Tooltip label={name} content={tip} className={styles.provider}>
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
    </Tooltip>
  );
}

/** Narrow desktop (1181–1499 px): one peak trigger, with providers in their original order. */
export function CombinedPlanUsageMeter({
  usages,
  pauseAbove = 80,
}: {
  usages: ReadonlyArray<{ provider: AgentProvider; usage: PlanUsage | null | undefined }>;
  pauseAbove?: number;
}) {
  const knownProviders = usages.filter(
    ({ usage }) => usage != null && (usage.fiveHourPercent != null || usage.weeklyPercent != null),
  );
  if (knownProviders.length === 0) return null;
  const peak = Math.max(
    ...knownProviders.flatMap(({ usage }) =>
      [usage?.fiveHourPercent, usage?.weeklyPercent].filter((value): value is number => value != null),
    ),
  );
  return (
    <UsageDropdown
      name={t('planUsage.combinedPrefix')}
      peak={peak}
      pauseAbove={pauseAbove}
      label={t('planUsage.combinedTriggerLabel', { percent: formatPercent(peak) })}
      title={t('planUsage.combinedTitle')}
      combined
    >
      {knownProviders.map(({ provider, usage }) => (
        <div key={provider} className={styles.combinedProviderSection}>
          <span className={styles.combinedProviderName}>{t(`providers.${provider}`)}</span>
          <ProviderUsageDetails provider={provider} usage={usage} pauseAbove={pauseAbove} />
        </div>
      ))}
    </UsageDropdown>
  );
}
