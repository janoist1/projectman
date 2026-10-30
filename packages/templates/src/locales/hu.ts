import { lowerFirstWord, type TemplateLocale } from './types';

/** Hungarian default display names and role texts (the only place for Hungarian text in this package). */
export const hu: TemplateLocale = {
  checklist: {
    items: {
      goal: { title: 'A projekt célja', hint: 'Egyeztessétek a célt és a siker feltételeit.' },
      code: { title: 'Forráskód', hint: 'Kapcsold hozzá a projekt kódtárát.' },
      engine: {
        title: 'Motor',
        hint: 'A projekt munkái a motoron futnak: legyen csatlakozva, és adja hozzá a projekt mappáját (`project set`).',
      },
      providers: { title: 'AI-szolgáltatók', hint: 'Ellenőrizd a csapat előfizetéseit.' },
      team: { title: 'Csapat', hint: 'Válassz tagokat és felelősségeket.' },
      process: { title: 'Munkafolyamat', hint: 'Egyeztessétek a szakaszokat és az átnézés feltételeit.' },
      labels: { title: 'Címkék', hint: 'Válassz címkéket a munkához és a jóváhagyásokhoz.' },
      clients: { title: 'Ügyfelek', hint: 'Döntsétek el, ki vesz részt az ügyfél oldaláról.' },
      release: { title: 'Kiadás', hint: 'Egyeztessétek, hogyan jutnak el a változások a felhasználókhoz.' },
      agreement: { title: 'Megállapodás', hint: 'Hagyd jóvá, hogyan dolgozzon veled az Operátor.' },
      first_task: { title: 'Első feladat', hint: 'Hozd létre az első feladatot.' },
      code_review: {
        title: 'Kódátnézés',
        hint: 'Legyen átnézési szakasz, amely a kódátnézés jóváhagyását kéri.',
      },
      guests: {
        title: 'Ügyfél vendégek',
        hint: 'Hívd meg az ügyfél oldaláról azokat, akik követik a munkát.',
      },
      feedback_marks: {
        title: 'Visszajelzés-jelölők',
        hint: 'Állíts be egy felületet, ahol az ügyfél jelölőkkel jelezhet.',
      },
      qa: { title: 'Minőségbiztosítás', hint: 'Legyen tag, aki az elfogadási feltételeket teszteli.' },
      client_test: {
        title: 'Ügyfélteszt',
        hint: 'Egyeztessétek, hogyan próbálja ki az ügyfél a kész munkát.',
      },
      deploy: { title: 'Telepítés', hint: 'Egyeztessétek, hova és hogyan települ a kész változat.' },
      schedule: { title: 'Ütemezés', hint: 'Állítsd be, mikor és milyen gyakran fusson a napi munka.' },
    },
  },
  webPush: {
    title: {
      question: 'Új kérdés vár rád',
      decision: 'Új döntés vár rád',
      approval: 'Jóváhagyás vár rád',
      permission: 'Engedélykérés vár rád',
      release: 'Kiadás vár a jóváhagyásodra',
      host_request: 'Kérés érkezett hozzád',
    },
    digest: { title: '{n} teendő vár rád', body: 'A csendes órák alatt érkeztek.' },
    test: { title: 'Próbaértesítés', body: 'Ha ezt látod, működik.' },
    ntfy: {
      item: { title: 'Rád vár', body: 'Új elem a Rád vár-ban.' },
      digest: { title: '{n} új elem a Rád vár-ban', body: 'A csendes órák alatt érkeztek.' },
      test: { title: 'Próbaértesítés', body: 'Ha ezt látod, az ntfy működik.' },
    },
  },
  structuralReview: {
    details:
      'A PM a jóváhagyás után friss bizonyíték és szabad kapacitás alapján választ műszaki felelőst. A szemle újraellenőrzi az érintett kártyákat és felelősséghatárokat, majd néhány javaslatot ad. Az is elfogadott eredmény, hogy nincs mit változtatni. Nem nyit automatikusan kártyát és nem indít refaktort.',
    question: 'Induljon alkalmi architektúraszemle?',
    approve: 'Szemle jóváhagyása',
    reject: 'Most nem szükséges',
  },
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
    boundary_authorization: {
      name: 'Engedélykérések eldöntése',
      description:
        'A delegálható engedélykérésekről dönt. Költség, éles rendszer, új hozzáférés és tartós határtágítás esetén a tulajdonos dönt.',
    },
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
      name: 'UI/UX tervezés',
      description:
        'Megtervezi a felhasználói folyamatot, a képernyőket és az interakciókat. Ellenőrzi a megvalósult élményt.',
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
    feedback_processing: {
      name: 'Jelölések feldolgozása',
      description:
        'Minden jelölésről dönt: válaszol, kártyát nyit vagy meglévőhöz köti. Ami a tulajdonosra tartozik, továbbítja.',
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
    project_operation: {
      name: 'Projekt működtetése',
      description:
        'A tulajdonos kérésére átállítja, hogyan dolgozik a projekt. Csak AI töltheti be, és csak kérésre dolgozik.',
    },
  },
  roles: {
    operator: {
      name: 'Tulajdonos',
      summary: 'Futtatja és felügyeli a rendszert, visszaterel minden félrement munkát, és övé a végső szó.',
      notTheirJob: 'Nem végzi a napi feladatokat: irányítja a csapatot, nem helyettesíti.',
      whenToAsk:
        'Ha valami félrement, elakadt egy döntés, vagy olyan jóváhagyás kell, amit csak ő adhat meg.',
    },
    product_owner: {
      name: 'Terméktulajdonos',
      summary: 'Eldönti, mi készüljön és milyen sorrendben, és ő fogadja el a kész munkát.',
      notTheirJob: 'Nem ír specifikációt és nem ütemez.',
      whenToAsk: 'Ha el kell dönteni, mi a legfontosabb, vagy elfogadható-e a kész munka.',
    },
    project_manager: {
      name: 'Projektmenedzser',
      summary:
        'Az ütemezést viszi: standup, tervezés, határidők, emlékeztetők, heti jelentés. A tulajdonos kérésére vagy igenje után vezeti a döntésnaplót és a roadmapot, felajánlja a döntésjelölteket, és felveszi a leckéket.',
      notTheirJob: 'Nem rangsorol, és nem vezeti a retrót.',
      whenToAsk:
        'Ha tudni szeretnéd, hol tart a munka és mi mikorra készül, vagy emlékeztető, jelentés kell.',
    },
    business_analyst: {
      name: 'Elemző',
      summary:
        'Az ügyfél kéréséből pontos leírást és elfogadási feltételeket ír, és visszakérdez, mielőtt a munka elindul.',
      notTheirJob: 'Nem ütemez, és nem tervez technikai megoldást.',
      whenToAsk:
        'Ha van egy ötleted vagy kérésed, de még nem tiszta, pontosan mi kell, vagy több részből áll. Kis, világos feladathoz nem kell.',
    },
    architect: {
      name: 'Architekt',
      summary:
        'Fejlesztés előtt megtervezi a technikai megoldást, feladatokra bontja, és átnézi a nagyobb döntéseket.',
      notTheirJob: 'Nem nézi át sorról sorra a kódot.',
      whenToAsk:
        'Ha műszaki kérdésed van (felépítés, átalakítás, gyorsaság), vagy egy nagyobb ötletet kell műszakilag felbontani.',
    },
    designer: {
      name: 'UI/UX szakember',
      summary:
        'Megtervezi a felhasználói élményt és a felületet: a folyamatot, a képernyőket és a kattintható mockupot. Utána ellenőrzi, hogy a kész felület a terv szerint, csiszoltan készült-e.',
      notTheirJob: 'Nem programozza le a felületet.',
      whenToAsk:
        'Ha felületet, felhasználói folyamatot, elrendezést vagy szöveget terveztetnél a fejlesztés előtt, vagy ha egy kész képernyő nehezen használható.',
    },
    developer: {
      name: 'Fejlesztő',
      summary: 'Saját ágon, tesztekkel együtt megvalósítja a feladatot, és PR-t nyit.',
      notTheirJob: 'Nem hagyja jóvá a saját munkáját.',
      whenToAsk: 'Ha egy kártya készen áll a megvalósításra; nem írsz neki, hanem elindítod a kártyát.',
    },
    lead_developer: {
      name: 'Vezető fejlesztő',
      summary: 'Műszaki irányt ad, átnézi a kész munkát és dönt a delegálható külső műveletekről.',
      notTheirJob: 'Nem dönt a saját kéréséről vagy tulajdonosi ügyekről.',
      whenToAsk: 'Műszaki irányítás, átnézés vagy delegálható külső művelet engedélyezése esetén.',
    },
    code_review: {
      name: 'Code review',
      summary: 'Minden PR-t átnéz az integration előtt, és fájl:sor pontossággal jelzi, mi blokkol.',
      notTheirJob: 'Nem ír és nem javít kódot.',
      whenToAsk: 'Átnézi a kész munkát; műszaki kérdésben is kérdezheted.',
    },
    security_review: {
      name: 'Biztonsági átnéző',
      summary: 'A PR-okban a hozzáférést, a titokkezelést és a kockázatos részeket nézi át.',
      notTheirJob: 'Nem javít, csak jelez.',
      whenToAsk: 'Ha hozzáférést, titkokat vagy kockázatos részt érintő változást nézetnél át.',
    },
    qa: {
      name: 'QA',
      summary:
        'Integrationön és böngészőben teszteli a kész munkát, és reprodukálható hibajelentést ad vissza.',
      notTheirJob: 'Nem javítja a hibát.',
      whenToAsk:
        'Ha egy kész funkciót a felhasználó szemével kipróbáltatnál, vagy egy hibát reprodukáltatnál.',
    },
    devops: {
      name: 'Devops',
      summary: 'Kitelepít, felügyeli a szervereket és az infrastruktúrát.',
      notTheirJob: 'Élesbe csak jóváhagyás után ad ki, funkciót nem fejleszt.',
      whenToAsk: 'Kitelepítés és szerverek.',
    },
    communication: {
      name: 'Kommunikáció',
      summary:
        'Megírja a tesztkéréseket, az összefoglalókat és az ügyfélnek szóló leveleket, küldés előtt jóváhagyásra.',
      notTheirJob: 'Nem dönt az ügyfél helyett.',
      whenToAsk: 'Ha üzenetet, összefoglalót vagy levelet kell írni az ügyfélnek.',
    },
    support: {
      name: 'Hibafelvevő',
      summary: 'Fogadja és reprodukálja a hibajelentéseket, és kidolgozott kártyát készít belőlük.',
      notTheirJob: 'Nem javítja a hibát.',
      whenToAsk: 'Ha hibát találtál vagy hibajelentés érkezett, és kártyát kell készíteni belőle.',
    },
    researcher: {
      name: 'Kutató',
      summary: 'Rövid felméréseket végez: melyik könyvtár, járható-e egy megoldás, mit csinál a versenytárs.',
      notTheirJob: 'Nem valósítja meg, csak ajánl.',
      whenToAsk: 'Ha előbb utána kell nézni valaminek: melyik eszköz jó, járható-e egy út.',
    },
    maintainer: {
      name: 'Karbantartó',
      summary:
        'Frissíti a függőségeket, rendbe teszi az instabil teszteket, csökkenti a technikai adósságot. Ütemezve fut a legjobban.',
      notTheirJob: 'Nem fejleszt új funkciót.',
      whenToAsk: 'Ha elavult függőség, instabil teszt vagy technikai adósság zavar.',
    },
    coach: {
      name: 'Coach',
      summary:
        'A retrók gazdája: gyűjti az észrevételeket, és javaslatot tesz a szerepek és a folyamat javítására.',
      notTheirJob: 'Nem lépteti életbe a változást: azt jóváhagyják.',
      whenToAsk: 'Ha a csapat működésén vagy a folyamaton javítanál, vagy retró kell.',
    },
    watchdog: {
      name: 'Felügyelő',
      summary:
        'A tulajdonos segítője: jelez, ha egy tag elakadt, körbe-körbe jár, túl sokat fogyaszt vagy túllépi a hatáskörét.',
      notTheirJob: 'Nem avatkozik be, csak jelez.',
      whenToAsk: 'Ha gyanús, hogy egy tag elakadt vagy túl sokat fogyaszt.',
    },
    content: {
      name: 'Tartalom',
      summary: 'Szövegeket, SEO-t és marketinganyagot készít.',
      notTheirJob: 'Nem fejleszti a felületet.',
      whenToAsk: 'Ha szöveg, SEO vagy marketinganyag kell.',
    },
    translator: {
      name: 'Fordító',
      summary: 'Kezeli a többnyelvű felületek szövegeit, és vigyáz a következetes szóhasználatra.',
      notTheirJob: 'Nem ír új tartalmat.',
      whenToAsk: 'Ha egy szöveget le kell fordítani, vagy egységesíteni kell a szóhasználatot.',
    },
    docs: {
      name: 'Dokumentáló',
      summary: 'Naprakészen tartja a leírásokat és a döntésnaplót.',
      notTheirJob: 'Nem hoz döntést, csak rögzíti.',
      whenToAsk: 'Ha egy leírást vagy a döntésnaplót frissíteni kell.',
    },
  },
  members: {
    daily_worker: 'Napi munkatárs',
  },
  specialties: {
    frontend: 'Frontend',
    backend: 'Backend',
  },
  projectManagerReport: {
    done: 'Megtettem',
    newCard: 'Új kártya',
    forwarded: 'Továbbadtam',
    waiting: 'Rád vár',
    nothing: 'Semmi.',
  },
  operatorReport: {
    done: 'Megtettem',
    decision: 'Döntés kell',
    approval: 'Jóváhagyásra vár',
    waiting: 'Rád vár',
    nothing: 'Semmi.',
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
    'acceptance-open': {
      name: 'Nyitott elfogadási feltétel',
      meaning: 'A feladatnak van még nyitott elfogadási feltétele; a rendszer automatikusan kezeli.',
    },
    'acceptance-unconfirmed': {
      name: 'Megerősítetlen elfogadási feltétel',
      meaning:
        'A feladatnak van nyitott vagy még meg nem erősített elfogadási feltétele; a rendszer automatikusan kezeli.',
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
    refine: {
      name: 'Kidolgozásra vár',
      meaning:
        'A kártyát a fejlesztés előtt kidolgozzák, lépésenként, egyszerre egy taggal; a címkét a rendszer leveszi, amikor kész.',
    },
  },
  emailLoginCode: {
    subject: 'Belépési kódod',
    text: ({ code, validUntil }) =>
      `A belépési kódod: ${code}\n\nA kód egyszer használható, és eddig érvényes: ${validUntil}.\n\nHa nem te kérted, hagyd figyelmen kívül ezt a levelet.\n`,
  },
  passwordResetCode: {
    subject: 'Jelszó-beállító kódod',
    text: ({ code, validUntil }) =>
      `A jelszó beállításához szükséges kódod: ${code}\n\nA kód egyszer használható, és eddig érvényes: ${validUntil}.\n\nHa nem te kérted, hagyd figyelmen kívül ezt a levelet; a jelszavad nem változik.\n`,
  },
  email: {
    quoteHeader: ({ date, name }) => `${date}, ${name} ezt írta:`,
    firstNotice: ({ member, project }) =>
      `${member} (AI-tag, ${project} projekt). Ha nem kérsz több levelet, írd meg válaszban.`,
  },
  fixLimitItem: {
    title: 'Javítási körök határa: {key}',
    summary: 'A(z) {key} kártya {rounds} javítási kör után sem ment át ({parts}). {reason}',
    parts: {
      changes: '{count} kódátnézés',
      design: '{count} UI/UX átnézés',
      testsFailed: '{count} bukott teljes teszt',
      sendBacks: '{count} kézi visszaküldés',
    },
    reasons: {
      no_ai_decider: 'Nincs AI-tag, aki dönthetne róla (Műszaki irányítás és Kódellenőrzés).',
      passed_on: '{name} továbbadta.',
      extra_exhausted: 'A 3 extra kör elfogyott, és újra elérte a határt.',
      decider_timeout: 'Az AI döntő nem döntött határidőn belül.',
      again: 'Még egy kör után újra elérte a határt.',
    },
    extras: {
      left: 'Extra kör: {used} kiadva a 3-ból, {left} maradt.',
      none: 'Extra kör: {used} kiadva a 3-ból, nem maradt több.',
      over: 'Extra kör: {used} kiadva (a határ 3), nem maradt több.',
    },
    verdict: { title: '{name} véleménye', repeat: 'Ismétlődik?', now: 'Hol tart most?' },
    rounds: {
      heading: 'Körök ({count}):',
      technicalCount: '{count} technikai újraátadás nem számít',
      counted: '{n}.',
      technicalMarker: '–',
      grantMarker: '+{n}',
      kind: {
        code_review: 'Kódátnézés · {name}',
        design_review: 'UI/UX átnézés · {name}',
        tests_failed: 'Bukott teljes teszt',
        tests_failed_command: 'Bukott teljes teszt: {command}',
        tests_failed_commit: 'Bukott teljes teszt ({commit})',
        send_back: 'Visszaküldte · {name}',
        send_back_no_note: 'Visszaküldte · {name} (megjegyzés nélkül)',
        branch_moved: 'Technikai újraátadás: az ág elmozdult',
        branch_moved_moves: 'Technikai újraátadás: az ág elmozdult ({from} → {to})',
        extra_round: 'Még egy kör ({index}/3) · {name}',
        extra_round_over: 'Még egy kör ({index}, a 3 fölött) · {name}',
      },
      notCounted: ' (nem számít körnek)',
      note: ': „{note}”',
    },
    options: {
      heading: 'Döntési lehetőségek:',
      recommended: 'javasolt: {reason}',
      unavailable: {
        replan: '(most nem választható: nincs elérhető tervező.)',
        reassign: '(most nem választható: nincs másik elérhető fejlesztő.)',
      },
      label: { replan: 'Pontosabb terv', reassign: 'Más fejlesztő', another_round: 'Még egy kör' },
      consequence: {
        replan:
          'A Műszaki irányítás egy másik AI-tagja pontosítja a tervet vagy bontja a kártyát; ha elengedi, a számlálás újraindul.',
        reassign:
          'A kártyát egy másik fejlesztő kapja, friss munkamenettel; a számlálás újrakezdődik. Az eddigi fejlesztő munkamenete leáll.',
        another_round: 'A fejlesztő megkapja a várakozó üzeneteket, és eggyel több kört kap.',
        another_round_over:
          'A fejlesztő megkapja a várakozó üzeneteket, és eggyel több kört kap. Ha újra eléri a határt, megint emberi döntés kell.',
      },
    },
    footer: {
      integrator:
        'Ez a tétel az integrátornak szól: a fenti lehetőségek egyikét választhatja, vagy indoklással továbbadhatja a tulajdonosnak.',
      owner: 'Ez a tétel a tulajdonosnak szól.',
    },
  },
  systemFeedback: {
    what: 'Mi történt',
    workaround: 'Hogyan hidalta át',
    fix: 'Mi lenne a javítás',
    version: 'projectman-változat',
    occurrences: 'Előfordulások',
  },
  stageApproval: (stageName) => `${stageName}: jóváhagyva`,
  specialist: (specialty, roleName) => `${specialty} ${lowerFirstWord(roleName)}`,
};
