import { describe, expect, it } from 'vitest';
import { isTaskBranch, MAX_SLUG_LENGTH, slugify, taskBranchName } from './branch-name';

/** Builds accented test text from code points, so this source file stays ASCII. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);

describe('slugify', () => {
  it('lowercases and joins words with single dashes', () => {
    expect(slugify('  Fix the Booking E-mail!! (again)  ')).toBe('fix-the-booking-e-mail-again');
  });

  it('strips accents, including double acute ones', () => {
    // a + o-double-acute + b + u-double-acute + c, capital E-acute + t + e-acute
    expect(slugify(`a${cp(0x151)}b${cp(0x171)}c ${cp(0xc9)}t${cp(0xe9)}`)).toBe('aobuc-ete');
    // C + a-acute + f + e-grave
    expect(slugify(`C${cp(0xe1)}f${cp(0xe8)} 2`)).toBe('cafe-2');
  });

  it('transliterates letters that do not decompose', () => {
    // Stra(sharp s)e (O-stroke)resund (L-stroke)(o-acute)d(z-acute)
    expect(slugify(`Stra${cp(0xdf)}e ${cp(0xd8)}resund ${cp(0x141)}${cp(0xf3)}d${cp(0x17a)}`)).toBe(
      'strasse-oresund-lodz',
    );
  });

  it('cuts long titles at a dash', () => {
    const slug = slugify('Rework the whole checkout flow for partner bookings and vouchers');
    expect(slug).toBe('rework-the-whole-checkout-flow-for');
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
  });

  it('cuts inside a word when no dash is near the end', () => {
    expect(slugify(`a${'b'.repeat(60)}`)).toBe(`a${'b'.repeat(39)}`);
  });

  it('is empty for titles without letters or digits', () => {
    expect(slugify('!!! ???')).toBe('');
  });
});

describe('taskBranchName', () => {
  it('prefixes the slug with the task key', () => {
    expect(taskBranchName('AR-21', 'Fix the booking confirmation email')).toBe(
      'AR-21-fix-the-booking-confirmation-email',
    );
  });

  it('falls back to the task key', () => {
    expect(taskBranchName('AR-7', '???')).toBe('AR-7');
  });
});

describe('isTaskBranch', () => {
  it('matches the key and its dash-prefixed branches only', () => {
    expect(isTaskBranch('AR-2', 'AR-2')).toBe(true);
    expect(isTaskBranch('AR-2-fix', 'AR-2')).toBe(true);
    expect(isTaskBranch('AR-21-fix', 'AR-2')).toBe(false);
    expect(isTaskBranch('AR-2x', 'AR-2')).toBe(false);
    expect(isTaskBranch('main', 'AR-2')).toBe(false);
  });
});
