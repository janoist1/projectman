import { currentLanguage } from '../../i18n/language';
import { t, tDynamic } from '../../i18n/t';

export interface ZoneOption {
  value: string;
  label: string;
}

/** Every IANA zone this browser knows, plus UTC (some engines leave it out of the list). */
function knownZones(): string[] {
  try {
    return ['UTC', ...Intl.supportedValuesOf('timeZone')];
  } catch {
    return ['UTC'];
  }
}

/** This browser's own time zone, or null when it cannot tell. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The zone's offset from UTC at `now` in minutes (+120, −240, +345); null for a zone this browser does not know. */
export function offsetMinutes(zone: string, now: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(now);
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    if (!name.startsWith('GMT')) return null;
    const match = /^GMT(?:([+\-−])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
    if (!match) return null;
    if (!match[1]) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return match[1] === '+' ? minutes : -minutes;
  } catch {
    return null;
  }
}

/** "UTC+2" / "UTC−4" / "UTC+5:30" for a zone at `now`; null for a zone this browser does not know. */
export function zoneOffset(zone: string, now: Date): string | null {
  const minutes = offsetMinutes(zone, now);
  if (minutes === null) return null;
  if (minutes === 0) return 'UTC';
  const abs = Math.abs(minutes);
  const clock = abs % 60 ? `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}` : String(abs / 60);
  return `UTC${minutes < 0 ? '−' : '+'}${clock}`;
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
  /** The zone of this device, first in the select; null when it is unknown. */
  device: ZoneOption | null;
  /** Every other zone, from the west to the east by its offset right now, then by name. */
  others: ZoneOption[];
}

/**
 * The select's options: this device's zone on top, then every zone, sorted by UTC offset. The saved zone
 * is always among them, even when this browser does not list it (it came from another device).
 */
export function zoneOptions(saved: string, now: Date): ZoneOptions {
  const deviceZone = deviceTimeZone();
  const device = deviceZone ? { value: deviceZone, label: zoneLabel(deviceZone, now) } : null;
  const zones = new Set(knownZones());
  if (saved) zones.add(saved);
  if (deviceZone) zones.delete(deviceZone);
  const others = [...zones]
    .map((zone) => ({ value: zone, label: zoneLabel(zone, now), offset: offsetMinutes(zone, now) ?? 0 }))
    .sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label, currentLanguage()))
    .map(({ value, label }) => ({ value, label }));
  return { device, others };
}
