export const time = {
  justNow: 'just now',
  todayAt: 'today {time}',
  minutesAgo: '{count|# minute ago|# minutes ago}',
  hoursAgo: '{count|# hour ago|# hours ago}',
  today: 'today',
  yesterday: 'yesterday',
  daysAgo: '{count|# day ago|# days ago}',
  yesterdayAt: 'yesterday {time}',
  // A no-break space keeps the time with its day when a sentence wraps.
  tomorrowAt: 'tomorrow {time}',
  dateAt: '{date} {time}',
  todayHeading: 'Today',
  yesterdayHeading: 'Yesterday',
} as const;
