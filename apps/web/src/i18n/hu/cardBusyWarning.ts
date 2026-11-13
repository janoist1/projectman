/** The confirmation when a message would put an AI member on a card a same-role member works on (PM-663). */
export const cardBusyWarning = {
  titleWorking: 'Ezen a kártyán már dolgozik valaki',
  titleJoining: 'Az üzenet többeket küldene ugyanarra a munkára',
  description:
    '{taskKey}: azonos szerepű tagok dolgoznának rajta egyszerre. Ha a közös munka szándékos, küldd el mégis; ha nem, lépj vissza, és írd át a címzetteket.',
  working: 'Már dolgozik rajta',
  joining: 'Az üzenet odaküldené',
  joiningMark: 'most kerülne oda',
  back: 'Vissza',
  confirm: 'Küldés mégis',
} as const;
