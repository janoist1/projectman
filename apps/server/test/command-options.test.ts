import { describe, expect, it } from 'vitest';
import { hasShortOption, namesOption, parseOptions } from '../src/domain/command-options';
import type { OptionList } from '../src/domain/command-options';

const list: OptionList = {
  letters: 'lrvi',
  valueLetters: 'ek',
  flags: ['--name-only', '--relative'],
  valueFlags: ['--glob', '--relative'],
  counts: true,
};

/** The options present (sorted) and the other words, or null. */
function parse(args: string[], options: OptionList = list) {
  const parsed = parseOptions(args, options);
  return parsed && { present: [...parsed.present].sort(), words: parsed.words };
}

describe('parseOptions', () => {
  it('splits options from the other words', () => {
    expect(parse([])).toEqual({ present: [], words: [] });
    expect(parse(['foo', 'src/a.ts'])).toEqual({ present: [], words: ['foo', 'src/a.ts'] });
    expect(parse(['-l', 'foo', '--name-only', 'src'])).toEqual({
      present: ['--name-only', '-l'],
      words: ['foo', 'src'],
    });
    expect(parse(['-', 'x'])).toEqual({ present: [], words: ['-', 'x'] });
  });

  it('reads short options that share a word', () => {
    expect(parse(['-rl'])).toEqual({ present: ['-l', '-r'], words: [] });
    expect(parse(['-rvil', 'x'])).toEqual({ present: ['-i', '-l', '-r', '-v'], words: ['x'] });
  });

  it('gives a short option with a value its attached letters or the next word', () => {
    expect(parse(['-e', 'pattern', 'file'])).toEqual({ present: ['-e'], words: ['file'] });
    expect(parse(['-epattern', 'file'])).toEqual({ present: ['-e'], words: ['file'] });
    expect(parse(['-k2,2'])).toEqual({ present: ['-k'], words: [] });
    // `-el` is the pattern `l`, not the option `-l`; `-e -l` is the pattern `-l`.
    expect(parse(['-el', 'file'])).toEqual({ present: ['-e'], words: ['file'] });
    expect(parse(['-rel', 'file'])).toEqual({ present: ['-e', '-r'], words: ['file'] });
    expect(parse(['-e', '-l', 'file'])).toEqual({ present: ['-e'], words: ['file'] });
    expect(parse(['-re', '-l'])).toEqual({ present: ['-e', '-r'], words: [] });
    expect(parse(['-e'])).toBeNull();
    expect(parse(['-re'])).toBeNull();
  });

  it('reads long options, with a value after `=` or in the next word', () => {
    expect(parse(['--glob=*.ts', 'x'])).toEqual({ present: ['--glob'], words: ['x'] });
    expect(parse(['--glob', '*.ts', 'x'])).toEqual({ present: ['--glob'], words: ['x'] });
    expect(parse(['--glob', '-l'])).toEqual({ present: ['--glob'], words: [] });
    expect(parse(['--glob'])).toBeNull();
    // An option that may have a value written `=value` only is a flag on its own.
    expect(parse(['--relative', 'main'])).toEqual({ present: ['--relative'], words: ['main'] });
    expect(parse(['--relative=apps', 'main'])).toEqual({ present: ['--relative'], words: ['main'] });
    expect(parse(['--name-only=x'])).toBeNull();
  });

  it('ends the options at `--`', () => {
    expect(parse(['-l', '--', '-x', '--glob', '-'])).toEqual({
      present: ['-l'],
      words: ['-x', '--glob', '-'],
    });
    expect(parse(['--'])).toEqual({ present: [], words: [] });
  });

  it('reads a line count only where the list allows one', () => {
    expect(parse(['-5'])).toEqual({ present: ['-N'], words: [] });
    expect(parse(['-12', 'x'])).toEqual({ present: ['-N'], words: ['x'] });
    expect(parse(['-5'], { ...list, counts: false })).toBeNull();
  });

  it.each([['-z'], ['-lz'], ['--other'], ['--other=1'], ['-=x'], ['-5x'], ['--Name-only'], ['-L']])(
    'refuses the option %s that is not in the list',
    (option) => {
      expect(parse([option])).toBeNull();
      expect(parse(['-l', 'word', option])).toBeNull();
    },
  );

  it('accepts no option at all from an empty list', () => {
    const none: OptionList = { letters: '', valueLetters: '', flags: [], valueFlags: [] };
    expect(parse(['a', 'b/c', '*.ts'], none)).toEqual({ present: [], words: ['a', 'b/c', '*.ts'] });
    expect(parse(['-a'], none)).toBeNull();
    expect(parse(['--all'], none)).toBeNull();
    expect(parse(['--', '-a'], none)).toEqual({ present: [], words: ['-a'] });
  });
});

describe('option names', () => {
  it('knows a long option by its full name or an abbreviation, with or without a value', () => {
    expect(namesOption('--output', '--output')).toBe(true);
    expect(namesOption('--output=x', '--output')).toBe(true);
    expect(namesOption('--out', '--output')).toBe(true);
    expect(namesOption('--o', '--output')).toBe(true);
    expect(namesOption('--o', '--output', 4)).toBe(false);
    expect(namesOption('--output-indicator-new', '--output')).toBe(false);
    expect(namesOption('--oops', '--output')).toBe(false);
    expect(namesOption('-o', '--output')).toBe(false);
    expect(namesOption('output', '--output')).toBe(false);
  });

  it('finds a letter in a short option cluster, not in a value or a long option', () => {
    expect(hasShortOption('-f', 'fF')).toBe(true);
    expect(hasShortOption('-nf', 'fF')).toBe(true);
    expect(hasShortOption('-ofile', 'o')).toBe(true);
    expect(hasShortOption('-n5', 'fF')).toBe(false);
    expect(hasShortOption('--follow', 'fF')).toBe(false);
    expect(hasShortOption('f', 'fF')).toBe(false);
    expect(hasShortOption('-', 'fF')).toBe(false);
  });
});
