import { describe, expect, it } from 'vitest';
import {
  canApprovePairing,
  formatPairingCode,
  isSafeDisplayText,
  normalizePairingCode,
  printableText,
} from './engine-pairing';
import { StartEnginePairingRequest } from '../api/engine-pairing-dto';

describe('pairing machine name', () => {
  it.each([
    '\u0000',
    '\n',
    '\t',
    '\u0085',
    '\u200b',
    '\u202a',
    '\u202e',
    '\u2066',
    '\u2069',
    '\u2028',
    '\u2029',
  ])('rejects control or formatting character %j before trimming', (character) => {
    expect(StartEnginePairingRequest.shape.name.safeParse(`${character}Friend Mac`).success).toBe(false);
  });

  it('keeps ordinary Unicode names and trims spaces', () => {
    expect(StartEnginePairingRequest.shape.name.parse('  Árvíztűrő 日本 Mac  ')).toBe('Árvíztűrő 日本 Mac');
  });
});

describe('printableText', () => {
  it.each([
    '\u0000',
    '\u001b',
    '\u007f',
    '\u0085',
    '\u200b',
    '\u202a',
    '\u202e',
    '\u2066',
    '\u2069',
    '\u2028',
    '\u2029',
  ])('replaces %j', (character) => {
    expect(printableText(`a${character}b`)).toBe('a?b');
    expect(isSafeDisplayText(`a${character}b`)).toBe(false);
  });

  it('keeps ordinary Unicode text as it is', () => {
    expect(printableText('Árvíztűrő 日本 <a@b.hu>')).toBe('Árvíztűrő 日本 <a@b.hu>');
    expect(isSafeDisplayText('Árvíztűrő 日本')).toBe(true);
  });
});

describe('normalizePairingCode', () => {
  it.each([
    ['the hyphenated form', 'BCDF-GHJK'],
    ['spaces anywhere', ' BCDF GHJK '],
    ['lower case', 'bcdf-ghjk'],
    ['no separator', 'BCDFGHJK'],
  ])('accepts %s', (_case, input) => {
    expect(normalizePairingCode(input)).toBe('BCDFGHJK');
  });

  it.each([
    ['a vowel', 'BCDF-GHJA'],
    ['a digit', 'BCDF-GHJ1'],
    ['a letter outside the alphabet (Y)', 'BCDF-GHJY'],
    ['too short', 'BCDF-GHJ'],
    ['too long', 'BCDF-GHJKL'],
    ['an empty code', ''],
  ])('refuses %s', (_case, input) => {
    expect(normalizePairingCode(input)).toBeNull();
  });
});

describe('formatPairingCode', () => {
  it('splits the code into two groups of four', () => {
    expect(formatPairingCode('BCDFGHJK')).toBe('BCDF-GHJK');
  });
});

describe('canApprovePairing', () => {
  it.each([
    [{ hostOwner: true, ownerAccount: false, hasPassword: true }, true],
    [{ hostOwner: false, ownerAccount: true, hasPassword: true }, true],
    [{ hostOwner: false, ownerAccount: true, hasPassword: false }, false],
    [{ hostOwner: false, ownerAccount: false, hasPassword: true }, false],
  ])('%o → %s', (account, allowed) => {
    expect(canApprovePairing(account)).toBe(allowed);
  });
});
