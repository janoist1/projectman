import { lowerFirstWord, type TemplateLocale } from './types';

/** Hungarian default display names (the only place for Hungarian text in this package). */
export const hu: TemplateLocale = {
  language: 'hu',
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
    developer: 'Fejlesztő',
    code_review: 'Code review',
    security_review: 'Biztonsági átnéző',
    qa: 'QA',
    devops: 'Devops',
    communication: 'Kommunikáció',
    project_manager: 'Projektmenedzser',
    docs: 'Dokumentáló',
    scheduled: 'Napi munkatárs',
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
