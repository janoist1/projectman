import { describe, expect, it } from 'vitest';
import { matchesPathPattern, pathPatternIssue, PATH_PATTERN_MAX } from './path-pattern';

describe('matchesPathPattern', () => {
  it.each([
    ['apps/web/src/a.ts', 'apps/web/src/a.ts', true],
    ['apps/web/src/a.ts', 'apps/web/src/b.ts', false],
    ['apps/**', 'apps/web/src/a.ts', true],
    ['apps/**/a.ts', 'apps/a.ts', true],
    ['apps/**/a.ts', 'apps/web/src/a.ts', true],
    ['apps/**/a.ts', 'apps/web/src/b.ts', false],
    ['apps/*/a.ts', 'apps/web/src/a.ts', false],
    ['*.lock', 'package.lock', true],
    ['*.lock', 'dir/package.lock', false],
    ['**/*.lock', 'dir/deep/package.lock', true],
    ['a?.ts', 'ab.ts', true],
    ['a?.ts', 'a/.ts', false],
    ['src/**', 'src', true],
  ])('%s against %s is %s', (pattern, path, expected) => {
    expect(matchesPathPattern(pattern, path)).toBe(expected);
  });
});

describe('pathPatternIssue', () => {
  it.each([
    ['', 'empty'],
    ['/abs/path', 'absolute'],
    ['a/./b', 'dot_segment'],
    ['a/../b', 'dot_segment'],
    ['a\\b', 'backslash'],
    ['a/**b', 'bad_glob'],
    ['x'.repeat(PATH_PATTERN_MAX + 1), 'too_long'],
  ])('refuses %s as %s', (pattern, issue) => {
    expect(pathPatternIssue(pattern)).toBe(issue);
  });

  it('accepts a normal pattern', () => {
    expect(pathPatternIssue('apps/**/db/*.ts')).toBeNull();
  });
});
