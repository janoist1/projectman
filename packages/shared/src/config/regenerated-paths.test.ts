import { describe, expect, it } from 'vitest';
import {
  isRegeneratedPath,
  isRegeneratedPathPattern,
  isRegeneratedWriteDir,
  regeneratedWriteDirs,
} from './regenerated-paths';
import { ReviewTestConfig } from './schema';

describe('isRegeneratedPathPattern', () => {
  it.each([
    ['a literal path', 'docs/GENERATED.md'],
    ['a glob below a literal directory', 'apps/server/src/context/__snapshots__/**'],
    ['a dot directory below a literal one', 'docs/.generated/*.yml'],
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
    ['a single segment', 'GENERATED.md'],
    ['a path under .git', '.git/hooks/**'],
    ['a path under .github', '.github/workflows/*.yml'],
    ['a git settings file, in any case', '.GitAttributes/x'],
    ['a hook directory', '.husky/pre-commit'],
    ['node_modules', 'node_modules/gen/**'],
    ['node_modules below a directory', 'gen/node_modules/*.js'],
    ['a dot first segment', '.generated/gen/*.yml'],
    ['a git name below a directory', 'gen/.git/config'],
  ])('refuses %s', (_name, pattern) => {
    expect(isRegeneratedPathPattern(pattern)).toBe(false);
  });
});

describe('regeneratedWriteDirs', () => {
  it.each([
    ['a glob below a directory', ['apps/server/__snapshots__/**'], ['apps/server/__snapshots__']],
    ['a wildcard in a later segment', ['gen/*/out/x.snap'], ['gen']],
    ['a literal path: its directory', ['docs/api/GENERATED.md'], ['docs/api']],
    ['a wildcard file name', ['gen/*.snap'], ['gen']],
    ['the same directory once', ['gen/*.snap', 'gen/**'], ['gen']],
    ['a directory inside another: the outer one', ['gen/sub/*.snap', 'gen/*.txt'], ['gen']],
  ])('is the literal leading directories of %s', (_name, patterns, dirs) => {
    expect(regeneratedWriteDirs(patterns)).toEqual(dirs);
    expect(dirs.every(isRegeneratedWriteDir)).toBe(true);
  });

  it('is null when a pattern is not valid', () => {
    expect(regeneratedWriteDirs(['gen/**', '.git/hooks/**'])).toBeNull();
  });

  it.each(['gen/*', '/abs', 'a/../b', '.git', '.github', 'node_modules', '.hidden/x', ''])(
    'refuses %j as a writable directory',
    (dir) => {
      expect(isRegeneratedWriteDir(dir)).toBe(false);
    },
  );
});

describe('isRegeneratedPath', () => {
  it.each(['gen/a.snap', 'a/b/c.txt', '.eslintcache'])('accepts %s', (path) => {
    expect(isRegeneratedPath(path)).toBe(true);
  });

  it.each(['', '/etc/x', 'a//b', 'a/../b', 'a/./b', 'gen/.gitattributes', '.husky/x', 'a/node_modules/x'])(
    'refuses %j',
    (path) => {
      expect(isRegeneratedPath(path)).toBe(false);
    },
  );
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
