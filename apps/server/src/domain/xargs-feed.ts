import { namesOption, parseOptions } from './command-options';
import type { OptionList, ParsedOptions } from './command-options';

/**
 * What may feed `xargs`. The words `xargs` reads become arguments of the command it runs, so
 * text that any command can make up must not reach it: what `echo`, `printf` or `cat` of a file
 * the developer wrote print, what `git log --format` or `find -printf` are told to print, and
 * pieces `grep -o`, `cut` or `tail -c` cut out of a longer name (`x/home/x/.ssh/id_rsa` becomes
 * `/home/x/.ssh/id_rsa`). The read-only rule therefore allows `xargs` only in a pipeline that
 *   1. starts with a lister, a command that prints nothing but names it found;
 *   2. goes on with whole-line filters that read those names from standard input and take no
 *      file arguments;
 *   3. has exactly one `xargs`, which may be followed by any other reader.
 *
 * Every option of a lister or a filter is looked up in a list of the ones known to leave the
 * output a list of names (or of the input lines). An option nobody thought of refuses the
 * pipeline instead of feeding it: `grep -el file` prints lines, because `-e` takes `l` as its
 * pattern, and `git grep -l --no-files-with-matches` prints lines, because the second option
 * switches the first off.
 *
 * What stays open: the names themselves are taken as found. A file whose path holds a blank (or
 * a newline) followed by a slash makes `xargs` without `-0` see an absolute path.
 */

type Check = (args: readonly string[]) => boolean;

const NO_OPTIONS: OptionList = { letters: '', valueLetters: '', flags: [], valueFlags: [] };

/* ---------- listers: the first stage ---------- */

const GIT_DIFF_OPTIONS: OptionList = {
  letters: 'zMCR',
  valueLetters: '',
  flags: [
    '--name-only',
    '--name-status',
    '--cached',
    '--staged',
    '--no-renames',
    '--merge-base',
    '--relative',
    '--find-renames',
    '--find-copies',
  ],
  valueFlags: ['--diff-filter', '--relative', '--find-renames', '--find-copies'],
};

const GIT_GREP_OPTIONS: OptionList = {
  letters: 'lLniIhwvaFEGPz',
  valueLetters: 'ef',
  flags: [
    '--name-only',
    '--files-with-matches',
    '--files-without-match',
    '--no-index',
    '--untracked',
    '--cached',
    '--exclude-standard',
    '--recurse-submodules',
    '--full-name',
    '--ignore-case',
    '--word-regexp',
    '--invert-match',
    '--fixed-strings',
    '--extended-regexp',
    '--basic-regexp',
    '--perl-regexp',
    '--null',
    '--and',
    '--or',
    '--not',
  ],
  valueFlags: [],
};

const GREP_OPTIONS: OptionList = {
  letters: 'lLrRiIEFGPwxvsaUzZnHh',
  valueLetters: 'ef',
  flags: [
    '--files-with-matches',
    '--files-without-match',
    '--recursive',
    '--dereference-recursive',
    '--ignore-case',
    '--extended-regexp',
    '--fixed-strings',
    '--basic-regexp',
    '--perl-regexp',
    '--word-regexp',
    '--line-regexp',
    '--invert-match',
    '--no-messages',
    '--text',
    '--null',
    '--null-data',
  ],
  valueFlags: ['--include', '--exclude', '--exclude-dir', '--regexp', '--file', '--exclude-from'],
};

const RG_OPTIONS: OptionList = {
  letters: 'lisSwxvFuH0.',
  valueLetters: 'gteT',
  flags: [
    '--files',
    '--files-with-matches',
    '--files-without-match',
    '--hidden',
    '--no-ignore',
    '--follow',
    '--null',
    '--ignore-case',
    '--smart-case',
    '--case-sensitive',
    '--word-regexp',
    '--line-regexp',
    '--invert-match',
    '--fixed-strings',
    '--no-messages',
  ],
  valueFlags: ['--glob', '--iglob', '--type', '--type-not', '--max-depth', '--sort', '--sortr', '--regexp'],
};

/**
 * `find` actions that print what the caller writes, and a listing that holds link targets. (The
 * two that write a file, `-fprintf` and `-fls`, are refused for every `find` already.)
 */
const FIND_TEXT_ACTIONS = new Set(['-printf', '-fprintf', '-ls', '-fls']);

