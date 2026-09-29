import { describe, expect, it } from 'vitest';
import { cronMatches, nextCronRun, parseCron } from './cron';

const matches = (cron: string, at = '2026-09-30T08:30:00Z', zone = 'Europe/Budapest') =>
  cronMatches(cron, new Date(at), zone);
describe('five-field cron', () => {
  it('supports wildcards, lists, ranges, steps, and numeric step starts', () => {
    expect(matches('* * * * *')).toBe(true);
    expect(matches('0,30 9-11 30 9 3')).toBe(true);
    expect(matches('*/15 8-12/2 * 1-12/2 *')).toBe(true);
    expect(matches('10/20 * * * *')).toBe(true);
    expect(matches('31 * * * *')).toBe(false);
    expect(matches('* 8 * * *')).toBe(false);
  });
  it('uses OR for two restricted day fields and accepts Sunday 0 or 7', () => {
    expect(matches('30 10 1 * 3')).toBe(true);
    expect(matches('30 10 30 * 1')).toBe(true);
    expect(matches('30 10 1 * 1')).toBe(false);
    expect(matches('* * * * 0', '2026-10-04T12:00:00Z')).toBe(true);
    expect(matches('* * * * 7', '2026-10-04T12:00:00Z')).toBe(true);
    expect(matches('* * * * 5-7', '2026-10-04T12:00:00Z')).toBe(true);
  });
  it.each([
    '* * * *',
    '* * * * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 8',
    '*/0 * * * *',
    '10-5 * * * *',
    '1,,2 * * * *',
    'x * * * *',
  ])('rejects malformed expression %s', (cron) => {
    expect(() => parseCron(cron)).toThrow();
  });
  it('skips the nonexistent Budapest spring hour', () => {
    expect(matches('30 2 * * *', '2026-03-29T00:30:00Z')).toBe(false);
    expect(matches('30 2 * * *', '2026-03-29T01:30:00Z')).toBe(false);
    expect(nextCronRun('30 2 * * *', new Date('2026-03-28T02:00:00Z'), 'Europe/Budapest')).toBe(
      '2026-03-30T00:30:00.000Z',
    );
  });
  it('matches both occurrences in the Budapest autumn fold', () => {
    expect(matches('30 2 * * *', '2026-10-25T00:30:00Z')).toBe(true);
    expect(matches('30 2 * * *', '2026-10-25T01:30:00Z')).toBe(true);
    expect(nextCronRun('30 2 * * *', new Date('2026-10-25T00:30:00Z'), 'Europe/Budapest')).toBe(
      '2026-10-25T01:30:00.000Z',
    );
  });
  it('handles midnight, leap days, and fractional time zone offsets', () => {
    expect(matches('0 0 * * *', '2026-09-29T22:00:00Z')).toBe(true);
    expect(nextCronRun('0 0 29 2 *', new Date('2026-01-01Z'), 'UTC')).toBe('2028-02-29T00:00:00.000Z');
    expect(nextCronRun('0 10 * * *', new Date('2026-09-30T04:00:00Z'), 'Asia/Kolkata')).toBe(
      '2026-09-30T04:30:00.000Z',
    );
  });
});
