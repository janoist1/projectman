import { describe, expect, it } from 'vitest';
import { cronTime, describeCron, parsePlainCron, plainCron } from './schedules';

describe('plain cron', () => {
  it.each([
    ['0 8 * * 1-5', { frequency: 'weekdays', hour: 8, minute: 0 }],
    ['30 14 * * *', { frequency: 'daily', hour: 14, minute: 30 }],
  ])('reads %s', (cron, plain) => {
    expect(parsePlainCron(cron)).toEqual(plain);
  });

  it.each(['*/5 * * * *', '0 8 * * 1', '0 25 * * *', '60 8 * * *', 'not a cron'])(
    'does not read %s',
    (cron) => {
      expect(parsePlainCron(cron)).toBeNull();
    },
  );

  it('builds a cron from a frequency and a time, and the time back from a cron', () => {
    expect(plainCron('weekdays', '08:00')).toBe('0 8 * * 1-5');
    expect(plainCron('daily', '14:05')).toBe('5 14 * * *');
    expect(plainCron('daily', '')).toBeNull();
    expect(plainCron('daily', '24:00')).toBeNull();
    expect(cronTime(parsePlainCron('5 9 * * *')!)).toBe('09:05');
  });
});

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
