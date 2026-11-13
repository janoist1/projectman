/** Project templates: TemplateSummary.nameKey / descriptionKey point here. */
export const templates = {
  starter: {
    name: 'Kezdőcsapat',
    description: 'Egy fejlesztő és Projektmenedzser, egyszerű folyamattal.',
  },
  'web-client-project': {
    name: 'Fejlesztés ügyfélnek',
    description: 'Fejlesztés, átnézés, tesztelés, ügyfélteszt és élesítés. Az élesítésről te döntesz.',
  },
  'small-team': {
    name: 'Kis csapat',
    description: 'Egy fejlesztő és egy átnéző. A lezárásról te döntesz.',
  },
  'internal-tool': {
    name: 'Belső eszköz',
    description: 'Fejlesztés, átnézés és tesztelés, ügyfélteszt nélkül. A beolvasztásról te döntesz.',
  },
  'daily-routine': {
    name: 'Napi rutin',
    description: 'Egy munkatárs hétköznap reggel átnézi a kódot, és kártyát nyit, ha talál valamit.',
  },
} as const;
