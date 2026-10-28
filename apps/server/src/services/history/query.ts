import { HISTORY_QUERY_MAX_TOKENS } from '@projectman/shared';

/** The suffixes a Hungarian word may lose in a search (PM-786): one pass, accents ignored, not a morphology. */
const SUFFIXES = [
  'nál',
  'nél',
  'ban',
  'ben',
  'nak',
  'nek',
  'hoz',
  'hez',
  'höz',
  'val',
  'vel',
  'ról',
  'ről',
  'ból',
  'ből',
  'tól',
  'től',
  'ért',
  'ra',
  're',
  'ba',
  'be',
  'on',
  'en',
  'ön',
  'at',
  'et',
  'ot',
  'öt',
  't',
];

/** The letters a stem keeps at least after a suffix is cut. */
const MIN_STEM_LETTERS = 4;
/** A token this long or longer is searched as a prefix. */
const PREFIX_FROM = 3;

/** Lower case, without accents: the form in which tokens and suffixes are compared. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The suffixes in the accent-free form, longest first, each once. */
const FOLDED_SUFFIXES = [...new Set(SUFFIXES.map(foldText))].sort((a, b) => b.length - a.length);

/** The letter and digit runs of a text, in NFC: the tokens the index's tokenizer would make of it. */
export function queryTokens(text: string): string[] {
  return text.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The stem of an accent-free word without its longest suffix that leaves enough letters, if it has one. */
export function suffixStem(folded: string): string | null {
  if (!/^\p{L}+$/u.test(folded)) return null;
  for (const suffix of FOLDED_SUFFIXES)
    if (folded.endsWith(suffix) && folded.length - suffix.length >= MIN_STEM_LETTERS)
      return folded.slice(0, folded.length - suffix.length);
  return null;
}

interface TranslatedQuery {
  /** The bound MATCH expression: quoted terms only, OR between the variants of a token, AND between tokens. */
  match: string;
  /** Every accent-free term the expression can match at the start of a word (for the excerpt and the line). */
  terms: string[];
}

export class QueryError extends Error {}

const quoted = (term: string, prefix: boolean) => `"${term.replaceAll('"', '""')}"${prefix ? '*' : ''}`;

/**
 * Turns the plain text of a query into a MATCH expression. The text never reaches the index as syntax: every
 * term is a quoted string, so a quote, a star, a dash or the word AND is an ordinary character or word.
 */
export function translateQuery(query: string): TranslatedQuery {
  const tokens = queryTokens(query);
  if (tokens.length === 0) throw new QueryError('the query has no searchable word');
  if (tokens.length > HISTORY_QUERY_MAX_TOKENS)
    throw new QueryError(`the query has more than ${HISTORY_QUERY_MAX_TOKENS} words`);
  const terms = new Set<string>();
  const groups = tokens.map((token) => {
    const folded = foldText(token);
    const variants = [{ term: folded, prefix: [...folded].length >= PREFIX_FROM }];
    const stem = suffixStem(folded);
    if (stem !== null) variants.push({ term: stem, prefix: true });
    for (const variant of variants) terms.add(variant.term);
    const parts = variants.map((variant) => quoted(variant.term, variant.prefix));
    return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
  });
  return { match: groups.join(' AND '), terms: [...terms] };
}
