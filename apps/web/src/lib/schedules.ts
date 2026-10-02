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

export type ScheduleFrequency = 'weekdays' | 'daily' | 'custom';

export interface PlainCron {
  frequency: 'weekdays' | 'daily';
  hour: number;
  minute: number;
}

/** A cron that is a plain daily or weekday time ("0 8 * * 1-5"); null for anything else. */
export function parsePlainCron(cron: string): PlainCron | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron.trim());
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  return { frequency: match[3] === '*' ? 'daily' : 'weekdays', hour, minute };
}

/** The cron of a weekday or daily time given as "HH:MM"; null when the time is not valid. */
export function plainCron(frequency: 'weekdays' | 'daily', time: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${minute} ${hour} * * ${frequency === 'daily' ? '*' : '1-5'}`;
}

/** The "HH:MM" of a plain cron's time, as a time field takes it. */
export function cronTime({ hour, minute }: PlainCron): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * A cron expression in words when it is a plain daily or weekday time ("0 8 * * 1-5" becomes
 * "hétköznap reggel 8"); anything else comes back as written.
 */
export function describeCron(cron: string): string {
  const plain = parsePlainCron(cron);
  if (!plain) return cron;
  return t(plain.frequency === 'daily' ? 'schedules.when.daily' : 'schedules.when.weekdays', {
    time: timeOfDay(plain.hour, plain.minute),
  });
}

export function scheduleReason(reason: string): string {
  return tDynamic(`schedules.reasons.${reason}`, reason);
}
