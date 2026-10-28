import { describe, expect, it } from 'vitest';
import { foldText, QueryError, queryTokens, suffixStem, translateQuery } from './query';

describe('history query translation', () => {
  it('quotes every term and ANDs the tokens', () => {
    expect(translateQuery('release notes').match).toBe('"release"* AND "notes"*');
  });

  it('keeps a short token as an exact term and searches a longer one as a prefix', () => {
    expect(translateQuery('ab').match).toBe('"ab"');
    expect(translateQuery('abc').match).toBe('"abc"*');
  });

  it('is accent- and case-insensitive on the query side', () => {
    expect(translateQuery('Beállítás').match).toBe(translateQuery('beallitas').match);
    expect(foldText('Őrült ÁRVÍZ')).toBe('orult arviz');
  });

  it('finds the base form from an inflected query and the inflected forms from the base query (both ways)', () => {
    // beállítás -> beállítást, beállításnál: the base query is a prefix of the inflected words.
    expect(translateQuery('beallitas').match).toBe('"beallitas"*');
    expect(translateQuery('beállítás').match).toBe('"beallitas"*');
    // beállítást / beállításnál -> beállítás: the inflected query also searches the stem.
    expect(translateQuery('beállítást').match).toBe('("beallitast"* OR "beallitas"*)');
    expect(translateQuery('beállításnál').match).toBe('("beallitasnal"* OR "beallitas"*)');
  });

  it('cuts the longest matching suffix once and never below four letters', () => {
    expect(suffixStem('beallitasnal')).toBe('beallitas');
    expect(suffixStem('kerdesben')).toBe('kerdes');
    // "hat" would leave "h" for 't': too short, so the word is kept whole.
    expect(suffixStem('hat')).toBeNull();
    expect(suffixStem('abrat')).toBe('abra');
    expect(suffixStem('abrat')).not.toBe('abr');
    // Not recursive: only one suffix goes.
    expect(suffixStem('szamokban')).toBe('szamok');
  });

  it('does not stem digits, mixed tokens or words without a suffix', () => {
    expect(suffixStem('pm786')).toBeNull();
    expect(suffixStem('12345')).toBeNull();
    expect(suffixStem('kapu')).toBeNull();
  });

  it('collects the terms for the excerpt', () => {
    expect(translateQuery('beállításnál').terms).toEqual(['beallitasnal', 'beallitas']);
  });

  it('treats syntax characters as plain text', () => {
    const quoteQuery = translateQuery('say "hello" OR NOT world*');
    expect(quoteQuery.match).toBe('"say"* AND "hello"* AND "or" AND "not"* AND "world"*');
    expect(translateQuery('a-b:c').match).toBe('"a" AND "b" AND "c"');
    expect(translateQuery('near(x y) AND z').match).toContain('"near"*');
  });

  it('refuses a query without any word and one with too many', () => {
    expect(() => translateQuery('"*-()')).toThrow(QueryError);
    expect(() => translateQuery('   ')).toThrow(QueryError);
    expect(() => translateQuery('a b c d e f g h i j k l')).not.toThrow();
    expect(() => translateQuery('a b c d e f g h i j k l m')).toThrow(QueryError);
  });

  it('tokenizes like the index: letters and digits, any script', () => {
    expect(queryTokens('PM-786: árvíztűrő tükörfúrógép')).toEqual(['PM', '786', 'árvíztűrő', 'tükörfúrógép']);
  });
});
