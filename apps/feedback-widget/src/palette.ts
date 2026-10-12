import type { FeedbackPerson } from '@projectman/shared';

/** The marker palette (the same eight colours as in projectman); a white monogram reads on each (4.5:1). */
export const MARKER_COLORS = [
  '#3044c9',
  '#0f766e',
  '#9d174d',
  '#6d28d9',
  '#9a3412',
  '#166534',
  '#b42318',
  '#713f12',
] as const;

/** The colour index of a person: humans have one (0..7), AI members and unknowns use the first. */
export const colorIndexOf = (person: Pick<FeedbackPerson, 'color'> | null): number => {
  const color = person?.color;
  return typeof color === 'number' && Number.isInteger(color) && color >= 0 && color < MARKER_COLORS.length
    ? color
    : 0;
};

export const colorOf = (person: Pick<FeedbackPerson, 'color'> | null): string =>
  MARKER_COLORS[colorIndexOf(person)] ?? MARKER_COLORS[0];

/** The monogram: the initials of a human's name, the handle of an AI member. */
export function monogramOf(person: Pick<FeedbackPerson, 'name' | 'handle' | 'kind'>): string {
  if (person.kind === 'ai') return person.handle.slice(0, 2).toUpperCase();
  const words = person.name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[words.length - 1]?.[0] ?? ''}` : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}
