import clsx from 'clsx';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
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

/** "27% (visszaáll: 21:40)", or just "n. a." when the usage is unknown. */
function valueWithReset(value: number | null, resetsAt: string | null): string {
  if (value === null) return t('planUsage.unknown');
  const percent = formatPercent(value);
  return resetsAt ? t('planUsage.withReset', { value: percent, time: formatStamp(resetsAt) }) : percent;
}

/**
 * Subscription usage for one provider.
 * - `compact`: top bar mode; a short item with provider name and higher value, opening a dropdown
 *   with full details on click. Renders nothing when all values are unknown ("n. a.").
 * - `full`: shows both plan windows with MiniMeters; used in member profile.
 * - `peak`: one meter with the higher of the two windows.
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
  variant?: 'full' | 'peak' | 'compact';
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [wrapRef, panelRef], []);
  const panelId = useId();
  useDismiss(open, () => setOpen(false), refs, triggerRef);

  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    }
  }, [open]);

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

  if (variant === 'compact') {
    if (peak === null) return null;
    const level = meterLevel(peak, pauseAbove);
    const formattedPercent = formatPercent(peak);
    return (
      <span ref={wrapRef} className={styles.compactWrap}>
        <button
          ref={triggerRef}
          type="button"
          className={clsx(
            styles.compactTrigger,
            open && styles.compactTriggerOpen,
            styles[`trigger_${level}`],
          )}
          aria-expanded={open}
          aria-controls={panelId}
          aria-haspopup="dialog"
          aria-label={t('planUsage.compactLabel', { provider: name, percent: formattedPercent })}
          title={tip}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span className={styles.compactName}>{name}</span>
          <span className={clsx(styles.compactValue, styles[`value_${level}`])}>{formattedPercent}</span>
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
            aria-label={t('planUsage.dropdownTitle', { provider: name })}
            className={styles.dropdownPanel}
          >
            <div className={styles.dropdownHeader}>
              <span className={styles.dropdownTitle}>{t('planUsage.dropdownTitle', { provider: name })}</span>
            </div>
            <div className={styles.dropdownContent}>
              <div className={styles.dropdownSection}>
                <MiniMeter
                  label={t('planUsage.fiveHour')}
                  value={five}
                  pauseAbove={pauseAbove}
                  valueText={resetText(five, usage?.fiveHourResetsAt)}
                />
                {usage?.fiveHourResetsAt ? (
                  <span className={styles.resetText}>
                    {t('planUsage.resets', { time: formatStamp(usage.fiveHourResetsAt) })}
                  </span>
                ) : null}
              </div>
              <div className={styles.dropdownSection}>
                <MiniMeter
                  label={t('planUsage.weekly')}
                  value={week}
                  pauseAbove={pauseAbove}
                  valueText={resetText(week, usage?.weeklyResetsAt)}
                />
                {usage?.weeklyResetsAt ? (
                  <span className={styles.resetText}>
                    {t('planUsage.resets', { time: formatStamp(usage.weeklyResetsAt) })}
                  </span>
                ) : null}
              </div>
              {paused ? (
                <div className={styles.pausedNotice}>
                  <Icon name="alertCircle" size={14} className={styles.pausedIcon} />
                  <span>{t('planUsage.paused', { limit: pauseAbove })}</span>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </span>
    );
  }

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

const PROVIDER_ORDER: AgentProvider[] = ['claude', 'codex', 'nanogpt'];

/**
 * Combined plan usage meter for narrow desktop (1181–1499 px).
 * Displays a single button "AI-keret {percent} ˅" with the peak value across all known
 * providers and windows, opening a shared dropdown panel with direct sections for
 * Claude, Codex, and NanoGPT.
 * Renders nothing if all values are unknown.
 */
