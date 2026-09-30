/** Text without accents: "Kódátnézés" → "Kodatnezes". */
export function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export interface SlugOptions {
  /** Joins the words: "_" for stage and column ids, "-" for label ids. */
  separator: '_' | '-';
  maxLength: number;
  /** Put in front of a slug that does not start with a letter (stage and column ids must). */
  letterPrefix?: string;
  /** Used when the name has no letters or digits at all. */
  fallback?: string;
}

/**
 * A new id from a display name: accent-free lowercase words joined by the separator, made
 * unique against the taken ids with a numeric suffix ("qa", "qa_2"), never longer than
 * `maxLength`.
 */
export function slugId(name: string, taken: readonly string[], options: SlugOptions): string {
  const { separator, maxLength, letterPrefix, fallback = '' } = options;
  let slug = stripAccents(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .split(separator)
    .filter(Boolean)
    .join(separator);
  if (letterPrefix !== undefined && !/^[a-z]/.test(slug)) slug = `${letterPrefix}${slug}`;
  const base = slug.slice(0, maxLength) || fallback;
  let id = base;
  for (let suffix = 2; taken.includes(id); suffix++) {
    const tail = `${separator}${suffix}`;
    id = `${base.slice(0, maxLength - tail.length)}${tail}`;
  }
  return id;
}
