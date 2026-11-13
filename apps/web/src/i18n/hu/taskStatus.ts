export const taskStatus = {
  /** The card's line while a merge into the main branch is open (PM-453), where there is no "Miért áll?" row. */
  merge: {
    running: 'Beolvasztás · {step}',
    queued: 'Beolvasztás: sorra vár',
    fixing: 'Beolvasztás · ütközést javít',
    steps: {
      queued: 'sorra vár',
      merging: 'összefésülés',
      check_waiting: 'a teszt sorra vár',
      engine_waiting: 'a gép kapcsolatára vár',
      checking: 'ellenőrzés fut',
      pushing: 'felküldés',
      finishing: 'lezárás',
    },
  },
  startWaiting: {
    ai_limit_reached: 'Indulásra vár: túl sok AI dolgozik',
    plan_usage_paused: 'Indulásra vár: a {provider}-keret {percent}% fölött szünetel',
    provider_rate_limited: '{provider}: korlát, újrapróba {until}',
    provider_rate_limited_unknown: 'NanoGPT: korlát, a keret állapotára vár',
    disk_low: 'Indulásra vár: kevés a szabad lemezhely',
    machine_busy: 'Indulásra vár: a gép memóriája túlterhelt',
    ai_disabled: 'Indulásra vár: az AI-munka ki van kapcsolva',
    team_paused: 'Indulásra vár: a csapat szünetel',
    member_at_capacity: 'Indulásra vár: {name} tele van',
    /** One thing holds the member's place (PM-297): `what` is "még beszélget", "még dolgozik (PM-12)"… */
    capacityOne: 'Indulásra vár: {name} {what}',
    member_on_leave: 'Indulásra vár: {name} szabadságon van',
    repo_required: 'Válassz repót a kártyához',
    workspace_busy: 'Indulásra vár: {name} munkaállomásán más kártya fut',
    workspace_dirty: 'Indulásra vár: {name} munkaállomásán befejezetlen munka van',
    workspace_fetch_failed: 'Indulásra vár: a friss alapágat nem sikerült letölteni',
    workspace_dependencies_pending: 'Indulásra vár: a függőségek előkészítése folyamatban',
    workspace_dependencies_failed: 'Indulásra vár: a függőségek előkészítése nem sikerült',
    prerequisite_open: 'Előfeltételre vár: {prerequisites}',
    no_free_member: 'Szabad fejlesztőre vár',
    senior_busy: 'Alkalmas fejlesztőre vár',
    label_missing: '{name} munkájára vár: {labels}',
    waiting_answer: 'Válaszra vár',
    full_test_pending: 'Az átnézés a teljes tesztre vár',
    handoff_open: 'Átadásra vár: {name} leadására',
    provider_not_logged_in: 'Indulásra vár: a {provider} nincs bejelentkezve',
    engine_offline: 'Motorra vár: {engine} nem csatlakozik',
    engine_offline_none: 'Motorra vár: nincs csatlakozó motor',
    nanogpt_key_missing: 'Indulásra vár: nincs NanoGPT-kulcs',
    nanogpt_setup_incomplete: 'Indulásra vár: hiányos a NanoGPT-beállítás',
    codex_setup_incomplete: 'Indulásra vár: hiányos a Codex-beállítás',
    start_backoff: 'Az indítás elbukott, újrapróba {until}',
    start_failing: 'Az indítás ismétlődően elbukik, nem próbálkozik tovább',
    workspace_codex_config: 'Indulásra vár: a munkafa .codex mappájában nem engedélyezett beállítás van',
  },
  stageOwners: 'a lépés összes felelőse',
  /** What holds a member's place, in running text: the strip, the profile (PM-297). */
  capacityNames: {
    general: 'általános beszélgetés',
    schedule: 'ütemezett futás',
    meeting: 'megbeszélés',
    taskHidden: 'egy másik kártya',
  },
  startHints: {
    /** The card waits for the places of the member, by what holds them (PM-297); `n` is the silence limit. */
    capacity: {
      general: 'A beszélgetés {n} perc csend után magától lezárul, és a kártya elindul.',
      schedule: 'Az ütemezett futás {n} perc csend után magától lezárul, és a kártya elindul.',
      meeting: 'A megbeszélés végéig foglalja a helyet; utána a kártya magától elindul.',
      task: 'A kártya magától elindul, amint {name} végez a mostani lépésével.',
      several:
        'A kártya magától elindul, amint {name} egyik helye felszabadul. Ami {n} percig csendes, magától lezárul.',
    },
    capacityAt: 'Ha addig senki nem ír bele, {time} körül indul.',
    capacitySoon: 'Hamarosan indul.',
    workspace_codex_config:
      'A Codex a munkafa .codex mappáját megbízhatóként tölti be, és az ottani hookok, MCP-szerverek és szabályok a homokozón kívül futnának. Töröld a mappát a kártya ágáról, vagy hagyj benne csak egy config.toml-t modellbeállításokkal. A munka ezután magától elindul (a szerver félpercenként újrapróbálja). A szerver naplója megnevezi a fájlt és a kulcsokat.',
    provider_rate_limited:
      'A szolgáltató 429-es korlátot jelzett. A munka a várakozás után magától újrapróbálkozik.',
    ai_limit_reached: 'Várj, amíg felszabadul egy AI, vagy emeld a korlátot a Beállítások → Keretek alatt.',
    plan_usage_paused:
      'Várj a keret megújulására, vagy emeld a szüneteltetési küszöböt a Beállítások → Keretek alatt.',
    disk_low:
      'Szabadíts fel lemezhelyet (például töröld a régi munkafákat és buildeket), vagy csökkentsd a határt a Beállítások → Keretek alatt.',
    machine_busy:
      'Várj, amíg a gép memóriája kicsit megpihen; érdemes leállítani a felesleges programokat (fejlesztői szerver, Docker, böngésző).',
    ai_disabled: 'Kapcsold be a Beállítások → Keretek alatt.',
    team_paused: 'A munka magától elindul, amikor a csapat folytatja.',
    member_at_capacity: 'Szabadíts fel egy tagot: fejezd be vagy add át a többi kártyáját.',
    member_on_leave: 'Hívd vissza a tagot a szabadságról a Csapat oldalon, vagy add át a kártyát másnak.',
    repo_required:
      'Az AI-fejlesztő addig nem indulhat, amíg nincs repó kiválasztva: válaszd ki a kártya adatainál.',
    workspace_busy:
      'A tag ugyanebben a repóban egy másik kártyán dolgozik; ez akkor indul, amikor az a munkamenet véget ér vagy átadta a munkát.',
    workspace_dirty:
      'A tag munkaállomásán el nem mentett változás vagy félbehagyott git-művelet van. Kérd meg a tagot (vagy nézd meg magad), hogy mentse el vagy fejezze be; automatikusan semmit nem törlünk.',
    workspace_fetch_failed:
      'Az új kártya ága csak friss alapról indulhat. Ellenőrizd a hálózatot és a repó elérését; az indítás magától újrapróbálkozik.',
    workspace_dependencies_pending:
      'A motor előkészíti a tag munkaállomásának függőségeit. A munkamenet ezután automatikusan elindul.',
    workspace_dependencies_failed:
      'A motor nem tudta előkészíteni a függőségeket. A naplóban látható a hiba oka; az indítás később automatikusan újrapróbálkozik.',
    prerequisite_open:
      'A munka magától elindul, amikor az utolsó előfeltétel is lezárul (kész vagy visszavont). Ember az Indítás gombbal előbb is elindíthatja.',
    no_free_member:
      'Most nincs szabad fejlesztő. A kártya magától elindul, amint felszabadul egy, vagy ha a Beállítások → Keretek alatt engedélyezed a beugrókat; addig kézzel is hozzárendelhetsz valakit.',
    senior_busy:
      'Ehhez a ponthoz nagyobb határú fejlesztő kell, ezért megvárja, amíg egy ilyen felszabadul. Ha sokáig vár, a beérkezőben megkérdezzük, megkaphatja-e más. Addig kézzel is kioszthatod.',
    /** After "Várjon tovább": by someone else, or by the viewer ("Te" does not fit the sentence). */
    senior_busy_decided:
      '{name} döntése: a kártya megvárja az alkalmas fejlesztőt. Erről többet nem kérdezünk; kézzel bármikor kioszthatod.',
    senior_busy_decided_me:
      'Úgy döntöttél, hogy a kártya megvárja az alkalmas fejlesztőt. Erről többet nem kérdezünk; kézzel bármikor kioszthatod.',
    label_missing:
      'A kapu olyan címkét kér, amelyet AI-tag tesz fel; az ő munkamenete elindult a kártyán. A fejlesztő magától indul, amint a címke rákerül.',
    waiting_answer: 'Az indítás a kártyán nyitott kérdés megválaszolása után folytatódik.',
    full_test_pending:
      'A szerver lefuttatja az átadott commit teljes tesztjét (a PTY-tesztekkel együtt). Zöld eredménynél az átnéző magától indul; bukásnál a kártya visszamegy a fejlesztőhöz.',
    handoff_open:
      'A régi felelős még lead: jegyzetet ír, vagy letelik a 10 perc. Utána az új felelős magától elindul.',
    // The drawer adds the login command (`providerSettings.loginCommands`) in a code element after it.
    provider_not_logged_in:
      'A munka magától elindul, amint belépsz; a szerver félpercenként ellenőrzi. Futtasd a szerveren:',
    engine_offline:
      'A gép, amelyen a tag dolgozik, most nem érhető el. Amint újra csatlakozik, a munka magától elindul.',
    nanogpt_key_missing:
      'A tulajdonos a Beállítások → AI-szolgáltatók alatt adhatja meg a kulcsot; utána a munka magától elindul.',
    nanogpt_setup_incomplete:
      'A NanoGPT beállítása hiányos a szerveren. A Beállítások → AI-szolgáltatók NanoGPT-sora mutatja, mi hiányzik; ha ott minden rendben, egy Codex-beállítás akadályozza az indulást (a munkaterület .codex mappája, a szerver /etc/codex mappája vagy a NanoGPT saját Codex-mappájának beállításai), azt kell kivenni. Ide tartoznak a hookok (a hooks beállítás és a hooks.json fájl), a project_root_markers és a macOS-es MDM-profil (com.openai.codex): a tulajdonos törölje őket, vagy tegye át egy másik Codex-otthonba. Ha a Codex programja tiltott mappában van, telepítsd a hivatalos telepítővel vagy a tiltott mappán kívülre. Javítás után a munka magától elindul.',
    codex_setup_incomplete:
      'Frissítsd a Codexet legalább {minCliVersion} verzióra, vagy a hibában megnevezett konfigurációs fájlból vedd ki a homokozó-beállítást (sandbox_mode, sandbox_workspace_write, default_permissions, permissions, profile, profiles). Az indulást a hookok (a hooks beállítás és a hooks.json fájl, a felhasználói és a rendszergazdai is), a project_root_markers beállítás és a macOS-es MDM-profil (com.openai.codex) is akadályozza: a tulajdonos törölje őket, vagy tegye át egy másik Codex-otthonba. MCP-beállítási hibánál a felhasználói config.toml mcp_servers neveit kell egyértelművé tenni; a team név a projectmané. Ha a Codex programja tiltott mappában van, telepítsd a hivatalos telepítővel vagy a tiltott mappán kívülre. Javítás után a munka magától elindul.',
    start_backoff:
      'A munkamenet indítása elbukott. A szerver magától újra próbálja: 30 másodperc, 1, 2, majd 4 perc múlva; az ötödik bukás után megáll.',
    start_failing:
      'Az indítás ötször egymás után elbukott, ezért a szerver nem próbálkozik tovább. Ha a szolgáltató állapota megváltozik (belépés, frissítés, motor újracsatlakozása), egyszer újra próbál; a figyelmeztetésen az Ellenőrzés most gombbal is adhatsz egy próbát.',
  },
  /**
   * "Miért áll?" on the card row and in the drawer (PM-461): "{ki} · {mire vár}". `head` is the bold part
   * (a name, or a title when nobody in particular acts), `short` the rest of the row, `long` the same in a
   * sentence for the box, `todo` what to do. {name} / {names} are people ("Te" for the viewer).
   */
  next: {
    between: ' · ',
    you: 'Rád vár',
    /** Several people: the first two, then how many more. */
    more: '{names} +{more}',
    /** The row's title and accessible name. */
    title: 'Ki: {head} · Mire vár: {waiting} · Teendő: {todo}',
    noTodo: 'semmi',
    senior: 'Alkalmas fejlesztő',
    /** What holds the only place of the member the card waits for, after the name (PM-297). */
    capacityKinds: {
      general: 'még beszélget',
      schedule: 'ütemezett futása tart',
      meeting: 'megbeszélésen van',
      task: 'még dolgozik ({keys})',
      taskHidden: 'még dolgozik egy másik kártyán',
    },
    /** What waits when the start waits: a short sentence per reason (the box adds the long one). */
    startReasons: {
      ai_limit_reached: 'túl sok AI dolgozik',
      plan_usage_paused: 'a {provider}-keret {percent}% fölött szünetel',
      provider_rate_limited: 'a {provider} korlátot jelzett',
      disk_low: 'kevés a szabad lemezhely',
      machine_busy: 'a gép memóriája túlterhelt',
      ai_disabled: 'az AI-munka ki van kapcsolva',
      team_paused: 'a csapat szünetel',
      member_at_capacity: 'mással foglalkozik, utána sorra kerül',
      member_on_leave: 'szabadságon van',
      repo_required: 'válassz repót',
      workspace_busy: 'más munkán dolgozik ugyanabban a repóban',
      workspace_dirty: 'befejezetlen munka van a gépén',
      workspace_fetch_failed: 'a friss alapágat nem sikerült letölteni',
      workspace_dependencies_pending: 'a függőségek előkészítése folyamatban',
      workspace_dependencies_failed: 'a függőségek előkészítése nem sikerült',
      no_free_member: 'mindenki mással foglalkozik',
      senior_busy: 'mással foglalkozik, utána sorra kerül',
      label_missing: 'előbb ő dolgozik rajta: {labels}',
      waiting_answer: 'válaszra vár',
      full_test_pending: 'fut, utána indul az átnézés',
      handoff_open: 'leadja a munkát',
      provider_not_logged_in: 'a {provider} nincs bejelentkezve',
      engine_offline: 'a gép nem csatlakozik',
      nanogpt_key_missing: 'nincs NanoGPT-kulcs',
      nanogpt_setup_incomplete: 'hiányos a NanoGPT-beállítás',
      codex_setup_incomplete: 'hiányos a Codex-beállítás',
      start_backoff: 'az indítás elbukott, újrapróba később',
      start_failing: 'az indítás ismétlődően elbukik',
      workspace_codex_config: 'nem engedélyezett beállítás van a munkafa .codex mappájában',
      prerequisite_open: 'előfeltétel',
    },
    readyHolds: {
      ai_disabled: 'az AI-munka ki van kapcsolva',
      team_paused: 'a csapat szünetel',
      ai_limit_reached: 'túl sok AI dolgozik',
      engine_offline: 'a gép nem csatlakozik',
      no_free_member: 'nincs szabad fejlesztő',
      senior_busy: 'Alkalmas fejlesztőre vár',
    },
    /** The bold part when it is not a person. */
    heads: {
      start: 'Indulásra vár',
      freeMember: 'Szabad fejlesztőre vár',
      fullTest: 'Teljes teszt',
      /** Short, so the card's one line keeps the card it waits for (PM-1079). */
      prerequisite: 'Vár',
      done: 'Kész a munka',
      blocked: 'Elakadt',
      held: 'Áll',
      queued: 'Sorra kerül',
      nobody: 'Senki',
      refinement: 'Kidolgozás',
    },
    /** The short row text per reason; {name} etc. are filled by the code. */
    short: {
      startOffer: 'elindítja (Fejlesztésbe mozgatja)',
      collecting: '{count} alkártya lezárására',
      inbox: {
        question: 'válaszol egy kérdésre',
        permission: 'engedélyt ad',
        decision: 'dönt',
        approval: 'jóváhagy',
        alert: 'figyelmeztetést néz meg',
        other: 'teendője van',
      },
      inboxYou: {
        question: '{asker} kérdezett',
        questionNoName: 'kérdés',
        permission: '{asker} engedélyt kér',
        permissionNoName: 'engedélykérés',
        decision: 'döntés',
        approval: 'jóváhagyás',
        alert: 'figyelmeztetés',
        other: 'teendőd van',
      },
      handOn: '{mover} viszi tovább',
      handOnYou: 'kész a munka, vidd tovább',
      merge: 'beolvasztásra vár',
      mergeYou: 'beolvasztás',
      mergeConflict: 'nem olvasztható be',
      mergeConflictYou: 'ütközés',
      mergeCheckFailed: 'nem olvasztható be',
      mergeCheckFailedYou: 'elbukott az ellenőrzés',
      mergeBlocked: 'a beolvasztás elakadt',
      mergeBlockedYou: 'beolvasztás elakadt',
      approval: 'jóváhagyás: {from} → {to}',
      fixLimit: 'dönt {rounds} javítási kör után',
      fixLimitYou: 'döntés {rounds} javítási kör után',
      held: 'amíg rajta van: {labels}',
      blocked: 'az idővonalon áll, miért',
      labels: '{labels}',
      queuedHuman: 'továbbviszi innen: {stage}',
      queuedHumanYou: 'vidd tovább innen: {stage}',
      partLeft: 'az alkártya itt maradt: {stage}',
      partLeftYou: 'vidd tovább az alkártyát: {stage} → {to}',
      takes: 'sorra veszi',
      queuedStage: '{stage}',
      nobody: 'nincs, aki továbbvinné',
    },
    /** The box's "Mire vár" sentences that the start text does not already say. */
    long: {
      capacity: 'Most egy másik munkán dolgozik. Amint végez, ez a kártya következik.',
      collecting: 'A munka az alkártyákon folyik; ez a kártya nem indul el.',
      readyHold:
        'A kártya indítható, de most szándékosan vár. Magától sorra kerül, amint a feltétel megszűnik.',
      startOffer: 'A kártya indítható, és van hozzá szabad fejlesztő. A rendszer szólt, hogy indítsa el.',
      prerequisite: 'Egy előfeltétel még nincs lezárva: {keys}.',
      handOn: '{owner} végzett ebben a lépésben: {step}.',
      handOnNoOwner: 'A munka ebben a lépésben kész: {step}.',
      merge: 'A kártya jóváhagyott munkáját a fő ágba kell beolvasztani.',
      mergeFailed: 'A beolvasztás nem sikerült. A fő ág nem változott.',
      mergeBlocked: 'A beolvasztás elakadt. Az okát lent látod.',
      approval: 'A következő lépéshez jóváhagyás kell: {labels}.',
      fixLimit: '{rounds} javítási kör után a kártya áll, és döntés kell.',
      held: 'A kártya áll, amíg rajta van: {labels}.',
      blocked: 'A kártya elakadt. Az idővonalon áll, miért.',
      labels: 'A következő lépéshez ez még hiányzik: {labels}.',
      queuedHuman: 'A kártya ebben a lépésben áll: {stage}, és valakinek tovább kell vinnie.',
      partLeft:
        'Az alkártya a bontás után a kezdő lépésben maradt ({stage}), és senki nem indítja. Aki létrehozta, viszi tovább: {to}, vagy finomításra teszi, ha még nem indítható.',
      partLeftLabels:
        'Az alkártya a bontás után a kezdő lépésben maradt ({stage}), és senki nem indítja. Aki létrehozta, viszi tovább: {to}, ehhez még hiányzik: {labels}. Ha még nem indítható, finomításra teszi.',
      takes: 'A kártya ebben a lépésben áll: {stage}, a felelőse hamarosan sorra veszi.',
      queuedStage: 'A kártya ennek a lépésnek a sorában áll: {stage}.',
      nobody:
        'Nincs, aki ezzel a kártyával tovább tudna lépni: ennek a lépésnek ({stage}) vagy a következő kapunak nincs gazdája.',
      inbox: 'Egy nyitott tétel vár rá: {kind}.',
    },
    todo: {
      startOffer: 'Mozgasd a kártyát a Fejlesztésbe; a fejlesztőt a rendszer választja.',
      collecting: 'Semmit: amikor az utolsó alkártyája is lezárul, ez a kártya magától lezárul.',
      auto: 'Semmit: magától sorra kerül. Ha sürgős, a Csapat oldalon látod, mi foglalja.',
      capacity: 'Semmit. {hint}',
      nothing: 'Semmit: magától halad.',
      handOn: 'Semmit: {mover} intézi.',
      handOnYou: 'Nézd meg, és vidd tovább.',
      merge: 'Semmit: {merger} olvasztja be a jóváhagyott munkát a fő ágba.',
      mergeYou: 'Olvaszd be a kártya jóváhagyott munkáját a fő ágba.',
      mergeFailed: 'Semmit: {merger} javítja, vagy okkal visszaküldi a fejlesztőnek.',
      mergeFailedYou: 'Javítsd az ütközést, és olvaszd be újra, vagy küldd vissza a fejlesztőnek.',
      mergeBlocked: 'Semmit: {merger} próbálja újra.',
      mergeBlockedYou: 'Hárítsd el az okát, és próbáld újra.',
      approval: 'Döntsd el: jóváhagyod vagy elutasítod.',
      approvalOther: 'Semmit: {who} jóváhagyására vár.',
      fixLimit: 'Döntsd el, hogyan menjen tovább.',
      fixLimitOther: 'Semmit: {who} dönt.',
      held: 'Vedd le a címkét, ha a várakozás véget ért.',
      blocked: 'Nézd meg az utolsó jegyzetet, és oldd fel az akadályt, vagy add át másnak.',
      labels: 'Semmit: {who} intézi.',
      labelsYou: 'Tedd fel a hiányzó címkét.',
      queuedHuman: 'Semmit: {who} viszi tovább.',
      queuedHumanYou: 'Nézd meg, és vidd tovább.',
      partLeft: 'Semmit: {who} viszi tovább az alkártyát.',
      partLeftYou:
        'Tedd fel a hiányzó címkéket, és vidd tovább az alkártyát: {to}. Ha még nem indítható, tedd finomításra, és írd le, mi hiányzik.',
      takes: 'Semmit: magától sorra kerül.',
      inboxOther: 'Semmit: {who} intézi.',
      inboxYou: 'Nyisd meg a tételt, és intézd el.',
      nobody: 'Állítsd be a lépés gazdáját a Beállítások → Folyamat alatt.',
      repo: 'Válaszd ki a repót a kártya adatainál.',
    },
  },
  /** A card that stands on an outage (PM-468): the line on the card, and what to do as its tooltip. */
  stuck: 'Áll: {reason}',
  stuckTodo: {
    login: 'Lépj be a szerveren: {command}',
    loginOnEngine: 'Lépj be a(z) {engine} motor gépén: {command}',
    startFailing: 'Nézd meg az érintett tag utolsó munkamenetét, és javítsd a hibát.',
    settings: 'Add meg a Beállítások → AI-szolgáltatók alatt.',
    engine: 'Kapcsold be a motor gépét, vagy indítsd újra rajta a projectman motort.',
  },
  needsYou: 'Rád vár: {what}',
  needsYouDetail: '{kind} ({detail})',
  /**
   * Who works on a card and in what capacity (PM-237). No article before the name: whether it is "a" or
   * "az" depends on the name, and names can be renamed.
   */
  worker: {
    working: '{name} dolgozik rajta',
    reviewing: '{name} átnézi',
    testing: '{name} teszteli',
    designing: '{name} a felületet tervezi',
    planning: '{name} a műszaki tervet készíti',
    analysing: '{name} elemzi',
    handingOff: '{name} leadja a munkát',
  },
  /** The card's line while several work on it: the names share one verb, as their capacities may differ. */
  workersTwo: '{names} dolgozik rajta',
  workersMany: '{names} és még {more} tag dolgozik rajta',
  /** A member's own sentence next to the name (PM-239); the sentence is theirs and is not translated. */
  workerDoing: '{name}: {summary}',
  /** A worker whose session the team pause holds (PM-220), instead of the verb above. */
  workerPaused: '{name} szünetel',
  workerPausing: '{name}: megáll…',
  /** The name in front of the sentence, drawn apart from it (it has its own weight and colour). */
  workerName: '{name}:',
  workersMore: '+{more}',
  workersMoreLabel: 'és még {more} tag dolgozik rajta',
  waitingOn: 'Másra vár: {who}',
  /** A label's name in a status line (PM-291). */
  quoted: '„{name}”',
  /** The card is not ready to start (PM-291): what it waits for instead of the Start. */
  /** The approval only a person may give is the only thing missing (PM-445): who gives it, and what. */
  approvalMissingBy: '{who} jóváhagyására vár: {label}',
  approvalMissingYou: 'Rád vár: jóváhagyás ({label})',
  approvalNobody: 'Senki sem adhatja meg a jóváhagyást: {label}',
  notRefined: 'Még nincs kidolgozva',
  labelsMissing: 'Címkére vár: {labels}',
  /** The standing of a card's refinement (PM-291); the steps are the labels the gates ask for. */
  refinement: {
    yourStep: 'Rád vár: {label}',
    nobody: 'Nincs, aki feltehetné: {label}',
    system: 'A rendszerre vár: {label}',
    moving: 'Kidolgozva: most lép tovább',
    progress: 'Kidolgozás: {done}/{total} lépés kész',
    steps: 'Lépések',
    stepsList: 'A kidolgozás lépései',
    stepTurn: 'felveheti valamelyikük: {names}',
    stepWorking: '{name} dolgozik rajta',
    stepHeld: 'áll, amíg rajta van: {labels}',
    stepSystem: 'a rendszerre vár',
    stepState: { done: 'kész', current: 'soron', held: 'áll', todo: 'hátra' },
    next: 'Ha minden lépés kész, a kártya magától továbblép: {stage}. Onnan indítható.',
    nextHere: 'Ha minden lépés kész, indítható.',
  },
  /** A card held at its fix round limit (PM-262). */
  fixLimit: '{who} dönt · {rounds} javítási kör után',
  fixLimitYou: 'Rád vár: döntés · {rounds} javítási kör után',
  queuedFor: 'Sorra kerül: {stage}',
  ready: 'Indítható',
  collecting: '{count} alkártya nyitott',
  prerequisite: 'Előfeltételre vár',
  /** No article or suffix after the key: its letters and number differ by project. */
  prerequisiteOn: 'Vár · {ref}',
  /** The stage is where the prerequisite stands now (PM-1079); left out where the viewer does not see it. */
  prerequisiteRef: '{key} ({stage})',
  prerequisiteMore: '{ref} +{more}',
  /** Spoken and tooltip forms of the same wait. */
  prerequisiteLabel: 'Előfeltételre vár: {key}',
  prerequisiteLabelStage: 'Előfeltételre vár: {key}, ez most itt tart: {stage}',
  prerequisiteLabelMore: '{base}; és még {more} kártya',
  prerequisiteLine: '{key} – {title} · {stage}',
  duplicateOf: 'Duplikátum: {key}',
  done: 'Kész · {when}',
  /** The TaskStatus values. */
  statuses: {
    active: 'Folyamatban',
    waiting: 'Vár',
    blocked: 'Elakadt',
    done: 'Kész',
    cancelled: 'Elvetve',
  },
} as const;
