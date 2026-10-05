import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { machineLevels } from '@projectman/shared';
import { useMachine, useMe } from '../../api/queries';
import { Icon } from '../../components/Icon';
import { MiniMeter } from '../../components/MiniMeter';
import { formatMemory, formatPercent } from '../../i18n/format';
import { t } from '../../i18n/t';
import { useMediaQuery } from '../../lib/hooks';
import { useNow } from '../../lib/useNow';
import { isDelayed, percent } from './machineView';
import { MachinePanel } from './MachinePanel';
import styles from './Machine.module.css';

export function MachineIndicator({ phone = false }: { phone?: boolean }) {
  const me = useMe();
  const isPhone = useMediaQuery('(max-width: 767px)');
  return me.data?.instanceOwner === true && phone === isPhone ? <OwnerIndicator phone={phone} /> : null;
}

export function MachineBadge({ level }: { level: string | null }) {
  return (
    <span className={styles.pill} data-level={level}>
      <Icon name={level === 'high' || level === 'critical' ? 'alertCircle' : 'activity'} size={16} />
    </span>
  );
}

function OwnerIndicator({ phone }: { phone: boolean }) {
  const [open, setOpen] = useState(false);
  const query = useMachine({ panel: open });
  const now = useNow();
  const badge = useMediaQuery('(max-width: 1279px)');
  const tight = useMediaQuery('(max-width: 1499px)');
  const step = phone ? 'phone' : badge ? 'badge' : tight ? 'tight' : 'full';
  const previousStep = useRef(step);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  useEffect(() => {
    if (previousStep.current !== step) {
      setOpen(false);
      previousStep.current = step;
    }
  }, [step]);
  useEffect(() => {
    if (open) void query.refetch({ cancelRefetch: true });
    // Opening must request panel=1 even when the cached sample is fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const data = query.data;
  const valid = data && !query.isError && !isDelayed(data, now);
  const summary = valid ? data.summary : null;
  const levels = summary ? machineLevels(summary) : { cpu: null, memory: null, swap: null, overall: null };
  const memory = summary ? percent(summary.memoryUsedBytes, summary.memoryTotalBytes) : null;
  const swap = summary ? percent(summary.swapUsedBytes, summary.memoryTotalBytes) : null;
  const memoryLevel = !tight
    ? levels.memory
    : levels.memory === 'critical' || levels.swap === 'critical'
      ? 'critical'
      : levels.memory === 'high' || levels.swap === 'high'
        ? 'high'
        : levels.memory;
  const displayPercent = (value: number | null) =>
    value === null ? t('planUsage.unknown') : formatPercent(value);
  const prefix =
    levels.overall === 'high'
      ? t('machine.high')
      : levels.overall === 'critical'
        ? t('machine.critical')
        : '';
  const label =
    `${prefix} ${t('machine.label', { cpu: displayPercent(summary?.cpuPercent ?? null), mem: displayPercent(memory), swap: formatMemory(summary?.swapUsedBytes ?? null), running: summary?.sessionsRunning ?? t('planUsage.unknown'), working: summary?.sessionsWorking ?? t('planUsage.unknown') })}`.trim();
  return (
    <span className={styles.anchor}>
      <button
        ref={button}
        type="button"
        className={badge ? styles.badge : styles.indicator}
        data-level={levels.overall}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {badge ? (
          <MachineBadge level={levels.overall} />
        ) : (
          <>
            <Icon
              name={levels.overall === 'high' || levels.overall === 'critical' ? 'alertCircle' : 'activity'}
              size={18}
            />
            <MiniMeter
              label={t('machine.cpuShort')}
              value={summary?.cpuPercent ?? null}
              level={levels.cpu}
              pauseAbove={0}
              decorative
            />
            <MiniMeter
              label={t('machine.memoryShort')}
              value={memory}
              level={memoryLevel}
              pauseAbove={0}
              decorative
            />
            {!tight && (
              <MiniMeter
                label={t('machine.swap')}
                value={swap}
                displayValue={formatMemory(summary?.swapUsedBytes ?? null)}
                level={levels.swap}
                pauseAbove={0}
                decorative
              />
            )}
            <span className={styles.aiMeter}>
              <MiniMeter
                label={t('machine.aiShort')}
                value={summary ? percent(summary.sessionsWorking, summary.sessionsRunning) : null}
                displayValue={
                  summary ? `${summary.sessionsWorking}/${summary.sessionsRunning}` : t('planUsage.unknown')
                }
                level="ok"
                pauseAbove={0}
                decorative
              />
            </span>
            <span className={styles.chevron}>
              <Icon name="chevronDown" size={12} />
            </span>
          </>
        )}
      </button>
      {open && <MachinePanel id={id} phone={phone} query={query} now={now} onClose={close} anchor={button} />}
    </span>
  );
}