/** The options are known and one of them makes the command print names only. */
function printsNames(parsed: ParsedOptions | null, options: readonly string[]): boolean {
  return parsed !== null && options.some((option) => parsed.present.has(option));
}

const LISTERS = new Map<string, Check>([
  [
    'git',
    (args) => {
      const [subcommand, ...rest] = args;
      switch (subcommand) {
        case 'diff':
          return printsNames(parseOptions(rest, GIT_DIFF_OPTIONS), ['--name-only', '--name-status']);
        case 'ls-files':
          // `--format` prints what the caller writes, and git takes abbreviations of it.
          return !rest.some((arg) => namesOption(arg, '--format'));
        case 'grep':
          return printsNames(parseOptions(rest, GIT_GREP_OPTIONS), [
            '-l',
            '-L',
            '--name-only',
            '--files-with-matches',
            '--files-without-match',
          ]);
        default:
          return false;
      }
    },
  ],
  [
    'grep',
    (args) =>
      printsNames(parseOptions(args, GREP_OPTIONS), [
        '-l',
        '-L',
        '--files-with-matches',
        '--files-without-match',
      ]),
  ],
  [
    'rg',
    (args) =>
      printsNames(parseOptions(args, RG_OPTIONS), [
        '-l',
        '--files',
        '--files-with-matches',
        '--files-without-match',
      ]),
  ],
  ['find', (args) => !args.some((arg) => FIND_TEXT_ACTIONS.has(arg))],
  // Plain `ls`: `-l` shows where a link leads, `-a` lists `..`, `-R` prints directory names.
  ['ls', (args) => parseOptions(args, NO_OPTIONS) !== null],
]);

/* ---------- filters: between the lister and xargs ---------- */

const GREP_FILTER_OPTIONS: OptionList = {
  letters: 'EFGPiwxvh',
  valueLetters: 'e',
  flags: [
    '--extended-regexp',
    '--fixed-strings',
    '--basic-regexp',
    '--perl-regexp',
    '--ignore-case',
    '--word-regexp',
    '--line-regexp',
    '--invert-match',
    '--no-filename',
  ],
  valueFlags: ['--regexp'],
};
/** `-n 5`, `-n5` and `-5`; not `-c`, which cuts a name at a byte. */
const LINE_FILTER_OPTIONS: OptionList = {
  letters: '',
  valueLetters: 'n',
  flags: [],
  valueFlags: [],
  counts: true,
};
const SORT_FILTER_OPTIONS: OptionList = {
  letters: 'bdfghiMnRrVusz',
  valueLetters: 'ktS',
  flags: [],
  valueFlags: [],
};
const UNIQ_FILTER_OPTIONS: OptionList = { letters: 'cdDiuz', valueLetters: 'fsw', flags: [], valueFlags: [] };

/** A filter takes no file: every word it has is a pattern, and only when no `-e` names one. */
function readsStandardInput(args: readonly string[], options: OptionList, patterns: number): boolean {
  const parsed = parseOptions(args, options);
  const named = parsed?.present.has('-e') || parsed?.present.has('--regexp');
  return parsed !== null && parsed.words.length === (named ? 0 : patterns);
}

const lineFilter: Check = (args) => readsStandardInput(args, LINE_FILTER_OPTIONS, 0);

const FILTERS = new Map<string, Check>([
  // `-o` and `-r`, `-H`, `-n`, `-Z` and `--label` would print pieces of lines, other files or text of their own.
  ['grep', (args) => readsStandardInput(args, GREP_FILTER_OPTIONS, 1)],
  ['head', lineFilter],
  ['tail', lineFilter],
  ['sort', (args) => readsStandardInput(args, SORT_FILTER_OPTIONS, 0)],
  ['uniq', (args) => readsStandardInput(args, UNIQ_FILTER_OPTIONS, 0)],
]);

function passes(checks: ReadonlyMap<string, Check>, words: readonly string[]): boolean {
  const [program, ...args] = words;
  const check = program === undefined ? undefined : checks.get(program);
  return check !== undefined && check(args);
}

/**
 * Whether the stages before an `xargs` (the words of each) are a lister followed by whole-line
 * filters. Whether each of them is an allowed reader is for the caller to check as well.
 */
export function isXargsFeed(stages: readonly (readonly string[])[]): boolean {
  const [lister, ...filters] = stages;
  return lister !== undefined && passes(LISTERS, lister) && filters.every((words) => passes(FILTERS, words));
}
