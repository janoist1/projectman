export const priority = {
  own: 'Saját prioritás',
  effective: 'Érvényes: {level}',
  inherited: 'örökölt',
  themeSource: 'Téma: {key} · {title}',
  parentSource: 'Szülő: {key} · {title}',
  clear: 'Törlés',
  retry: 'Újra',
  saving: 'Mentés…',
  saved: 'Prioritás mentve.',
  label: 'Prioritás',
  levels: { urgent: 'Sürgős', high: 'Magas', normal: 'Normál', low: 'Alacsony' },
  none: 'Nincs megadva',
  markLabel: 'Prioritás: {level}',
  saveFailed: 'Nem sikerült menteni a prioritást. Próbáld újra.',
  /** Under a theme's priority (PM-1137). */
  themeHelp: 'A téma kártyái legalább ezzel a prioritással sorolódnak.',
} as const;
