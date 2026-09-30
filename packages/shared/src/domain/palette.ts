import { z } from 'zod';

/** Colour palette shared by board columns and labels; theme tokens map each name. */
export const BoardColumnColor = z.enum([
  'gray',
  'blue',
  'teal',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
]);
export type BoardColumnColor = z.infer<typeof BoardColumnColor>;

/** Stable positional fallback; omitted colours remain omitted in stored configuration. */
export function defaultBoardColumnColor(position: number): BoardColumnColor {
  return BoardColumnColor.options[position % BoardColumnColor.options.length] ?? 'gray';
}
