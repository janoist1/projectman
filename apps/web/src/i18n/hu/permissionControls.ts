/** The two permission settings of an AI member: the mode, and who answers when it asks. */
export const permissionControls = {
  nanogptApproverNone:
    'NanoGPT-tagnál a homokozón kívüli parancsokat (pl. commit, npm ci) csak ember hagyhatja jóvá. „Senki” mellett ezek elutasítódnak, így fejlesztőként a tag nem tud commitolni.',
  mode: 'Mód',
  providerNotes: {
    gemini: {
      auto: 'A Gemini-tagnál az Auto úgy működik, mint a „Szerkesztést elfogad”: a szerep engedélyezett parancsain kívül minden parancsot megkérdez, és a „Ha kérdez” beállítás szerint döntünk róla.',
      plan: 'A Gemini-tagnál a Tervezés csak a fájlszerkesztést tiltja: a munkafán dolgozó szerepek előre engedélyezett parancsai (például git commit, npm install) sandbox nélkül lefutnak.',
    },
  },
  approver: 'Ha kérdez, ki dönt',
  approvers: {
    human: 'Ember',
    ai: 'AI-döntnök',
    none: 'Senki',
  },
  legacy: 'régi beállítás',
  legacyHint: 'Régi „mindent szabad” beállítás. Egy új mód kiválasztása lecseréli.',
  network: 'Kimenő hálózat',
  networkHints: {
    on: 'A parancsai bármilyen címet elérnek, az élő példány címein kívül.',
    off: 'Csak az npm érhető el. Más címhez engedélyt kér, a „Ha kérdez” beállítás szerint.',
    offRefused: 'Csak az npm érhető el. Más címet a rendszer elutasít.',
  },
  networkValues: {
    on: 'be',
    off: 'ki',
  },
  networkFacts: {
    on: 'Be',
  },
  networkState: 'Kimenő hálózat: {value}',
  savedNetwork: '{name} kimenő hálózata: {value}. A következő munkamenettől érvényes.',
  blocked: {
    delegation_off: 'Nem választható: az engedélykérések delegálása ki van kapcsolva.',
    no_ai_decider: 'Nem választható: nincs olyan AI-tag, aki az engedélykérésekről dönthetne.',
  },
  lostApprover: 'Nincs AI-döntnök, ezért a kérdések emberhez mennek: {names}.',
  lostApproverLabel: 'Döntnök figyelmeztetés',
  savedMode: '{name} módja: {value}.',
  savedApprover: '{name} döntnöke: {value}.',
} as const;
