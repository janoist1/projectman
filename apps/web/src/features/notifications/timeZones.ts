import { hu } from '../../i18n/hu';
import { t, tDynamic } from '../../i18n/t';

export interface ZoneOption {
  value: string;
  label: string;
}

/** The IANA zones the select lists; the names are in the locale (`notifications.quiet.cities`). */
const LISTED_ZONES = Object.keys(hu.notifications.quiet.cities);

/** This browser's own time zone, or null when it cannot tell. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** "UTC+2" / "UTC−4" for a zone at `now`; null for a zone this browser does not know. */
export function zoneOffset(zone: string, now: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(now);
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    if (!name.startsWith('GMT')) return null;
    return `UTC${name.slice(3).replace('-', '−')}`;
  } catch {
    return null;
  }
}

function cityOf(zone: string): string {
  const last = zone.split('/').pop() ?? zone;
  return tDynamic(`notifications.quiet.cities.${zone}`, last.replace(/_/g, ' '));
}

/** "Budapest (UTC+2)": the zone's city and its offset right now. */
export function zoneLabel(zone: string, now: Date): string {
  const offset = zoneOffset(zone, now);
  return offset ? t('notifications.quiet.zone', { city: cityOf(zone), offset }) : cityOf(zone);
}

export interface ZoneOptions {
  /** The zone of this device, first in the select; null when it is unknown or already the only one listed. */
  device: ZoneOption | null;
  others: ZoneOption[];
}

/**
 * The select's options: this device's zone on top, then the listed ones. The saved zone is always among
 * them, even when it is not one of the listed (it came from another device).
 */
export function zoneOptions(saved: string, now: Date): ZoneOptions {
  const deviceZone = deviceTimeZone();
  const device = deviceZone ? { value: deviceZone, label: zoneLabel(deviceZone, now) } : null;
  const zones = new Set(LISTED_ZONES);
  if (saved) zones.add(saved);
  if (deviceZone) zones.delete(deviceZone);
  return {
    device,
    others: [...zones].map((zone) => ({ value: zone, label: zoneLabel(zone, now) })),
  };
}
