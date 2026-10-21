import clsx from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import { quietWindowAt } from '@projectman/shared';
import type { PushSettings, QuietHours } from '@projectman/shared';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { useNow } from '../../lib/useNow';
import { failText } from './deviceText';
import styles from './notifications.module.css';
import { deviceTimeZone, zoneOptions } from './timeZones';
import { useSavePushSettings } from './usePush';

/** "Now is quiet until 07:00" or "Next quiet hour starts at 22:00"; null when the zone is not one this browser knows. */
function nowLine(quiet: QuietHours, now: number): { quiet: boolean; text: string } | null {
  try {
    const window = quietWindowAt(quiet, new Date(now));
    return window.quiet
      ? { quiet: true, text: t('notifications.quiet.nowQuiet', { end: quiet.end }) }
      : { quiet: false, text: t('notifications.quiet.nowNotQuiet', { start: quiet.start }) };
  } catch {
    return null;
  }
}

/** The quiet hours: a switch, the two times, the time zone and a live line saying whether it is quiet now (PM-815). */
export function QuietHoursCard({ settings }: { settings: PushSettings }) {
  const toast = useToast();
  const save = useSavePushSettings();
  const quiet = settings.quietHours;
  const [start, setStart] = useState(quiet.start);
  const [end, setEnd] = useState(quiet.end);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);
  const errorId = useId();
  const now = useNow(quiet.enabled, 30_000);

  // The server's values win again after a refetch or a rollback.
  useEffect(() => {
    setStart(quiet.start);
    setEnd(quiet.end);
  }, [quiet.start, quiet.end]);
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  function commit(next: QuietHours) {
    save.mutate(
      { ...settings, quietHours: next },
      {
        onSuccess: () => {
          setSaved(true);
          window.clearTimeout(savedTimer.current);
          savedTimer.current = window.setTimeout(() => setSaved(false), 1400);
        },
        onError: (error) => {
          setStart(quiet.start);
          setEnd(quiet.end);
          toast.show(failText(error, t('notifications.quiet.saveFailed')), 'error');
        },
      },
    );
  }

  function toggle(enabled: boolean) {
    // The first time it goes on, the zone is the one of the device in the person's hand, not the server default.
    const timeZone =
      enabled && quiet.timeZone === 'UTC' ? (deviceTimeZone() ?? quiet.timeZone) : quiet.timeZone;
    commit({ ...quiet, enabled, timeZone });
  }

  function changeTime(field: 'start' | 'end', value: string) {
    if (!value) return;
    const nextStart = field === 'start' ? value : start;
    const nextEnd = field === 'end' ? value : end;
    if (field === 'start') setStart(value);
    else setEnd(value);
    if (nextStart !== nextEnd) commit({ ...quiet, start: nextStart, end: nextEnd });
  }

  const same = start === end;
  const overnight = !same && end < start;
  const zones = zoneOptions(quiet.timeZone, new Date(now));
  const line = quiet.enabled && !same ? nowLine(quiet, now) : null;
  const invalid = same ? { 'aria-invalid': true, 'aria-describedby': errorId } : {};

  return (
    <div className={styles.card}>
      <div className={styles.quietHead}>
        <label className={styles.rowLabel} htmlFor="push-quiet-on">
          <span className={styles.rowTitle}>{t('notifications.quiet.switchLabel')}</span>
          <span className={styles.rowHint}>{t('notifications.quiet.switchHint')}</span>
        </label>
        <input
          id="push-quiet-on"
          type="checkbox"
          role="switch"
          className={styles.switch}
          checked={quiet.enabled}
          onChange={(event) => toggle(event.target.checked)}
        />
      </div>
      {quiet.enabled ? (
        <>
          <div className={styles.quietGrid}>
            <div className={styles.field}>
              <label htmlFor="push-quiet-start">{t('notifications.quiet.start')}</label>
              <input
                id="push-quiet-start"
                type="time"
                value={start}
                onChange={(event) => changeTime('start', event.target.value)}
                {...invalid}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="push-quiet-end">
                {overnight ? t('notifications.quiet.endNextDay') : t('notifications.quiet.end')}
              </label>
              <input
                id="push-quiet-end"
                type="time"
                value={end}
                onChange={(event) => changeTime('end', event.target.value)}
                {...invalid}
              />
            </div>
            <div className={clsx(styles.field, styles.zone)}>
              <label htmlFor="push-quiet-zone">{t('notifications.quiet.timeZone')}</label>
              <select
                id="push-quiet-zone"
                value={quiet.timeZone}
                onChange={(event) => commit({ ...quiet, timeZone: event.target.value })}
              >
                {zones.device ? (
                  <optgroup label={t('notifications.quiet.thisDeviceZone')}>
                    <option value={zones.device.value}>{zones.device.label}</option>
                  </optgroup>
                ) : null}
                <optgroup label={t('notifications.quiet.allZones')}>
                  {zones.others.map((zone) => (
                    <option key={zone.value} value={zone.value}>
                      {zone.label}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
          </div>
          {same ? (
            <p id={errorId} className={styles.fieldError} role="alert">
              {t('notifications.quiet.sameTime')}
            </p>
          ) : null}
          {line ? (
            <p className={clsx(styles.quietNow, line.quiet && styles.quietNowOn)}>{line.text}</p>
          ) : null}
        </>
      ) : null}
      <span className={styles.saved} role="status">
        {saved ? t('notifications.quiet.saved') : ''}
      </span>
    </div>
  );
}
