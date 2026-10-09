import { describe, expect, it } from 'vitest';
import { parseMode } from '../src/app';

describe('PROJECTMAN_MODE', () => {
  it('is single when nothing is set', () => {
    expect(parseMode(undefined)).toBe('single');
    expect(parseMode('')).toBe('single');
    expect(parseMode('  ')).toBe('single');
  });

  it.each(['single', 'cloud', 'engine'])('accepts %s', (mode) => {
    expect(parseMode(mode)).toBe(mode);
    expect(parseMode(` ${mode} `)).toBe(mode);
  });

  it.each(['Engine', 'hybrid', 'engine,cloud', '0'])(
    'refuses %j instead of falling back to a default',
    (mode) => {
      expect(() => parseMode(mode)).toThrowError(/Invalid PROJECTMAN_MODE/);
    },
  );
});
