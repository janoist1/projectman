/** A link from a description to a project document or one of its sections, and its picker (PM-1223). */
export const documentLink = {
  title: 'Hivatkozás dokumentumra',
  document: 'Dokumentum',
  section: 'Fejezet',
  whole: 'Az egész dokumentum',
  sectionHint: 'Az AI-tag csak a kiválasztott fejezetet olvassa be.',
  preview: 'Ezt szúrja be: {text}',
  insert: 'Beszúrás',
  newDocument: 'Új dokumentum',
  loading: 'Dokumentumok betöltése…',
  sectionsLoading: 'Fejezetek betöltése…',
  empty: 'Még nincs dokumentum ebben a projektben.',
  failed: 'Nem sikerült betölteni a dokumentumokat.',
  retry: 'Újra',
  noSections: 'Ebben a dokumentumban nincs fejezet, az egészére hivatkozol.',
  open: 'Megnyitás a Dokumentumok között: {ref}',
} as const;
