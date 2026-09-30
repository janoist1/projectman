import { describe, expect, it } from 'vitest';
import { slugId, stripAccents } from './ids';

const stage = { separator: '_', maxLength: 32, letterPrefix: 'stage_' } as const;
const label = { separator: '-', maxLength: 36, fallback: 'label' } as const;

describe('slugId', () => {
  it('folds accents and joins words with the separator', () => {
    expect(stripAccents('Kódátnézés')).toBe('Kodatnezes');
    expect(slugId('  Kód átnézés! ', [], stage)).toBe('kod_atnezes');
    expect(slugId('QA: hibás', [], label)).toBe('qa-hibas');
  });

  it('prefixes ids that must start with a letter and falls back for empty names', () => {
    expect(slugId('2. kör', [], stage)).toBe('stage_2_kor');
    expect(slugId('!!!', [], label)).toBe('label');
  });

  it('adds a numeric suffix within the length limit when the id is taken', () => {
    expect(slugId('QA', ['qa', 'qa_2'], stage)).toBe('qa_3');
    const long = 'a'.repeat(40);
    expect(slugId(long, ['a'.repeat(32)], stage)).toBe(`${'a'.repeat(30)}_2`);
    expect(slugId('Válaszra vár', ['valaszra-var'], label)).toBe('valaszra-var-2');
  });
});
