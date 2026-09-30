import path from 'node:path';
import { hasShortOption, namesOption } from './command-options';
import {
  hasGlobCharacter,
  isWithinAny,
  pathsInside,
  resolveWord,
  withoutOwnDirectory,
} from './command-paths';
import type { ShellCommand, ShellStage } from './shell-words';
import { isXargsFeed } from './xargs-feed';

/**
 * Commands that only read: what a reviewer or any other AI member on a task runs constantly
 * (`git status`, `git diff --name-only main | xargs grep -n foo`, `ls`, `npm run typecheck`).
 * The server allows them without asking when every stage is a known reader used in a way that
 * cannot write, run another program or leave the directories the session may read.
 *
 * The check reads the command's text only. It cannot see what a symbolic link inside a directory
 * points at, and it takes the names a lister finds (`git ls-files | xargs …`, see `xargs-feed.ts`)
 * as they are. A session that may already write a file in its own worktree could use either, which
 * is why this rule is a convenience and not a sandbox.
 */

export interface ReadOnlyContext {
  /** The session's working directory, where the command starts. */
  cwd: string;
  /** The directories the command may read and change into. */
  roots: readonly string[];
}

/** A command that could end up in more directories than this is not followed. */
const MAX_DIRECTORIES = 16;

/** Whether a command's options are harmless; `args` are its words after the command name. */
type Rule = (args: readonly string[]) => boolean;

const allowAll: Rule = () => true;

function startsWithWords(args: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((word, i) => args[i] === word);
}

/* ---------- git ---------- */

const READ_ONLY_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'merge-base',
  'ls-files',
  'blame',
  'grep',
  'shortlog',
  'describe',
  'diff-tree',
  'name-rev',
  'cat-file',
  'branch',
]);
const CAT_FILE_OPTIONS = new Set(['-p', '-t', '-s', '-e']);
const BRANCH_OPTIONS = new Set(['--show-current', '-a', '-r', '-v', '-vv']);

const gitRule: Rule = (args) => {
  // The word after `git` must be the subcommand: no `-c`, `--git-dir`, `--work-tree`, … and no
  // `-C` but the one to the directory the command runs in, which `isReadOnlyStage` has dropped.
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || !READ_ONLY_GIT.has(subcommand)) return false;
  // `--output` writes the diff to a file; `--ext-diff` runs the configured external program.
  if (rest.some((arg) => arg.startsWith('--output') || namesOption(arg, '--ext-diff', 5))) return false;
  switch (subcommand) {
    case 'cat-file':
      // `-p`, `-t`, `-s` or `-e`, and no other option (`--batch`, `--textconv`, `--filters`, …).
      return (
        rest.some((arg) => CAT_FILE_OPTIONS.has(arg)) &&
        rest.every((arg) => !arg.startsWith('-') || CAT_FILE_OPTIONS.has(arg))
      );
    case 'branch':
      return isBranchListing(rest);
    case 'grep':
      // `-O` and `--open-files-in-pager` run a program with the matching files.
      return !rest.some((arg) => arg.startsWith('-O') || namesOption(arg, '--open-files-in-pager', 4));
    default:
      return true;
  }
};

/**
 * `git branch` that lists. A word without `--list` or `--contains` would create a branch (even
 * `git branch -v name` does), with them it is a pattern or the commit `--contains` asks for.
 */
function isBranchListing(args: readonly string[]): boolean {
  let lists = false;
  let words = 0;
  for (const arg of args) {
    if (arg === '--list' || arg === '-l' || arg === '--contains' || arg.startsWith('--contains=')) {
      lists = true;
    } else if (arg.startsWith('-')) {
      if (!BRANCH_OPTIONS.has(arg)) return false;
    } else {
      words += 1;
    }
  }
  return words === 0 || lists;
}

/* ---------- search, find and the file readers ---------- */

