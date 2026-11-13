export const time = {
  justNow: 'most',
  todayAt: 'ma {time}',
  minutesAgo: '{count} perce',
  hoursAgo: '{count} órája',
  today: 'ma',
  yesterday: 'tegnap',
  daysAgo: '{count} napja',
  yesterdayAt: 'tegnap {time}',
  // A no-break space keeps the time with its day when a sentence wraps.
  tomorrowAt: 'holnap {time}',
  dateAt: '{date} {time}',
  todayHeading: 'Ma',
  yesterdayHeading: 'Tegnap',
} as const;
