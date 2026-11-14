export const priority = {
  label: 'Priority',
  levels: { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' },
  none: 'Not set',
  markLabel: 'Priority: {level}',
  saveFailed: 'Couldn’t save the priority. Try again.',
  themeHelp: 'The theme’s cards are ranked at least at this priority.',
} as const;