/** The ripgrep options that run a program of the caller's choice. */
const RG_PROGRAM_OPTIONS = ['--pre', '--pre-glob', '--hostname-bin'];
const rgRule: Rule = (args) =>
  !args.some((arg) => RG_PROGRAM_OPTIONS.some((option) => namesOption(arg, option)));

const tailRule: Rule = (args) =>
  // Following a file never ends, and would hang the session.
  !args.some((arg) => hasShortOption(arg, 'fF') || namesOption(arg, '--follow'));

const sortRule: Rule = (args) =>
  // `-o` and `--output` write the result to a file; `--compress-program` runs a program.
  !args.some(
    (arg) =>
      hasShortOption(arg, 'o') || namesOption(arg, '--output') || namesOption(arg, '--compress-program'),
  );

/** Options of `uniq` whose value is the next word. */
const UNIQ_VALUE_OPTIONS = new Set(['-f', '-s', '-w']);

/** `uniq [INPUT [OUTPUT]]`: a second word is a file it writes. */
const uniqRule: Rule = (args) => {
  let files = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') {
      files += args.length - i - 1;
      break;
    }
    if (UNIQ_VALUE_OPTIONS.has(arg)) {
      i += 1;
    } else if (!arg.startsWith('-') || arg === '-') {
      files += 1;
    }
  }
  return files <= 1;
};

const FIND_ACTIONS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);
const findRule: Rule = (args) => !args.some((arg) => FIND_ACTIONS.has(arg));

/** `file -C` compiles a magic file, which writes one. */
const fileRule: Rule = (args) =>
  !args.some((arg) => hasShortOption(arg, 'C') || namesOption(arg, '--compile', 4));

/**
 * The command `xargs` runs, and the texts `-I` names to be replaced in it, when its options only
 * shape the batches (`-0`, `-r`, `-n N`, `-L N`, `-I X`, `-d X`, `-P N`); `null` for any other
 * option, or when there is no command.
 */
function xargsCommand(args: readonly string[]): { command: string[]; replaced: string[] } | null {
  const replaced: string[] = [];
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    const flag = args[i]!;
    if (flag === '-0' || flag === '-r') {
      i += 1;
    } else if (flag === '-n' || flag === '-L' || flag === '-P') {
      if (!/^\d+$/.test(args[i + 1] ?? '')) return null;
      i += 2;
    } else if (/^-[nLP]\d+$/.test(flag) || /^-[Id][^-]/.test(flag)) {
      if (flag.startsWith('-I')) replaced.push(flag.slice(2));
      i += 1;
    } else if (flag === '-I' || flag === '-d') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) return null;
      if (flag === '-I') replaced.push(value);
      i += 2;
    } else {
      return null;
    }
  }
  const command = args.slice(i);
  return command.length > 0 ? { command, replaced } : null;
}

/** Commands whose options cannot write a file or run a program, whatever names end up there. */
const NAME_SAFE = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'ls',
  'stat',
  'du',
  'nl',
  'basename',
  'dirname',
  'realpath',
  'echo',
  'printf',
  'cut',
  'tr',
  'true',
  'pwd',
]);

/** Commands that may run under `xargs` once `--` ends their options, so that no name is taken for one. */
const NEEDS_DASHES = new Set(['git', 'rg', 'sort', 'diff']);

/**
 * `xargs` hands its names to a command as arguments, and a name that starts with a dash is an
 * option there: a file `--compress-program=./x` makes `sort` run `./x`, `--pre=./x` makes `rg`
 * run it on every file. So `xargs` runs only the commands whose options are harmless, or ones
 * that get the names after `--` (appended names follow a last word `--`; with `-I` they stand
 * where the placeholder is, and no word before the `--` starts with it).
 */
