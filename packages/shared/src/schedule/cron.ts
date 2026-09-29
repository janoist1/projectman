/** Numeric five-field cron. Restricted day-of-month and weekday fields use OR. */
export function parseCron(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron must have five fields');
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  const values = fields.map((field, index) => {
    const [min, max] = bounds[index]!;
    const result = new Set<number>();
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) throw new Error('Invalid cron field');
      const base = match[1]!;
      const step = Number(match[2] ?? 1);
      const range = base.split('-').map(Number);
      const start = base === '*' ? min : range[0]!;
      const end = base === '*' ? max : (range[1] ?? (match[2] ? max : start));
      if (!Number.isSafeInteger(step) || step < 1 || start < min || end > max || start > end)
        throw new Error('Cron field out of range');
      for (let value = start; value <= end; value += step) result.add(index === 4 && value === 7 ? 0 : value);
    }
    return result;
  });
  return { values, dayWildcard: fields[2]!.startsWith('*'), weekWildcard: fields[4]!.startsWith('*') };
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });
}

function matches(
  cron: ReturnType<typeof parseCron>,
  date: Date,
  format: Intl.DateTimeFormat,
  ignoreMinute = false,
) {
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  const [minute, hour, day, month, week] = cron.values;
  const dom = day!.has(Number(parts.day));
  const dow = week!.has(weekday);
  const dayMatches = cron.dayWildcard || cron.weekWildcard ? dom && dow : dom || dow;
  return (
    (ignoreMinute || minute!.has(Number(parts.minute))) &&
    hour!.has(Number(parts.hour)) &&
    month!.has(Number(parts.month)) &&
    dayMatches
  );
}

export function cronMatches(expression: string, date: Date, timeZone: string): boolean {
  return matches(parseCron(expression), date, formatter(timeZone));
}

/** Strictly after `after`; UTC instants distinguish both occurrences of a DST fold. */
export function nextCronRun(expression: string, after: Date, timeZone: string): string | null {
  const cron = parseCron(expression);
  const format = formatter(timeZone);
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const end = start + 8 * 366 * 24 * 60 * 60_000;
  // Inspect an hour's local minute offset once, then only try allowed minutes. This also
  // supports zones whose UTC offset is not a whole hour.
  for (let hour = Math.floor(start / 3_600_000) * 3_600_000; hour < end; hour += 3_600_000) {
    if (
      !matches(cron, new Date(hour), format, true) &&
      !matches(cron, new Date(hour + 59 * 60_000), format, true)
    )
      continue;
    const parts = Object.fromEntries(format.formatToParts(new Date(hour)).map((p) => [p.type, p.value]));
    const offset = Number(parts.minute);
    const candidates = [...cron.values[0]!].map((m) => (m - offset + 60) % 60).sort((a, b) => a - b);
    for (const minute of candidates) {
      const at = hour + minute * 60_000;
      if (at >= start && matches(cron, new Date(at), format)) return new Date(at).toISOString();
    }
  }
  return null;
}
