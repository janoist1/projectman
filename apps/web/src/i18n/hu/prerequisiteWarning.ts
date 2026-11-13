/** The warning before a person starts a card whose prerequisite is open (PM-204). */
export const prerequisiteWarning = {
  title: 'Az előfeltétel még nincs lezárva',
  description:
    'Ez a kártya erre vár: {keys}. Ha most elindítod, a munka az előfeltétel lezárása nélkül kezdődik.',
  /** A collecting card moved with its subtasks: one warning for the whole group (PM-121). */
  groupDescription:
    'Ezek a kártyák előfeltételre várnak. Ha most elindítod őket, a munka az előfeltételek lezárása nélkül kezdődik.',
  groupRow: '{key}: {keys}',
  confirm: 'Indítás mégis',
  moveAndWait: 'Áthelyezés, várjon',
} as const;
