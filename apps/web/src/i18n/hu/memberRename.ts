/** Renaming an AI member's handle (PM-1026). */
export const memberRename = {
  menu: 'Azonosító átnevezése',
  menuFor: '{name} azonosítójának átnevezése',
  title: '{name} azonosítójának átnevezése',
  intro:
    'Ezzel az azonosítóval hivatkoznak rá a csapatban, a kártyákon és az üzenetekben. A neve nem változik.',
  label: 'Új azonosító',
  hint: 'Kisbetű, szám és kötőjel, legfeljebb 32 karakter. Most: {handle}',
  consequencesTitle: 'Mi történik?',
  carriesOn:
    'A kártyái, üzenetei és munkái az új azonosítóval mennek tovább; a munkaterülete és a beszélgetései megmaradnak.',
  oldHandleReserved:
    'A régi azonosító ({handle}) foglalt marad: más tag nem kaphatja meg, és a régi hivatkozások ide vezetnek.',
  emailFollows: 'Az e-mail-címe {address} lesz; a régi címére küldött levelek is megérkeznek hozzá.',
  emailFollowsNoDomain:
    'Az e-mail-címe az új azonosítót követi; a régi címére küldött levelek is megérkeznek hozzá.',
  newHandle: 'új azonosító',
  notWhileWorking: 'Amíg dolgozik, nem nevezhető át.',
  submit: 'Átnevezés',
  submitting: 'Átnevezés…',
  done: 'Átnevezve: {from} → {to}',
  invalid:
    'Kisbetűvel vagy számmal kezdődjön, és csak kisbetű, szám és kötőjel lehet benne (legfeljebb 32 karakter).',
  unchanged: 'Ez a mostani azonosítója. Írj be egy újat.',
  taken: 'A(z) „{handle}” azonosító foglalt: egy tag most vagy korábban ezt használta. Válassz másikat.',
  mailboxTaken: 'Ezt az azonosítót e-mail-címként már egy másik tag használja. Válassz másikat.',
  working: 'Most dolgozik ({work}). Ha végzett, átnevezheted.',
  former: 'korábban:',
} as const;
