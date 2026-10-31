import { describe, expect, it } from 'vitest';
import { documentSlugOf } from './document';

describe('documentSlugOf', () => {
  it.each([
    ['Projektterv', 'projektterv'],
    ['A munka útja: árvíztűrő tükörfúrógép', 'a-munka-utja-arvizturo-tukorfurogep'],
    ['  --Hello,   World!--  ', 'hello-world'],
    ['!!!', 'document'],
    ['', 'document'],
  ])('makes %j into %j', (title, slug) => {
    expect(documentSlugOf(title, new Set())).toBe(slug);
  });

  it('numbers a taken slug, a deleted one included', () => {
    expect(documentSlugOf('Plan', new Set(['plan']))).toBe('plan-2');
    expect(documentSlugOf('Plan', new Set(['plan', 'plan-2']))).toBe('plan-3');
  });

  it('cuts to 64 characters and keeps the suffix inside the limit', () => {
    const long = `${'a'.repeat(63)} b`;
    const slug = documentSlugOf(long, new Set());
    expect(slug).toBe('a'.repeat(63));
    const numbered = documentSlugOf(long, new Set([slug]));
    expect(numbered).toHaveLength(64);
    expect(numbered.endsWith('-2')).toBe(true);
  });
});
