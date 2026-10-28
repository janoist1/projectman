import { EMAIL_INBOUND_TEXT_MAX } from '@projectman/shared';

const QUOTE_HEADERS = [
  /^\s*On\b.{0,300}\bwrote:\s*$/i,
  /^.{0,300}\sírta:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
];
const FROM_LINE = /^\s*(From|Feladó):/i;
const DATE_LINE = /^\s*(Sent|Date|Küldve|Elküldve|Dátum):/i;
const QUOTED_LINE = /^\s*>/;

/** Quote headers can wrap over two lines ("On …,\n… wrote:"): both forms count. */
function isQuoteHeader(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (QUOTE_HEADERS.some((pattern) => pattern.test(line))) return true;
  const joined = `${line} ${lines[index + 1] ?? ''}`;
  if (/^\s*On\b/i.test(line) && /\bwrote:\s*$/i.test(joined) && !/\bwrote:/i.test(line)) return true;
  if (FROM_LINE.test(line)) return DATE_LINE.test(lines[index + 1] ?? '');
  return false;
}

/**
 * The part of a reply the person wrote: the quoted history, the signature (from a "-- " line) and runs
 * of blank lines are cut. A text with nothing left falls back to the start of the raw text.
 */
export function cleanReplyText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isQuoteHeader(lines, index)) break;
    if (/^-- ?$/.test(line)) break;
    if (QUOTED_LINE.test(line)) continue;
    kept.push(line);
  }
  const cleaned = kept
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return (cleaned || text.trim()).slice(0, EMAIL_INBOUND_TEXT_MAX);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Plain text from an HTML body: tags removed, entities resolved, links kept as their text only. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#')) {
        const code =
          entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, '\n');
}
