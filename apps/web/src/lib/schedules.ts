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
export function scheduleReason(reason: string): string {
  return tDynamic(`schedules.reasons.${reason}`, reason);
}
