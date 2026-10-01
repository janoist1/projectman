import { t } from './t';

/** BCP 47 locale for dates and numbers (Intl), matching the UI language. */
export const LOCALE = 'hu-HU';

const timeFormat = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' });
const dateYearFormat = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'short', day: 'numeric' });
const dayHeadingFormat = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', month: 'long', day: 'numeric' });

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Calendar days between `value` and `now` (0 = today, 1 = yesterday). */
export function daysBetween(value: string | Date, now: Date = new Date()): number {
  return Math.round((startOfDay(now) - startOfDay(toDate(value))) / DAY_MS);
}

export function formatTime(value: string | Date): string {
  return timeFormat.format(toDate(value));
}

export function formatDate(value: string | Date, now: Date = new Date()): string {
  const d = toDate(value);
  return d.getFullYear() === now.getFullYear() ? dateFormat.format(d) : dateYearFormat.format(d);
}

/** Timeline stamp: "14:02" today, "tegnap 14:02", otherwise "szept. 28. 14:02". */
export function formatStamp(value: string | Date, now: Date = new Date()): string {
  const days = daysBetween(value, now);
  const time = formatTime(value);
  if (days <= 0) return time;
  if (days === 1) return t('time.yesterdayAt', { time });
  return t('time.dateAt', { date: formatDate(value, now), time });
}

/** Short age for cards: "ma", "tegnap", "3 napja". */
export function formatAge(value: string | Date, now: Date = new Date()): string {
  const days = daysBetween(value, now);
  if (days <= 0) return t('time.today');
  if (days === 1) return t('time.yesterday');
  return t('time.daysAgo', { count: days });
}

/** "most", "5 perce", then the timeline stamp. */
export function formatAgo(value: string | Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - toDate(value).getTime();
  if (diffMs < 60_000) return t('time.justNow');
  if (diffMs < 60 * 60_000) return t('time.minutesAgo', { count: Math.floor(diffMs / 60_000) });
  return formatStamp(value, now);
}

/** Day heading for grouped lists: "Ma", "Tegnap", "szeptember 28., hétfő". */
export function formatDayHeading(value: string | Date, now: Date = new Date()): string {
  const days = daysBetween(value, now);
  if (days <= 0) return t('time.todayHeading');
  if (days === 1) return t('time.yesterdayHeading');
  return dayHeadingFormat.format(toDate(value));
}

const sizeFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

/** File size in decimal units, like the 25 MB limit: "812 B", "4,2 kB", "25 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return t('attachments.size.bytes', { value: sizeFormat.format(bytes) });
  if (bytes < 1_000_000) return t('attachments.size.kilobytes', { value: sizeFormat.format(bytes / 1000) });
  return t('attachments.size.megabytes', { value: sizeFormat.format(bytes / 1_000_000) });
}

const countFormat = new Intl.NumberFormat(LOCALE);

/** A token count with the locale's digit grouping: "12 345". */
export function formatTokens(count: number): string {
  return countFormat.format(count);
}

export function formatPercent(value: number): string {
  return t('planUsage.percent', { value: Math.round(value) });
}
