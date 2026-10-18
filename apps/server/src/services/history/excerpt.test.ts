import { describe, expect, it } from 'vitest';
import { HISTORY_EXCERPT_MAX_CHARS } from '@projectman/shared';
import { excerptOf, firstMatch, lineAt } from './excerpt';

describe('history excerpts', () => {
  it('finds a word start through accents and case', () => {
    const chars = Array.from('A Beállítás oldal');
    expect(firstMatch(chars, ['beallitas'])).toBe(2);
    // A term inside a word is not a match: the index matches by word start.
    expect(firstMatch(Array.from('xbeallitas'), ['beallitas'])).toBe(-1);
    expect(firstMatch(chars, [])).toBe(-1);
  });

  it('numbers lines from 1', () => {
    const chars = Array.from('one\ntwo\nthree');
    expect(lineAt(chars, 0)).toBe(1);
    expect(lineAt(chars, 4)).toBe(2);
    expect(lineAt(chars, 8)).toBe(3);
  });

  it('returns a short text whole, collapsed, from the title when the title matches', () => {
    expect(excerptOf('Title', 'a   b\n\nc', ['title'])).toEqual({ excerpt: 'Title a b c', line: 1 });
    expect(excerptOf('Title', 'a   b\n\nc', ['b'])).toEqual({ excerpt: 'a b c', line: 1 });
  });

  it('reports the line of the first match in the body', () => {
    const body = ['first', 'second', 'third needle here', 'fourth'].join('\n');
    expect(excerptOf('Doc', body, ['needle']).line).toBe(3);
  });

  it('stays within the limit and marks the cut ends', () => {
    const body = `${'x '.repeat(500)}needle${' y'.repeat(500)}`;
    const { excerpt } = excerptOf('', body, ['needle']);
    expect([...excerpt].length).toBeLessThanOrEqual(HISTORY_EXCERPT_MAX_CHARS);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).toContain('needle');
  });

  it('starts at the top when the match is near it, and cuts only the end', () => {
    const body = `needle ${'z '.repeat(600)}`;
    const { excerpt } = excerptOf('', body, ['needle']);
    expect(excerpt.startsWith('needle')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect([...excerpt].length).toBeLessThanOrEqual(HISTORY_EXCERPT_MAX_CHARS);
  });

  it('shows the end of a long text when the match is there', () => {
    const body = `${'z '.repeat(600)}needle`;
    const { excerpt } = excerptOf('', body, ['needle']);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('needle')).toBe(true);
    expect([...excerpt].length).toBeLessThanOrEqual(HISTORY_EXCERPT_MAX_CHARS);
  });

  it('starts at the title when the title matches, and line 1 when the body has no match', () => {
    const result = excerptOf('Needle title', 'plain body', ['needle']);
    expect(result.excerpt.startsWith('Needle title')).toBe(true);
    expect(result.line).toBe(1);
  });
});
