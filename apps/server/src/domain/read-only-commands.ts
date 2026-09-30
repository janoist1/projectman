import path from 'node:path';
import { hasGlobCharacter, isWithinAny, pathsInside, resolveWord } from './command-paths';
import type { ShellCommand, ShellStage } from './shell-words';

/**
 * Commands that only read: what a reviewer or any other AI member on a task runs constantly
 * (`git status`, `git diff --name-only main | xargs grep -n foo`, `ls`, `npm run typecheck`).
 * The server allows them without asking when every stage is a known reader used in a way that
 * cannot write, run another program or leave the directories the session may read.
 *
 * The check reads the command's text only. It cannot see what the shell expands a glob to, what
 * a symbolic link inside a directory points at, or what the data flowing through a pipe names
 * (`xargs` reads file names from its input); a session that may already write a file in its own
 * worktree could use any of those, which is why this rule is a convenience and not a sandbox.
 */

export interface ReadOnlyContext {
  /** The session's working directory, where the command starts. */
  cwd: string;
  /** The directories the command may read and change into. */
  roots: readonly string[];
}

/** A command that could end up in more directories than this is not followed. */
const MAX_DIRECTORIES = 16;

type Nested = (words: readonly string[]) => boolean;
/** Whether a command's options are harmless; `args` are its words after the command name. */
type Rule = (args: readonly string[], nested: Nested) => boolean;

const allowAll: Rule = () => true;

/**
 * `arg` is the long option `name`, or an abbreviation of it (`getopt_long` tools accept any
 * unambiguous one), with or without a `=value`.
 */
function namesOption(arg: string, name: string, minLength = 3): boolean {
  if (!arg.startsWith('--')) return false;
  const given = arg.split('=', 1)[0]!;
  return given.length >= minLength && name.startsWith(given);
}

/** A short option cluster (`-nr`, `-ofile`) that includes one of `letters`. */
function hasShortOption(arg: string, letters: string): boolean {
  if (!arg.startsWith('-') || arg.startsWith('--')) return false;
  const run = /^[A-Za-z]*/.exec(arg.slice(1))![0];
  return [...run].some((letter) => letters.includes(letter));
}

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
  // The word after `git` must be the subcommand: no `-C`, `-c`, `--git-dir`, `--work-tree`, …
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

/** `xargs` with the options that only shape the batches, then a command that is allowed itself. */
const xargsRule: Rule = (args, nested) => {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    const flag = args[i]!;
    if (flag === '-0' || flag === '-r') {
      i += 1;
    } else if (flag === '-n' || flag === '-L' || flag === '-P') {
      if (!/^\d+$/.test(args[i + 1] ?? '')) return false;
      i += 2;
    } else if (/^-[nLP]\d+$/.test(flag) || /^-[Id][^-]/.test(flag)) {
      i += 1;
    } else if (flag === '-I' || flag === '-d') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) return false;
      i += 2;
    } else {
      return false;
    }
  }
  const inner = args.slice(i);
  return inner.length > 0 && inner[0] !== 'xargs' && nested(inner);
};

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
  ['xargs', xargsRule],
  ['npm', npmRule],
  ['npx', npxRule],
]);
for (const name of [
  'cat',
  'head',
  'wc',
  'ls',
  'pwd',
  'echo',
  'printf',
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

/**
 * Whether one command (its words) is a known reader whose options cannot write or run another
 * program, and every path in it stays inside `roots` from each directory it may run in.
 */
function isReadOnlyStage(
  words: readonly string[],
  dirs: readonly string[],
  roots: readonly string[],
): boolean {
  const [program, ...args] = words;
  const rule = program === undefined ? undefined : RULES.get(program);
  if (!rule) return false;
  // An option whose name is a pattern (`-[f]`) could expand to a file named like a forbidden one.
  if (args.some((arg) => arg.startsWith('-') && hasGlobCharacter(arg.split('=', 1)[0]!))) return false;
  if (!rule(args, (inner) => isReadOnlyStage(inner, dirs, roots))) return false;
  return args.every((arg) => pathsInside(arg, dirs, roots));
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
    } else if (!segment.stages.every((each) => isReadOnlyStage(each.words, dirs, roots))) {
      return false;
    }
  }
  return true;
}
