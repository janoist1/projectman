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
  duties: {
    prioritization: {
      name: 'Prioritáskezelés',
      description: 'Érték és sürgősség szerint rendezi a munkát. Jelzi az ütköző prioritásokat.',
    },
    requirements_analysis: {
      name: 'Igényelemzés',
      description: 'Tisztázza a célokat és az elfogadási feltételeket. Felderíti a nyitott kérdéseket.',
    },
    task_breakdown: {
      name: 'Feladatbontás',
      description: 'Tesztelhető feladatokra bontja a munkát. Rögzíti a függőségeket.',
    },
    triage: {
      name: 'Besorolás',
      description: 'Értékeli a beérkező igényeket és hibákat. A megfelelő emberhez irányítja őket.',
    },
    scheduling: {
      name: 'Ütemezés',
      description: 'Követi a határidőket és az elakadásokat. Emlékezteti a következő felelőst.',
    },
    technical_direction: {
      name: 'Műszaki irányítás',
      description: 'Megtervezi az architektúrát és a műszaki döntéseket. Bemutatja a kockázatokat.',
    },
    ux_design: {
      name: 'UX-tervezés',
      description: 'Képernyőket és interakciókat tervez. Ellenőrzi a megvalósult élményt.',
    },
    implementation: {
      name: 'Megvalósítás',
      description: 'Tesztek mellett valósítja meg a feladatokat. Pull requestet készít az ellenőrzéshez.',
    },
    docs: {
      name: 'Dokumentáció',
      description: 'Műszaki dokumentációt ír és tart karban. Ellenőrzi a példákat.',
    },
    content: {
      name: 'Tartalomkészítés',
      description: 'Terméktartalmat ír és szerkeszt. Követi az egyeztetett hangnemet.',
    },
    translation: {
      name: 'Fordítás',
      description: 'Fordít és ellenőrzi a lokalizációt. Megőrzi a jelentést és a helyőrzőket.',
    },
    maintenance: {
      name: 'Karbantartás',
      description: 'Frissíti a függőségeket és csökkenti a műszaki adósságot. Kis változtatásokkal dolgozik.',
    },
    code_review: {
      name: 'Kódellenőrzés',
      description: 'Ellenőrzi a helyességet és a karbantarthatóságot. Javítható észrevételeket ad.',
    },
    security_review: {
      name: 'Biztonsági ellenőrzés',
      description:
        'Ellenőrzi a hozzáférést és az érzékeny adatok kezelését. Titkok nélkül jelzi a kockázatokat.',
    },
    testing_acceptance: {
      name: 'Tesztelés és elfogadás',
      description: 'Az elfogadási feltételek alapján tesztel. Reprodukálható hibákat rögzít.',
    },
    deployment: {
      name: 'Telepítés',
      description: 'Telepíti az engedélyezett változásokat és ellenőrzi a működést. Rögzíti a verziót.',
    },
    release_approval: {
      name: 'Kiadás jóváhagyása',
      description: 'Kifejezetten dönt a kiadásról. Csak ember töltheti be.',
    },
    monitoring: {
      name: 'Felügyelet',
      description: 'Figyeli a szolgáltatások és a csapat állapotát. Bizonyítékkal jelzi az eltéréseket.',
    },
    client_communication: {
      name: 'Ügyfélkommunikáció',
      description: 'Ügyféltájékoztatókat és tesztkéréseket készít. Küldés előtt jóváhagyást kér.',
    },
    support: {
      name: 'Ügyféltámogatás',
      description: 'Reprodukálja a bejelentett problémákat. Egyértelmű támogatási feladatokat készít.',
    },
    standup_facilitation: {
      name: 'Standup vezetése',
      description: 'Összegyűjti a haladást és az akadályokat. Fókuszban tartja a megbeszélést.',
    },
    refinement_facilitation: {
      name: 'Refinement vezetése',
      description: 'Előkészíti és tisztázza a következő munkákat. Rögzíti a nyitott kérdéseket.',
    },
    retro_facilitation: {
      name: 'Retrospektív vezetése',
      description: 'Összegyűjti a munka tanulságait. Konkrét javításokról egyeztet.',
    },
    process_improvement: {
      name: 'Folyamatfejlesztés',
      description: 'Felismeri a visszatérő nehézségeket. Mérhető változásokat javasol.',
    },
    research: {
      name: 'Kutatás',
      description: 'Célzott kérdést vizsgál. Forrásokkal és bizonytalanságokkal számol be.',
    },
    final_decision: {
      name: 'Végső döntés',
      description: 'Dönt az eszkalált kérdésekben. Csak ember töltheti be.',
    },
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
      summary: 'A PR-okban a hozzáférést, a titokkezelést és a kockázatos részeket nézi át.',
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
  labels: {
    'code-review-ok': {
      name: 'Code review rendben',
      meaning: 'Valaki más átnézte a változtatást, és nem talált blokkoló hibát.',
    },
    'code-review-changes': {
      name: 'Code review: javítandó',
      meaning: 'Az átnézés javítandót talált; a kommentben áll, mit kell javítani.',
    },
    'code-review-blocked': {
      name: 'Code review: elakadt',
      meaning: 'Az átnézést most nem lehet elvégezni; a kommentben áll, miért.',
    },
    'security-ok': {
      name: 'Biztonsági átnézés rendben',
      meaning: 'A hozzáférést, a titokkezelést és a kockázatos részeket átnézték; nincs blokkoló gond.',
    },
    'security-changes': {
      name: 'Biztonsági átnézés: javítandó',
      meaning: 'Biztonsági gond van; a kommentben áll, mi.',
    },
    'qa-ok': { name: 'QA rendben', meaning: 'Tesztelve, és az elfogadási feltételek teljesülnek.' },
    'qa-failed': {
      name: 'QA: hibás',
      meaning: 'A teszt hibát talált; a kommentben áll, hol és hogyan reprodukálható.',
    },
    'qa-retest': { name: 'Újrateszt kell', meaning: 'Javítás után újra tesztelni kell.' },
    'client-accepted': { name: 'Ügyfél elfogadta', meaning: 'Az ügyfél kipróbálta, és elfogadta.' },
    'client-changes': {
      name: 'Ügyfél: javítást kér',
      meaning: 'Az ügyfél kipróbálta, és változtatást kér; a kommentben áll, mit.',
    },
    'pr-merged': {
      name: 'PR merge-elve',
      meaning: 'A feladat pull requestje be van olvasztva; a GitHub alapján automatikusan kerül rá.',
    },
    'merge-approved': {
      name: 'Merge jóváhagyva',
      meaning: 'Egy arra jogosult ember jóváhagyta a beolvasztást. Csak ember teheti rá.',
    },
    'release-approved': {
      name: 'Élesítés jóváhagyva',
      meaning: 'Egy arra jogosult ember jóváhagyta az élesítést. Csak ember teheti rá.',
    },
    'waiting-answer': {
      name: 'Válaszra vár',
      meaning: 'Külső válaszra vár; amíg rajta van, a feladat nem léphet tovább.',
    },
  },
  stageApproval: (stageName) => `${stageName}: jóváhagyva`,
  specialist: (specialty, roleName) => `${specialty} ${lowerFirstWord(roleName)}`,
};
