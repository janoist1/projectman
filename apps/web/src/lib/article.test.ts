import { describe, expect, it } from 'vitest';
import { withArticle } from './article';

describe('withArticle', () => {
  it('puts "a" before a consonant and "az" before a vowel', () => {
    expect(withArticle('Projektmenedzser')).toBe('a Projektmenedzser');
    expect(withArticle('Adminisztrátor')).toBe('az Adminisztrátor');
    expect(withArticle('Öreg Pm')).toBe('az Öreg Pm');
    expect(withArticle('devops')).toBe('a devops');
  });
});
