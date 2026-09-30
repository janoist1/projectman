import { describe, expect, it } from 'vitest';
import {
  hasGlobCharacter,
  isWithin,
  isWithinAny,
  looksLikePath,
  pathsIn,
  pathsInside,
  resolveWord,
} from '../src/domain/command-paths';

describe('command paths', () => {
  it('tells what lies inside a directory, by its text', () => {
    expect(isWithin('/work', '/work')).toBe(true);
    expect(isWithin('/work', '/work/a/b')).toBe(true);
    expect(isWithin('/work', '/work/..a')).toBe(true);
    expect(isWithin('/work', '/')).toBe(false);
    expect(isWithin('/work', '/elsewhere')).toBe(false);
    expect(isWithin('/work', '/work-other')).toBe(false);
    expect(isWithin('/work/a', '/work')).toBe(false);
    expect(isWithinAny(['/a', '/b'], '/b/c')).toBe(true);
    expect(isWithinAny(['/a', '/b'], '/c')).toBe(false);
    expect(isWithinAny([], '/a')).toBe(false);
  });

  it('resolves a word against a directory, and gives up where `..` could step out of a symbolic link', () => {
    expect(resolveWord('/w', 'a/b')).toBe('/w/a/b');
    expect(resolveWord('/w', './a/./b/')).toBe('/w/a/b');
    expect(resolveWord('/w', '.')).toBe('/w');
    expect(resolveWord('/w/x', '..')).toBe('/w');
    expect(resolveWord('/w/x', '../../y')).toBe('/y');
    expect(resolveWord('/w', '/abs/dir')).toBe('/abs/dir');
    expect(resolveWord('/w', '/../abs')).toBe('/abs');
    expect(resolveWord('/w', 'a/../b')).toBeNull();
    expect(resolveWord('/w', 'a/..')).toBeNull();
    expect(resolveWord('/w', './a/../b')).toBeNull();
    expect(resolveWord('/w', '/abs/../b')).toBeNull();
    expect(resolveWord('/w', 'a/b/../../c')).toBeNull();
  });

  it.each([
    ['a/b', true],
    ['/etc', true],
    ['./a', true],
    ['../a', true],
    ['.', true],
    ['..', true],
    ['HEAD:apps/web', true],
    ['a', false],
    ['...', false],
    ['a.b', false],
    ['-x', false],
    ['', false],
  ])('%j looks like a path: %s', (word, expected) => {
    expect(looksLikePath(word)).toBe(expected);
  });

  it.each([
    ['foo', []],
    ['a/b', ['a/b']],
    ['/etc/passwd', ['/etc/passwd']],
    ['.', ['.']],
    ['..', ['..']],
    ['-', []],
    ['--', []],
    ['-la', []],
    ['--root=apps/web', ['apps/web']],
    ['--root=/etc', ['/etc']],
    ['--root=apps', []],
    ['--include=*.ts', []],
    ['--format=%h/%s', ['%h/%s']],
    ['-f/etc/passwd', ['/etc/passwd']],
    ['-fsrc/x', ['/x']],
    ['-d/', []],
    ['-t/', []],
    ['-dd/', ['/']],
    ['-d//', ['//']],
    ['--file=-x/etc', ['-x/etc']],
    ['--dir/x=y/z', ['y/z', '/x']],
  ])('finds the paths in %j', (word, expected) => {
    expect(pathsIn(word)).toEqual(expected);
  });

  it('checks every path of a word from every directory it may run in', () => {
    const roots = ['/work'];
    expect(pathsInside('src/a.ts', ['/work'], roots)).toBe(true);
    expect(pathsInside('README.md', ['/elsewhere'], roots)).toBe(true);
    expect(pathsInside('--root=apps/web', ['/work', '/work/apps'], roots)).toBe(true);
    expect(pathsInside('../x', ['/work/a'], roots)).toBe(true);
    expect(pathsInside('../x', ['/work'], roots)).toBe(false);
    expect(pathsInside('../x', ['/work/a', '/work'], roots)).toBe(false);
    expect(pathsInside('/etc/passwd', ['/work'], roots)).toBe(false);
    expect(pathsInside('/work/src', ['/work'], roots)).toBe(true);
    expect(pathsInside('--file=/etc/passwd', ['/work'], roots)).toBe(false);
    expect(pathsInside('-f/etc/passwd', ['/work'], roots)).toBe(false);
    expect(pathsInside('a/../b', ['/work'], roots)).toBe(false);
  });

  it('recognises pattern characters', () => {
    for (const word of ['*', 'a?', '[a-z]', 'src/*.ts', 'a]'])
      expect(hasGlobCharacter(word), word).toBe(true);
    for (const word of ['a', 'a-b', 'a.b', 'a/b', '{}', '']) expect(hasGlobCharacter(word), word).toBe(false);
  });
});