function isSafeWithNames(command: readonly string[], replaced: readonly string[]): boolean {
  const program = command[0]!;
  if (NAME_SAFE.has(program)) return true;
  if (!NEEDS_DASHES.has(program)) return false;
  if (replaced.length === 0) return command[command.length - 1] === '--';
  const dashes = command.indexOf('--');
  return command.every(
    (word, i) => (dashes >= 0 && i > dashes) || !replaced.some((text) => word.startsWith(text)),
  );
}

/** The positions after the program whose words name what `git`, `npm` and `npx` do. */
const NAMING_WORDS = new Map([
  ['git', [1]],
  ['npm', [1, 2]],
  ['npx', [1, 2]],
]);

/**
 * `-I X` puts each name in place of every `X` in the command, substrings and (on some systems)
 * the program included. The rules read the program, the options and the word that says what
 * `git`, `npm` or `npx` do as they are written, so none of them may hold an `X`: with `-I cat cat`
 * the names would decide what runs.
 */
function isRewritten(command: readonly string[], replaced: readonly string[]): boolean {
  const naming = NAMING_WORDS.get(command[0]!) ?? [];
  return command.some(
    (word, i) =>
      (i === 0 || word.startsWith('-') || naming.includes(i)) && replaced.some((text) => word.includes(text)),
  );
}

/* ---------- the project's own checks ---------- */

const npmRule: Rule = (args) =>
  [['test'], ['run', 'test'], ['run', 'typecheck']].some((prefix) => startsWithWords(args, prefix));

/** `npx vitest run`, `npx tsc --noEmit` and `npx prettier --check`, none of them updating or writing. */
const npxRule: Rule = (args) => {
  if (startsWithWords(args, ['vitest', 'run']))
    return !args.some((arg) => arg === '-u' || arg === '--update');
  if (startsWithWords(args, ['prettier', '--check']))
    return !args.some((arg) => arg === '-w' || arg === '--write');
  return startsWithWords(args, ['tsc', '--noEmit']);
};

const RULES = new Map<string, Rule>([
  ['git', gitRule],
  ['grep', allowAll],
  ['rg', rgRule],
  ['tail', tailRule],
  ['sort', sortRule],
  ['uniq', uniqRule],
  ['find', findRule],
  ['file', fileRule],
  ['npm', npmRule],
  ['npx', npxRule],
  // The shell's `printf -v NAME` assigns a variable (even PATH) for the commands that follow.
  ['printf', (args) => !args[0]?.startsWith('-v')],
]);
for (const name of [
  'cat',
  'head',
  'wc',
  'ls',
  'pwd',
  'echo',
  'cut',
  'tr',
  'nl',
  'stat',
  'du',
  'diff',
  'basename',
  'dirname',
  'realpath',
  'true',
]) {
  RULES.set(name, allowAll);
}

/** An option whose name is a pattern (`-[f]`) could expand to a file named like a forbidden option. */
function hasPatternOption(args: readonly string[]): boolean {
  return args.some((arg) => arg.startsWith('-') && hasGlobCharacter(arg.split('=', 1)[0]!));
}

/**
 * Whether one command (its words) is a known reader whose options cannot write or run another
 * program, and every path in it stays inside `roots` from each directory it may run in. `cd`
 * and `xargs` are not readers of their own: `isReadOnlyCommand` follows the first, and
 * `isReadOnlyPipeline` the second.
 *
 * A `git -C <dir>` counts as plain `git` when `<dir>` is each of `dirs` itself, the directories
 * the command runs in; any other `-C` is an option the rule does not know.
 */
export function isReadOnlyStage(
  words: readonly string[],
  dirs: readonly string[],
  roots: readonly string[],
): boolean {
  return isReader(withoutOwnDirectory(words, dirs), dirs, roots);
}

/** `isReadOnlyStage` for the words exactly as they are, with no `-C` dropped. */
function isReader(words: readonly string[], dirs: readonly string[], roots: readonly string[]): boolean {
  const [program, ...args] = words;
  const rule = program === undefined ? undefined : RULES.get(program);
  if (!rule || hasPatternOption(args) || !rule(args)) return false;
  return args.every((arg) => pathsInside(arg, dirs, roots));
}

