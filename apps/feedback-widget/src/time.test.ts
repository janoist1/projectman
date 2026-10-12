import { describe, expect, it } from 'vitest';
import { messageTime, relativeTime } from './time';

const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime();
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('says how long ago, coarsely', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe('most');
    expect(relativeTime(ago(5 * MINUTE), NOW)).toBe('5 perce');
    expect(relativeTime(ago(2 * HOUR), NOW)).toBe('2 órája');
    expect(relativeTime(ago(DAY), NOW)).toBe('tegnap');
    expect(relativeTime(ago(3 * DAY), NOW)).toBe('3 napja');
    expect(relativeTime(ago(8 * DAY), NOW)).toBe('múlt héten');
    expect(relativeTime(ago(21 * DAY), NOW)).toBe('3 hete');
    expect(relativeTime(ago(90 * DAY), NOW)).toBe('3 hónapja');
  });

  it('returns nothing for a date it cannot read', () => {
    expect(relativeTime('nonsense', NOW)).toBe('');
  });
});

describe('messageTime', () => {
  it('says today and yesterday with the clock', () => {
    expect(messageTime(new Date(2026, 9, 12, 9, 5).toISOString(), NOW)).toBe('ma 9:05');
    expect(messageTime(new Date(2026, 9, 11, 14, 2).toISOString(), NOW)).toBe('tegnap 14:02');
  });

  it('gives the date for older messages', () => {
    expect(messageTime(new Date(2026, 8, 3, 8, 30).toISOString(), NOW)).toBe('9. 3. 8:30');
  });
});
