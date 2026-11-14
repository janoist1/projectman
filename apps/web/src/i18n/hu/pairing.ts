/** Device pairing of a friend's machine (PM-1437, PM-1450): the page the machine's code leads to. */
export const pairing = {
  enter: {
    title: 'Gép párosítása',
    subtitle: 'Írd be a kódot, amelyet a telepítés a gépeden kiírt.',
    label: 'Kód',
    hint: '8 betű, például WDJB-MJHT. A kötőjelet nem kell beírnod.',
    submit: 'Tovább',
    invalid:
      'Ez a kód nem érvényes. Lehet, hogy elírtad, lejárt, vagy már felhasználták. Nézd meg újra a gépen, vagy kérj új kódot a telepítőtől.',
    tooMany: 'Túl sok hibás kód. Próbáld újra {time} múlva.',
    wait: 'Próbáld újra {time} múlva',
    announceReady: 'Újra megpróbálhatod.',
  },
  loading: 'A kód ellenőrzése…',
  approve: {
    title: 'Jóváhagyod ezt a gépet?',
    subtitle: 'Egy gép a fiókodhoz kér hozzáférést, hogy a projektjeiden dolgozhasson.',
    sameCode: 'Ugyanezt a kódot látod a gépen?',
    machine: 'Gép',
    requested: 'Kérés',
    requestedValue: '{time} ({ago})',
    validFor: 'Érvényes még',
    oneMinute: 'Még 1 percig érvényes.',
    creates: 'Jóváhagyáskor létrejön',
    createsEngine: '{name} a Gépeid között',
    createsEngineNote: 'A te nevedben, ezen dolgoznak a projektjeid AI-tagjai.',
    createsKey: 'Claude Code-kulcs teljes jogosítvánnyal',
    createsKeyNote: 'Csak a saját projektjeidhez fér hozzá, kiadást nem tehet közzé. Lejár: {date}.',
    replaces:
      'A mostani Claude Code-kulcsod ({prefix}…) érvényét veszti, a csatlakoztatott Claude az újjal dolgozik tovább.',
    keysNote: 'A kulcsokat a gép közvetlenül kapja meg, te nem látod őket.',
    warning:
      'Csak akkor hagyd jóvá, ha a telepítést te indítottad, a saját gépeden. Ha valaki üzenetben kéri, hogy hagyj jóvá egy kódot, utasítsd el.',
    approve: 'Jóváhagyom',
    approving: 'Jóváhagyás…',
    deny: 'Elutasítom',
    denying: 'Elutasítás…',
    footnote: 'A gépet és a kulcsot később is visszavonhatod a Beállításokban.',
    approveFailed: 'Nem sikerült jóváhagyni. Próbáld újra. A gép addig vár.',
    denyFailed: 'Nem sikerült elutasítani. Próbáld újra.',
  },
  done: {
    title: 'A gép párosítva',
    subtitle: '{name} megkapta a kulcsokat. A telepítés a gépen magától folytatódik.',
    body: 'Térj vissza a telepítő AI-hoz, ő vezet tovább: a projekt bekötése és az ellenőrzés jön.',
    open: 'Gépeid megnyitása',
  },
  denied: {
    title: 'Elutasítva',
    subtitle: 'A gép nem kapott hozzáférést. A gépen futó telepítés leáll, és semmit nem ír a gépre.',
    body: 'Ha mégis te indítottad: kérj új kódot a telepítőtől, és hagyd jóvá azt.',
  },
  expired: {
    title: 'A kód lejárt',
    subtitle: 'A kód 10 percig érvényes. A gépen futó telepítés leáll, és semmit nem ír a gépre.',
    body: 'Kérj új kódot a telepítőtől, és nyisd meg az új linket.',
    again: 'Másik kód beírása',
  },
  noRight: {
    title: 'Ezzel a fiókkal nem hagyhatod jóvá',
    subtitle: 'Gépet és Claude Code-kulcsot csak tulajdonosi fiók hozhat létre. A gép nem kapott semmit.',
    body: 'Lépj be azzal a fiókkal, amellyel a projektjeidet kezeled, és nyisd meg újra a linket.',
    login: 'Belépés másik fiókkal',
    loggingOut: 'Kilépés…',
  },
  /** The ending of a machine's or a key's line when it came from a pairing. */
  paired: ', párosítással',
  /** The button in Settings → Engines. */
  withCode: 'Párosítás kóddal',
} as const;
