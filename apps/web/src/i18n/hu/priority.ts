export const priority = {
  label: 'Prioritás',
  levels: { urgent: 'Sürgős', high: 'Magas', normal: 'Normál', low: 'Alacsony' },
  none: 'Nincs megadva',
  markLabel: 'Prioritás: {level}',
  saveFailed: 'Nem sikerült menteni a prioritást. Próbáld újra.',
  /** Under a theme's priority (PM-1137). */
  themeHelp: 'A téma kártyái legalább ezzel a prioritással sorolódnak.',
} as const;
