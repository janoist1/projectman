import { describe, expect, it } from 'vitest';
import { isRegeneratedPathPattern } from './regenerated-paths';
import { ReviewTestConfig } from './schema';

describe('isRegeneratedPathPattern', () => {
  it.each([
    ['a literal path', 'docs/GENERATED.md'],
    ['a glob below a literal directory', 'apps/server/src/context/__snapshots__/**'],
    ['a dot directory that is not .git', '.github/generated/*.yml'],
  ])('accepts %s', (_name, pattern) => {
    expect(isRegeneratedPathPattern(pattern)).toBe(true);
  });

  it.each([
    ['an empty pattern', ''],
    ['a longer than 200 characters', `a/${'b'.repeat(200)}`],
    ['an absolute path', '/etc/**'],
    ['a pathspec magic', ':(top)src/**'],
    ['a backslash', 'src\\gen'],
    ['a NUL', 'src/\0gen'],
    ['a line break', 'src/gen\nother'],
    ['an empty segment', 'src//gen'],
    ['a trailing slash', 'src/gen/'],
    ['a dot segment', 'src/./gen'],
    ['a parent segment', 'src/../gen'],
    ['a wildcard first segment', '*/gen'],
    ['a character class in the first segment', 'sr[c]/gen'],
    ['a path under .git', '.git/hooks/**'],
  ])('refuses %s', (_name, pattern) => {
    expect(isRegeneratedPathPattern(pattern)).toBe(false);
  });
});

describe('ReviewTestConfig.regenerate (PM-1050)', () => {
  const base = { command: 'npm test' };
  const regenerate = { paths: ['src/__snapshots__/**'], command: 'npm run update' };

  it('is optional', () => {
    expect(ReviewTestConfig.parse(base).regenerate).toBeUndefined();
    expect(ReviewTestConfig.parse({ ...base, regenerate }).regenerate).toEqual(regenerate);
  });

  it.each([
    ['no path', { ...regenerate, paths: [] }],
    ['eleven paths', { ...regenerate, paths: Array.from({ length: 11 }, (_, i) => `gen${i}/**`) }],
    ['a bad pattern', { ...regenerate, paths: ['../gen'] }],
    ['a blank command', { ...regenerate, command: '   ' }],
    ['a command over 500 characters', { ...regenerate, command: 'x'.repeat(501) }],
  ])('refuses %s', (_name, value) => {
    expect(ReviewTestConfig.safeParse({ ...base, regenerate: value }).success).toBe(false);
  });
});
