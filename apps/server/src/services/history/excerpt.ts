import { HISTORY_EXCERPT_MAX_CHARS } from '@projectman/shared';
import { foldText } from './query';

const ELLIPSIS = '…';
/** How much of the window lies before the match. */
const LEAD_CHARS = 150;

const isWordChar = (char: string) => /[\p{L}\p{N}]/u.test(char);

/** The text in the accent-free form, with the position in `chars` that each folded character comes from. */
function foldedWithMap(chars: readonly string[]): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  chars.forEach((char, index) => {
    for (const piece of foldText(char)) {
      folded += piece;
      origin.push(index);
    }
  });
  return { folded, origin };
}

/**
 * Where the first term starts a word in the text, as an index into its characters (code points), or -1. The
 * index search is by word start, as the prefix match is; the original position is kept through the folding.
 */
export function firstMatch(chars: readonly string[], terms: readonly string[]): number {
  if (chars.length === 0 || terms.length === 0) return -1;
  const { folded, origin } = foldedWithMap(chars);
  let best = -1;
  for (const term of terms) {
    let from = 0;
    while (term !== '') {
      const at = folded.indexOf(term, from);
      if (at < 0) break;
      const position = origin[at]!;
      // A word start: the previous character of the original is not a letter or a digit.
      if (position === 0 || !isWordChar(chars[position - 1]!)) {
        if (best < 0 || position < best) best = position;
        break;
      }
      from = at + 1;
    }
  }
  return best;
}

/** The 1-based line of a character position of a text. */
export function lineAt(chars: readonly string[], position: number): number {
  let line = 1;
  for (let i = 0; i < position && i < chars.length; i++) if (chars[i] === '\n') line++;
  return line;
}

export interface Excerpt {
  excerpt: string;
  /** The line of the first match in the body, when the match is in the body (1 when it is not found there). */
  line: number;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The excerpt of a hit found by meaning (PM-767): the chunk that was nearest to the question, as plain text of at
 * most `HISTORY_EXCERPT_MAX_CHARS` characters. The offsets are UTF-16 offsets into the text the chunk was cut from.
 */
export function chunkExcerpt(text: string, startChar: number, endChar: number): string {
  const chars = Array.from(collapse(text.slice(startChar, endChar)));
  const max = HISTORY_EXCERPT_MAX_CHARS;
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('').trimEnd()}${ELLIPSIS}`;
}

/**
 * A plain-text excerpt of at most `HISTORY_EXCERPT_MAX_CHARS` characters around the first match in the body.
 * A match in the title (or none in the body) starts the excerpt at the title, or at the top of the body when
 * there is no title. It is cut from the text the viewer may read only.
 */
export function excerptOf(title: string, body: string, terms: readonly string[]): Excerpt {
  const bodyChars = Array.from(body);
  const bodyMatch = firstMatch(bodyChars, terms);
  const titleMatch = firstMatch(Array.from(title), terms);
  const line = bodyMatch >= 0 ? lineAt(bodyChars, bodyMatch) : 1;
  const useTitle = title !== '' && (titleMatch >= 0 || bodyMatch < 0);
  const chars = useTitle ? Array.from(`${title}\n${body}`) : bodyChars;
  const match = useTitle ? 0 : bodyMatch;
  const max = HISTORY_EXCERPT_MAX_CHARS;
  if (chars.length <= max) return { excerpt: collapse(chars.join('')), line };
  let start = match > LEAD_CHARS ? match - LEAD_CHARS : 0;
  let end = Math.min(chars.length, start + max - (start > 0 ? 1 : 0) - 1);
  if (end >= chars.length) {
    end = chars.length;
    start = Math.max(0, Math.min(start, end - (max - 1)));
  }
  const cut = collapse(chars.slice(start, end).join(''));
  return { excerpt: `${start > 0 ? ELLIPSIS : ''}${cut}${end < chars.length ? ELLIPSIS : ''}`, line };
}