/**
 * Whether every stage of a pipeline is a reader. An `xargs` counts as one when it is the first in
 * its pipeline, preceded by a lister and whole-line filters only (`xargs-feed.ts`), and runs a
 * reader of its own. A second `xargs` is no reader, and an `xargs` with nothing before it has
 * no lister, so both refuse the pipeline.
 */
function isReadOnlyPipeline(
  stages: readonly ShellStage[],
  dirs: readonly string[],
  roots: readonly string[],
): boolean {
  const reader = (words: readonly string[]) => isReadOnlyStage(words, dirs, roots);
  const at = stages.findIndex((stage) => stage.words[0] === 'xargs');
  if (at < 0) return stages.every((stage) => reader(stage.words));
  const run = xargsCommand(stages[at]!.words.slice(1));
  if (!run || isRewritten(run.command, run.replaced) || !isSafeWithNames(run.command, run.replaced))
    return false;
  if (!isXargsFeed(stages.slice(0, at).map((stage) => stage.words))) return false;
  // What `xargs` runs is read as written, with no `-C` dropped: with `-I` a name could take the
  // place of the directory word, or of the subcommand behind it, and the checks above look at
  // neither.
  return stages.every((stage, i) => (i === at ? isReader(run.command, dirs, roots) : reader(stage.words)));
}

/**
 * Where `cd <dir>` leads from each of `dirs`: the target resolved against each one. `null` when
 * the segment is not a plain `cd <dir>` or a target lies outside `roots`.
 */
function changeDirectory(
  stage: ShellStage,
  dirs: readonly string[],
  roots: readonly string[],
): string[] | null {
  const target = stage.words[1];
  if (stage.redirections.length > 0 || stage.words.length !== 2 || !target) return null;
  if (target.startsWith('-') || hasGlobCharacter(target)) return null;
  const moved: string[] = [];
  for (const dir of dirs) {
    const resolved = resolveWord(dir, target);
    if (resolved === null || !isWithinAny(roots, resolved)) return null;
    moved.push(resolved);
  }
  return moved;
}

/**
 * Whether every command of `command` only reads, from the working directory or from another
 * directory it changes into, all of them inside `roots`. Segments and pipes may be combined
 * freely; redirections are limited to the ones the parser knows (`2>&1`, `>/dev/null`, …).
 *
 * A `cd` segment changes the directory of the segments after it, but only for certain while
 * every separator so far is `&&`: then a segment runs only after each `cd` before it
 * succeeded. After a `;` or `||` a segment may also run because a `cd` failed or was skipped, so
 * it is checked from every directory the command could be in by then.
 */
export function isReadOnlyCommand(command: ShellCommand, context: ReadOnlyContext): boolean {
  const roots = context.roots.filter((root) => path.isAbsolute(root)).map((root) => path.resolve(root));
  if (!path.isAbsolute(context.cwd)) return false;
  const start = path.resolve(context.cwd);
  if (!isWithinAny(roots, start)) return false;
  /** The directory while every separator so far is `&&`. */
  let exact = start;
  /** Every directory the command has been in or may be in. */
  const seen = new Set([start]);
  let certain = true;
  for (const [index, segment] of command.segments.entries()) {
    if (index > 0 && command.separators[index - 1] !== '&&') certain = false;
    const dirs = certain ? [exact] : [...seen];
    const [stage] = segment.stages;
    if (segment.stages.length === 1 && stage?.words[0] === 'cd') {
      const moved = changeDirectory(stage, dirs, roots);
      if (!moved) return false;
      for (const dir of moved) seen.add(dir);
      if (seen.size > MAX_DIRECTORIES) return false;
      if (certain) exact = moved[0]!;
    } else if (!isReadOnlyPipeline(segment.stages, dirs, roots)) {
      return false;
    }
  }
  return true;
}
