import { describe, expect, it } from 'vitest';
import { maskEmail } from './email-mask';

describe('maskEmail', () => {
  it('keeps the first letters and the last domain label', () => {
    expect(maskEmail('janos.kiss@example.co.uk')).toBe('j***@e***.uk');
    expect(maskEmail('Anna@example.com')).toBe('A***@e***.com');
  });

  it('masks a domain of one label', () => {
    expect(maskEmail('janos@localhost')).toBe('j***@l***');
  });

  it('never returns a malformed address as it is', () => {
    expect(maskEmail('nonsense')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail('a@')).toBe('***');
  });
});
