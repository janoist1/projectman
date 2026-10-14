/** Longest slug taken from a task title. */
export const MAX_SLUG_LENGTH = 40;

/** Latin letters that Unicode decomposition does not reduce to ASCII (by code point). */
const TRANSLITERATIONS = new Map<number, string>([
  [0xdf, 'ss'], // sharp s
  [0xe6, 'ae'], // ae ligature
  [0x153, 'oe'], // oe ligature
  [0xf8, 'o'], // o with stroke
  [0x111, 'd'], // d with stroke
  [0xf0, 'd'], // eth
  [0x142, 'l'], // l with stroke
  [0xfe, 'th'], // thorn
  [0x131, 'i'], // dotless i
]);

/**
 * Lowercase ASCII slug of a title: accents stripped, anything else turned into single
 * dashes, at most `maxLength` characters (cut at a dash when one is near the end).
 */
export function slugify(text: string, maxLength = MAX_SLUG_LENGTH): string {
  const ascii = Array.from(text.normalize('NFD').toLowerCase())
    .map((ch) => TRANSLITERATIONS.get(ch.codePointAt(0) ?? 0) ?? ch)
    .join('')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length <= maxLength) return ascii;
  const cut = ascii.slice(0, maxLength);
  const dash = cut.lastIndexOf('-');
  return (dash >= maxLength / 2 ? cut.slice(0, dash) : cut).replace(/-+$/, '');
}

/** Branch of a task: "<TASKKEY>-<slug of the title>", e.g. "AR-21-fix-the-booking-email". */
export function taskBranchName(taskKey: string, title: string): string {
  const slug = slugify(title);
  return slug ? `${taskKey}-${slug}` : taskKey;
}

/** Whether a branch belongs to the task: "AR-2" or "AR-2-..." (but not "AR-21-..."). */
export function isTaskBranch(branch: string, taskKey: string): boolean {
  return branch === taskKey || branch.startsWith(`${taskKey}-`);
}
