import { describe, expect, it } from 'vitest';
import { isStrictlyWithin, isWithin } from './paths';

describe('isWithin', () => {
  it('tells what lies inside a directory, by its text', () => {
    expect(isWithin('/work', '/work')).toBe(true);
    expect(isWithin('/work', '/work/a/b')).toBe(true);
    expect(isWithin('/work', '/work/..a')).toBe(true);
    expect(isWithin('/work', '/')).toBe(false);
    expect(isWithin('/work', '/elsewhere')).toBe(false);
    expect(isWithin('/work', '/work-other')).toBe(false);
    expect(isWithin('/work/a', '/work')).toBe(false);
  });
});

describe('isStrictlyWithin', () => {
  it('leaves the directory itself out', () => {
    expect(isStrictlyWithin('/work', '/work')).toBe(false);
    expect(isStrictlyWithin('/work', '/work/')).toBe(false);
    expect(isStrictlyWithin('/work', '/work/a')).toBe(true);
    expect(isStrictlyWithin('/work', '/work-other')).toBe(false);
    expect(isStrictlyWithin('/work/a', '/work')).toBe(false);
  });
});
