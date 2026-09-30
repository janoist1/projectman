import { describe, expect, it } from 'vitest';
import {
  hasGlobCharacter,
  isWithin,
  isWithinAny,
  looksLikePath,
  namesDirectory,
  pathsIn,
  pathsInside,
  resolveWord,
  withoutOwnDirectory,
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

  // Before bash 5.2 (macOS ships 3.2) `.*` and `.?` also match `.` and `..`.
  it.each([
    '.*',
    '.?',
    '..*',
    '.[a-z]*',
    '.h*',
    'src/.*',
    '.*/x',
    '.*/.*/x',
    './.*',
    '/w/.*',
    'a/.b?/c',
    '.git*',
  ])('gives up on the pattern component that starts with a dot in %j', (word) => {
    expect(resolveWord('/w', word)).toBeNull();
  });

  it.each([
    ['*', '/w/*'],
    ['*.ts', '/w/*.ts'],
    ['src/*', '/w/src/*'],
    ['src/**/*.ts', '/w/src/**/*.ts'],
    ['a?', '/w/a?'],
    ['[a-c]x', '/w/[a-c]x'],
    ['[.]*', '/w/[.]*'],
    ['.gitignore', '/w/.gitignore'],
    ['.github/*', '/w/.github/*'],
    ['src/.hidden/x', '/w/src/.hidden/x'],
    ['a.*', '/w/a.*'],
  ])('keeps the pattern in %j, which cannot start with a dot', (word, resolved) => {
    expect(resolveWord('/w', word)).toBe(resolved);
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
    // A plain word with a pattern character names places too, wherever it is and whatever it starts with.
    ['*', ['*']],
    ['*.ts', ['*.ts']],
    ['.*', ['.*']],
    ['.?', ['.?']],
    ['a?', ['a?']],
    ['[a-c]x', ['[a-c]x']],
    ['src/*', ['src/*']],
    ['%s]', []],
    // An option with a pattern is not a path (the shell expands the whole word, not its value).
    ['--glob=*.ts', []],
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

  it('checks a pattern word as a path, and refuses one that may match `.` or `..`', () => {
    const roots = ['/work'];
    expect(pathsInside('*.ts', ['/work'], roots)).toBe(true);
    expect(pathsInside('src/*', ['/work'], roots)).toBe(true);
    expect(pathsInside('../*', ['/work/a'], roots)).toBe(true);
    expect(pathsInside('../*', ['/work'], roots)).toBe(false);
    expect(pathsInside('/etc/*', ['/work'], roots)).toBe(false);
    expect(pathsInside('.*', ['/work'], roots)).toBe(false);
    expect(pathsInside('.?', ['/work'], roots)).toBe(false);
    expect(pathsInside('src/.*', ['/work'], roots)).toBe(false);
    expect(pathsInside('.*/.*/x', ['/work'], roots)).toBe(false);
    expect(pathsInside('.gitignore', ['/work'], roots)).toBe(true);
    expect(pathsInside('--include=.*', ['/work'], roots)).toBe(true);
  });

  it.each([
    ['.', true],
    ['./', true],
    ['./.', true],
    ['/work', true],
    ['/work/', true],
    ['/work/.', true],
    // However it is spelled: a leading `..` that leads back in is the same directory.
    ['../work', true],
    ['', false],
    ['..', false],
    ['a', false],
    ['./a', false],
    ['/work/a', false],
    ['/', false],
    ['/elsewhere', false],
    ['/work-other', false],
    ['/work/..', false],
    ['/work/a/..', false],
    ['work', false],
    // A pattern may expand to another name, and `.*` may match `..`.
    ['*', false],
    ['.*', false],
    ['[.]', false],
    ['/wor?', false],
    ['/work*', false],
  ])('%j names the directory /work it runs in: %s', (word, expected) => {
    expect(namesDirectory('/work', word)).toBe(expected);
  });

  it('names a directory that holds a pattern character only by a word without one', () => {
    expect(namesDirectory('/work/[x]', '.')).toBe(true);
    expect(namesDirectory('/work/[x]', '/work/[x]')).toBe(false);
  });

  it('drops a leading `git -C` to each directory the command runs in', () => {
    const log = ['git', 'log', '-1'];
    expect(withoutOwnDirectory(['git', '-C', '.', 'log', '-1'], ['/work'])).toEqual(log);
    expect(withoutOwnDirectory(['git', '-C', '/work', 'log', '-1'], ['/work'])).toEqual(log);
    expect(withoutOwnDirectory(['git', '-C', './', 'log', '-1'], ['/work/'])).toEqual(log);
    // Every directory it may run in must be the one the word names: `.` is each of them.
    expect(withoutOwnDirectory(['git', '-C', '.', 'log', '-1'], ['/work', '/work/a'])).toEqual(log);
    expect(withoutOwnDirectory(['git', '-C', '/work', 'log', '-1'], ['/work', '/work/a'])).toEqual([
      'git',
      '-C',
      '/work',
      'log',
      '-1',
    ]);
    expect(withoutOwnDirectory(['git', '-C', '/work', 'log', '-1'], ['/work', '/work'])).toEqual(log);
  });

  it('leaves every other spelling as it is', () => {
    for (const words of [
      ['git', '-C', '/elsewhere', 'log'],
      ['git', '-C', 'a', 'log'],
      ['git', '-C', '..', 'log'],
      ['git', '-C', '', 'log'],
      ['git', '-C', '.*', 'log'],
      ['git', '-C', '*', 'log'],
      ['git', '-C'],
      ['git', '-c', 'x=y', 'log'],
      ['git', '--git-dir=.git', 'log'],
      ['git', '--work-tree=.', 'log'],
      ['git', '-C.', 'log'],
      ['git', 'log', '-C', '.'],
      ['npm', '-C', '.', 'ci'],
      ['env', 'git', '-C', '.', 'log'],
      ['git'],
      [],
    ])
      expect(withoutOwnDirectory(words, ['/work']), words.join(' ')).toEqual(words);
    // Only the first `-C` goes: a second one stays, for the rule that follows to refuse.
    expect(withoutOwnDirectory(['git', '-C', '.', '-C', '/elsewhere', 'log'], ['/work'])).toEqual([
      'git',
      '-C',
      '/elsewhere',
      'log',
    ]);
    // No directory, no claim.
    expect(withoutOwnDirectory(['git', '-C', '.', 'log'], [])).toEqual(['git', '-C', '.', 'log']);
  });

  it('recognises pattern characters', () => {
    for (const word of ['*', 'a?', '[a-z]', 'src/*.ts', '.*', 'a['])
      expect(hasGlobCharacter(word), word).toBe(true);
    for (const word of ['a', 'a-b', 'a.b', 'a/b', '{}', 'a]', ''])
      expect(hasGlobCharacter(word), word).toBe(false);
  });
});
