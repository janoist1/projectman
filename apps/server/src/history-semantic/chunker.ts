import { CHUNK_OVERLAP_TOKENS, CHUNK_TOKENS, PASSAGE_PREFIX } from './model';

/** Counts the tokens of a text as the model reads it, the special tokens included. */
type TokenCounter = (text: string) => number;

export interface ChunkPlan {
  /** UTF-16 offsets into the text; `endChar` is exclusive. */
  startChar: number;
  endChar: number;
  /** True when no text is left to index after this chunk. */
  last: boolean;
  /** Where the next chunk starts (the end of the text when this was the last). */
  nextChar: number;
}

/** A chunk never reaches further than this many characters, so one step tokenizes a bounded text. */
const MAX_SPAN_CHARS = 2048;
/** A boundary is looked for only in the last part of a chunk, so a chunk never shrinks to almost nothing. */
const BOUNDARY_SHARE = 0.4;

const isBlank = (char: string) => char === ' ' || char === '\n' || char === '\t' || char === '\r';
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function skipBlank(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text[index]!)) index++;
  return index;
}

/** The 1-based line of a character offset, on the original text (the lines `read_history_source` counts). */
export function lineIndex(text: string): (index: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * The chunk that starts at or after `from`: the longest span of at most `CHUNK_TOKENS` tokens (the passage prefix and
 * the special tokens count), ended at a paragraph, line or word boundary when one is near. The next chunk starts
 * `CHUNK_OVERLAP_TOKENS` tokens before the end. The plan depends only on the text and the counter, so an interrupted
 * source resumes into the very same chunks.
 */
export function planChunk(text: string, from: number, count: TokenCounter): ChunkPlan {
  const start = skipBlank(text, from);
  if (start >= text.length)
    return { startChar: text.length, endChar: text.length, last: true, nextChar: text.length };
  const fits = (s: number, e: number, budget: number) => count(PASSAGE_PREFIX + text.slice(s, e)) <= budget;

  const limit = Math.min(text.length, start + MAX_SPAN_CHARS);
  let end = limit;
  if (!fits(start, limit, CHUNK_TOKENS)) {
    let lo = start + 1;
    let hi = limit - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(start, mid, CHUNK_TOKENS)) lo = mid;
      else hi = mid - 1;
    }
    end = lo;
  }
  // Never split a surrogate pair.
  if (end < text.length && end - 1 > start && isHighSurrogate(text.charCodeAt(end - 1))) end--;

  if (end < text.length) {
    const floor = end - Math.floor((end - start) * BOUNDARY_SHARE);
    const paragraph = text.lastIndexOf('\n\n', end - 2);
    const line = text.lastIndexOf('\n', end - 2);
    const word = text.lastIndexOf(' ', end - 2);
    if (paragraph >= floor) end = paragraph + 2;
    else if (line >= floor) end = line + 1;
    else if (word >= floor) end = word + 1;
  }

  // Only blanks left after the chunk: there is nothing more to index, and the blanks join the chunk if they fit.
  if (text.slice(end).trim() === '') {
    if (end < text.length && fits(start, text.length, CHUNK_TOKENS)) end = text.length;
    return { startChar: start, endChar: end, last: true, nextChar: text.length };
  }

  // The overlap: the shortest tail of the chunk that is at most CHUNK_OVERLAP_TOKENS tokens.
  let lo = start + 1;
  let hi = end;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, end, CHUNK_OVERLAP_TOKENS)) hi = mid;
    else lo = mid + 1;
  }
  let next = lo;
  // Begin at a word: step over the rest of the word the tail starts in.
  if (next > start + 1 && next < end && !isBlank(text[next - 1]!) && !isBlank(text[next]!)) {
    let step = next;
    while (step < end && !isBlank(text[step]!)) step++;
    if (step + 1 < end) next = step + 1;
  }
  if (next < end && isLowSurrogate(text.charCodeAt(next))) next++;
  return { startChar: start, endChar: end, last: false, nextChar: Math.max(next, start + 1) };
}
