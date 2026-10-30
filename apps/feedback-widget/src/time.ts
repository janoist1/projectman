import { currentLanguage, t } from './i18n';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const startOfDay = (ms: number): number => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const clock = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/** "2 órája", "tegnap", "3 napja", "múlt héten": how long ago, coarsely. */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const age = Math.max(0, now - then);
  if (age < MINUTE) return t('time.now');
  if (age < HOUR) return t('time.minutes', { n: Math.floor(age / MINUTE) });
  const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY);
  if (days === 0) return t('time.hours', { n: Math.floor(age / HOUR) });
  if (days === 1) return t('time.yesterday');
  if (days < 7) return t('time.days', { n: days });
  if (days < 14) return t('time.lastWeek');
  if (days < 60) return t('time.weeks', { n: Math.floor(days / 7) });
  return t('time.months', { n: Math.floor(days / 30) });
}

/** "ma 9:10", "tegnap 14:02", or the date and time. */
export function messageTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY);
  if (days === 0) return t('time.todayAt', { time: clock(then) });
  if (days === 1) return t('time.yesterdayAt', { time: clock(then) });
  const date = new Date(then);
  const label =
    currentLanguage() === 'en'
      ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(date)
      : `${date.getMonth() + 1}. ${date.getDate()}.`;
  return t('time.dateAt', { date: label, time: clock(then) });
}
