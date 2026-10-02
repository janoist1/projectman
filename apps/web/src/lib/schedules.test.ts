import { describe, expect, it } from 'vitest';
import { describeCron } from './schedules';

describe('describeCron', () => {
  it.each([
    ['0 8 * * 1-5', 'Hétköznap reggel 8'],
    ['0 9 * * *', 'Minden nap reggel 9'],
    ['30 14 * * 1-5', 'Hétköznap 14:30'],
    ['0 0 * * *', 'Minden nap 0:00'],
  ])('puts %s in words', (cron, words) => {
    expect(describeCron(cron)).toBe(words);
  });

  it.each(['*/5 * * * *', '0 8 * * 1', '0 25 * * *', 'not a cron'])('leaves %s as written', (cron) => {
    expect(describeCron(cron)).toBe(cron);
  });
});
