// Installable web app. The build reads these for the manifest and the offline page (src/pwa).
export const pwa = {
  description: 'A csapatod táblája, kérdései és átnézései egy helyen.',
  offline: {
    title: 'Nincs kapcsolat',
    body: 'A {name} most nem éri el a szervert. Ha visszajön a hálózat, magától újratölt.',
    retry: 'Újra',
    retrying: 'Próbálom…',
    stillOffline: 'Még mindig nincs kapcsolat.',
  },
} as const;
