import { t, tDynamic } from '../i18n/t';

export function formatScheduleTime(at: string | null, timezone: string): string {
  if (!at) return t('schedules.noNext');
  return (
    new Intl.DateTimeFormat('hu-HU', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(at)) + ` (${timezone})`
  );
}

/** The time of day of a cron's hour and minute: "reggel 8" in the early morning, else "14:30". */
function timeOfDay(hour: number, minute: number): string {
  if (minute === 0 && hour >= 4 && hour <= 9) return t('schedules.when.morning', { hour });
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

/**
 * A cron expression in words when it is a plain daily or weekday time ("0 8 * * 1-5" becomes
 * "hétköznap reggel 8"); anything else comes back as written.
 */
export function describeCron(cron: string): string {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron.trim());
  if (!match) return cron;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return cron;
  return t(match[3] === '*' ? 'schedules.when.daily' : 'schedules.when.weekdays', {
    time: timeOfDay(hour, minute),
  });
}

export function scheduleReason(reason: string): string {
  return tDynamic(`schedules.reasons.${reason}`, reason);
}
