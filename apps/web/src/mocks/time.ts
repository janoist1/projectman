/** Fixture timestamps relative to when the fixtures load, so relative times ("3 napja") stay stable. */
const START = Date.now();

export function minutesAgo(minutes: number): string {
  return new Date(START - minutes * 60_000).toISOString();
}

export function daysAgo(days: number, hour: number, minute = 0): string {
  const date = new Date(START);
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

export function hoursFromNow(hours: number): string {
  return new Date(START + hours * 3_600_000).toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

let counter = 0;

export function mockId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Deterministic UUID-shaped ids for Claude session ids. */
export function mockUuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0').slice(-12);
  return `5e55a000-0000-4000-8000-${hex}`;
}