export function CombinedPlanUsageMeter({
  usages,
  pauseAbove = 80,
}: {
  usages: ReadonlyArray<{ provider: AgentProvider; usage: PlanUsage | null | undefined }>;
  pauseAbove?: number;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [wrapRef, panelRef], []);
  const panelId = useId();
  useDismiss(open, () => setOpen(false), refs, triggerRef);

  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    }
  }, [open]);

  // Close when screen width crosses breakpoints (e.g. 1500px or 1180px)
  useEffect(() => {
    if (!open) return;
    const m1 = window.matchMedia('(max-width: 1499px)');
    const m2 = window.matchMedia('(max-width: 1180px)');
    const close = () => setOpen(false);
    m1.addEventListener('change', close);
    m2.addEventListener('change', close);
    return () => {
      m1.removeEventListener('change', close);
      m2.removeEventListener('change', close);
    };
  }, [open]);

  const knownProviders = usages.filter(({ usage }) => {
    return usage != null && (usage.fiveHourPercent != null || usage.weeklyPercent != null);
  });

  if (knownProviders.length === 0) return null;

  const allKnownValues = knownProviders.flatMap(({ usage }) =>
    [usage?.fiveHourPercent, usage?.weeklyPercent].filter((v): v is number => v != null),
  );
  const peak = Math.max(...allKnownValues);
  const level = meterLevel(peak, pauseAbove);
  const formattedPercent = formatPercent(peak);

  const resetText = (value: number | null, resetsAt: string | null | undefined) => {
    const percent = value === null ? t('planUsage.unknown') : formatPercent(value);
    return resetsAt ? `${percent}, ${t('planUsage.resets', { time: formatStamp(resetsAt) })}` : percent;
  };

  const sortedProviders = [...knownProviders].sort((a, b) => {
    const ia = PROVIDER_ORDER.indexOf(a.provider);
    const ib = PROVIDER_ORDER.indexOf(b.provider);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  return (
    <span ref={wrapRef} className={styles.compactWrap}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(styles.compactTrigger, open && styles.compactTriggerOpen, styles[`trigger_${level}`])}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label={t('planUsage.combinedTriggerLabel', { percent: formattedPercent })}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={styles.compactName}>{t('planUsage.combinedPrefix')}</span>
        <span className={clsx(styles.compactValue, styles[`value_${level}`])}>{formattedPercent}</span>
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
          aria-label={t('planUsage.combinedTitle')}
          className={styles.combinedPanel}
        >
          <div className={styles.dropdownHeader}>
            <span className={styles.dropdownTitle}>{t('planUsage.combinedTitle')}</span>
          </div>
          <div className={styles.dropdownContent}>
            {sortedProviders.map(({ provider, usage }) => {
              const five = usage?.fiveHourPercent ?? null;
              const week = usage?.weeklyPercent ?? null;
              const paused =
                pausesOnPlanUsage(provider) && ((five ?? 0) >= pauseAbove || (week ?? 0) >= pauseAbove);
              return (
                <div key={provider} className={styles.combinedProviderSection}>
                  <span className={styles.combinedProviderName}>{t(`providers.${provider}`)}</span>
                  <div className={styles.dropdownSection}>
                    <MiniMeter
                      label={t('planUsage.fiveHour')}
                      value={five}
                      pauseAbove={pauseAbove}
                      valueText={resetText(five, usage?.fiveHourResetsAt)}
                    />
                    {usage?.fiveHourResetsAt ? (
                      <span className={styles.resetText}>
                        {t('planUsage.resets', { time: formatStamp(usage.fiveHourResetsAt) })}
                      </span>
                    ) : null}
                  </div>
                  <div className={styles.dropdownSection}>
                    <MiniMeter
                      label={t('planUsage.weekly')}
                      value={week}
                      pauseAbove={pauseAbove}
                      valueText={resetText(week, usage?.weeklyResetsAt)}
                    />
                    {usage?.weeklyResetsAt ? (
                      <span className={styles.resetText}>
                        {t('planUsage.resets', { time: formatStamp(usage.weeklyResetsAt) })}
                      </span>
                    ) : null}
                  </div>
                  {paused ? (
                    <div className={styles.pausedNotice}>
                      <Icon name="alertCircle" size={14} className={styles.pausedIcon} />
                      <span>{t('planUsage.paused', { limit: pauseAbove })}</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </span>
  );
}
