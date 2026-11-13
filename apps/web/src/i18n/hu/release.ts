/** The release of the instance (PM-387, PM-492). */
export const release = {
  /** The step of a deploy a release stopped in, as a noun phrase: "Itt akadt el: {step}". */
  steps: {
    fetch: 'letöltés a GitHubról',
    build: 'fordítás (build)',
    test: 'kiadási teszt',
    config_check: 'a konfiguráció ellenőrzése',
    pause: 'a futó munka szüneteltetése',
    stop: 'a régi verzió leállítása',
    backup: 'adatbázis-mentés',
    switch: 'átváltás az új verzióra',
    verify: 'az új verzió ellenőrzése',
    rollback: 'visszaállítás a régi verzióra',
    publish: 'tag és GitHub release',
  },
} as const;
