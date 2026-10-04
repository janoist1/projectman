import { describe, expect, it } from 'vitest';
import { formatStamp } from './format';

describe('formatStamp', () => {
  const now = new Date(2026, 9, 4, 12, 0);

  it('gives the time for today, in the past and ahead', () => {
    expect(formatStamp(new Date(2026, 9, 4, 8, 5), now)).toBe('08:05');
    expect(formatStamp(new Date(2026, 9, 4, 21, 40), now)).toBe('21:40');
  });

  it('names yesterday and tomorrow', () => {
    expect(formatStamp(new Date(2026, 9, 3, 14, 2), now)).toBe('tegnap 14:02');
    expect(formatStamp(new Date(2026, 9, 5, 8, 0), now)).toBe('holnap 08:00');
  });

  it('gives the date for earlier days and for later days, with the day before the time', () => {
    expect(formatStamp(new Date(2026, 8, 28, 14, 2), now)).toBe('szept. 28. 14:02');
    expect(formatStamp(new Date(2026, 9, 9, 8, 0), now)).toBe('okt. 9. 08:00');
  });
});
