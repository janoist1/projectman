import { lowerFirstWord, type TemplateLocale } from './types';

/** Hungarian default display names and role texts (the only place for Hungarian text in this package). */
export const hu: TemplateLocale = {
  language: 'hu',
  timezone: 'Europe/Budapest',
  columns: {
    ready: { name: 'Indulhat', hint: 'Kiválasztva, indulhat a munka' },
    development: { name: 'Fejlesztés', hint: 'Egy fejlesztő dolgozik rajta' },
    in_progress: { name: 'Folyamatban', hint: 'Épp dolgoznak rajta' },
    review: { name: 'Átnézés', hint: 'Ellenőrzés alatt' },
    client_test: { name: 'Ügyfélteszt', hint: 'Az ügyfél próbálja ki' },
    awaiting_merge: { name: 'Merge-re vár', hint: 'Merge emberi döntéssel' },
    awaiting_release: { name: 'Élesítésre vár', hint: 'Merge és élesítés emberi döntéssel' },
    done: { name: 'Kész', hint: 'Lezárva' },
  },
  stages: {
    ready: 'Indulhat',
    dev: 'Fejlesztés',
    work: 'Folyamatban',
    code_review: 'Code review',
    integration: 'Integration',
    qa: 'QA',
    client_test: 'Ügyfélteszt',
    merge: 'Merge',
    release: 'Élesítés',
    done: 'Kész',
  },
  roles: {
    operator: {
      name: 'Operátor',
      summary: 'Futtatja és felügyeli a rendszert, visszaterel minden félrement munkát, és övé a végső szó.',
      notTheirJob: 'Nem végzi a napi feladatokat: irányítja a csapatot, nem helyettesíti.',
    },
    product_owner: {
      name: 'Terméktulajdonos',
      summary: 'Eldönti, mi készüljön és milyen sorrendben, és ő fogadja el a kész munkát.',
      notTheirJob: 'Nem ír specifikációt és nem ütemez.',
    },
    project_manager: {
      name: 'Projektmenedzser',
      summary: 'Az ütemezést viszi: standup, tervezés, határidők, emlékeztetők, heti jelentés.',
      notTheirJob: 'Nem rangsorol, és nem vezeti a retrót.',
    },
    business_analyst: {
      name: 'Elemző',
      summary:
        'Az ügyfél kéréséből pontos leírást és elfogadási feltételeket ír, és visszakérdez, mielőtt a munka elindul.',
      notTheirJob: 'Nem ütemez, és nem tervez technikai megoldást.',
    },
    architect: {
      name: 'Architekt',
      summary:
        'Fejlesztés előtt megtervezi a technikai megoldást, feladatokra bontja, és átnézi a nagyobb döntéseket.',
      notTheirJob: 'Nem nézi át sorról sorra a kódot.',
    },
    designer: {
      name: 'Designer',
      summary:
        'Képernyőterveket és kattintható mockupot készít, és ellenőrzi, hogy a kész felület a terv szerint készült-e.',
      notTheirJob: 'Nem programozza le a felületet.',
    },
    developer: {
      name: 'Fejlesztő',
      summary: 'Saját ágon, tesztekkel együtt megvalósítja a feladatot, és PR-t nyit.',
      notTheirJob: 'Nem hagyja jóvá a saját munkáját.',
    },
    code_review: {
      name: 'Code review',
      summary: 'Minden PR-t átnéz az integration előtt, és fájl:sor pontossággal jelzi, mi blokkol.',
      notTheirJob: 'Nem ír és nem javít kódot.',
    },
    security_review: {
      name: 'Biztonsági átnéző',
      summary: 'A PR-okban a hozzáférést, a titokkezelést és a fizetési útvonalakat nézi át.',
      notTheirJob: 'Nem javít, csak jelez.',
    },
    qa: {
      name: 'QA',
      summary:
        'Integrationön és böngészőben teszteli a kész munkát, és reprodukálható hibajelentést ad vissza.',
      notTheirJob: 'Nem javítja a hibát.',
    },
    devops: {
      name: 'Devops',
      summary: 'Kitelepít, felügyeli a szervereket és az infrastruktúrát.',
      notTheirJob: 'Élesbe csak jóváhagyás után ad ki, funkciót nem fejleszt.',
    },
    communication: {
      name: 'Kommunikáció',
      summary:
        'Megírja a tesztkéréseket, az összefoglalókat és az ügyfélnek szóló leveleket, küldés előtt jóváhagyásra.',
      notTheirJob: 'Nem dönt az ügyfél helyett.',
    },
    support: {
      name: 'Hibafelvevő',
      summary: 'Fogadja és reprodukálja a hibajelentéseket, és kidolgozott kártyát készít belőlük.',
      notTheirJob: 'Nem javítja a hibát.',
    },
    researcher: {
      name: 'Kutató',
      summary: 'Rövid felméréseket végez: melyik könyvtár, járható-e egy megoldás, mit csinál a versenytárs.',
      notTheirJob: 'Nem valósítja meg, csak ajánl.',
    },
    maintainer: {
      name: 'Karbantartó',
      summary:
        'Frissíti a függőségeket, rendbe teszi az instabil teszteket, csökkenti a technikai adósságot. Ütemezve fut a legjobban.',
      notTheirJob: 'Nem fejleszt új funkciót.',
    },
    coach: {
      name: 'Coach',
      summary:
        'A retrók gazdája: gyűjti az észrevételeket, és javaslatot tesz a szerepek és a folyamat javítására.',
      notTheirJob: 'Nem lépteti életbe a változást: azt jóváhagyják.',
    },
    watchdog: {
      name: 'Felügyelő',
      summary:
        'Az Operátor segítője: jelez, ha egy tag elakadt, körbe-körbe jár, túl sokat fogyaszt vagy túllépi a hatáskörét.',
      notTheirJob: 'Nem avatkozik be, csak jelez.',
    },
    content: {
      name: 'Tartalom',
      summary: 'Szövegeket, SEO-t és marketinganyagot készít.',
      notTheirJob: 'Nem fejleszti a felületet.',
    },
    translator: {
      name: 'Fordító',
      summary: 'Kezeli a többnyelvű felületek szövegeit, és vigyáz a következetes szóhasználatra.',
      notTheirJob: 'Nem ír új tartalmat.',
    },
    docs: {
      name: 'Dokumentáló',
      summary: 'Naprakészen tartja a leírásokat és a döntésnaplót.',
      notTheirJob: 'Nem hoz döntést, csak rögzíti.',
    },
  },
  members: {
    daily_worker: 'Napi munkatárs',
  },
  specialties: {
    frontend: 'Frontend',
    backend: 'Backend',
  },
  templates: {
    'web-client-project': {
      name: 'Webes ügyfélprojekt',
      description:
        'Ügyfélnek készülő webes projekt: fejlesztők, code review, integration, QA és ügyfélteszt; merge és élesítés emberi döntéssel.',
    },
    'small-team': {
      name: 'Kis csapat',
      description: 'Egy fejlesztő és egy code review; a tulajdonos dönt a lezárásról.',
    },
    'internal-tool': {
      name: 'Belső eszköz',
      description: 'Két fejlesztő, code review és QA, ügyfélteszt nélkül; a merge-ről a tulajdonos dönt.',
    },
    'daily-routine': {
      name: 'Napi rutin',
      description: 'Egy ütemezett munkatárs visszatérő, napi feladatokhoz.',
    },
  },
  specialist: (specialty, roleName) => `${specialty} ${lowerFirstWord(roleName)}`,
};
