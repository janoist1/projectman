import path from 'node:path';
import { isWithin, namesDirectory, resolveWord, withoutOwnDirectory } from './command-paths';
import { isReadOnlyCommand } from './read-only-commands';
import type { ShellCommand, ShellSegment } from './shell-words';

/**
 * The routine steps of a developer in the task's own worktree, which the server allows without
 * asking (PM-77, PM-109): a lockfile install, formatting, `git add`, `git commit` with a message and a fast-forward
 * `git merge`. Codex's sandbox may write the repository's `.git` (the session makes it a writable
 * root), so the git steps run there on their own; the install needs the network, which is an
 * escalation for Codex members. Nothing here pushes, rewrites history or leaves the worktree.
 * Read-only commands may sit between them (`git status && git add -A && git commit -m x`).
 */

export const INSTALL_FLAGS = new Set(['--prefer-offline', '--no-audit', '--no-fund']);
export const FORMAT_WRITE_FLAGS = new Set(['--write', '-w']);
export const ADD_FLAGS = new Set(['-A', '--all', '-u', '--update']);
export const COMMIT_FLAGS = new Set(['-a', '--all', '-q', '--quiet']);
/** Options that take the commit message as the next word. */
const COMMIT_MESSAGE_FLAGS = new Set(['-m', '-am', '--message']);
export const MERGE_FLAGS = new Set(['-q', '--quiet']);
const COMMIT_ID = /^[0-9a-f]{7,40}$/i;

export interface WorktreeRoutineContext {
  /** The session's working directory: the task's worktree. */
  cwd: string;
  /** The task repository's default branch, when it is configured. */
  defaultBranch: string | undefined;
}

/**
 * Whether the command is an optional `cd` to the working directory followed by steps, joined
 * with `&&`, `||` or `;`. Each step is judged on its own, and the directory never changes: the
 * only `cd` is the first segment, and it stays in place.
 * - A routine step is one command, which may be followed by a pipe into readers that only filter
 *   its output (`| tail -3`) and carry the redirections the parser knows (`2>&1`).
 * - A read-only step may be a whole pipeline with the redirections the parser knows; the rule
 *   for reading checks it with the working directory as the only directory it may read.
 * At least one step is routine; a chain of readers alone is for the read-only rule.
 */
export function isWorktreeRoutine(command: ShellCommand, context: WorktreeRoutineContext): boolean {
  const root = path.resolve(context.cwd);
  const steps = [...command.segments];
  const [first] = steps;
  if (first && isChangeDirectory(first)) {
    if (!staysInPlace(first, context.cwd)) return false;
    steps.shift();
  }
  let routine = false;
  for (const step of steps) {
    // Any other `cd` could leave the directory the rest of the chain is checked in.
    if (isChangeDirectory(step)) return false;
    if (isRoutinePipeline(step, context, root)) {
      routine = true;
    } else if (!isReadOnlyCommand({ segments: [step], separators: [] }, { cwd: root, roots: [root] })) {
      return false;
    }
  }
  return routine;
}

/**
 * A routine step that is the first stage of its pipeline, with the redirections the parser knows,
 * and only readers after it (`npm install 2>&1 | tail -3`, PM-105). Filtering the output of a
 * step changes nothing it does; a `tee` or any other writer after it is no reader, so it waits for
 * a human. A routine step in any later stage of a pipeline is not routine either.
 */
function isRoutinePipeline(segment: ShellSegment, context: WorktreeRoutineContext, root: string): boolean {
  const [first, ...rest] = segment.stages;
  if (!first || !isRoutineStep(first.words, context)) return false;
  return (
    rest.length === 0 ||
    isReadOnlyCommand({ segments: [{ stages: rest }], separators: [] }, { cwd: root, roots: [root] })
  );
}

/** The words of a segment that is one command: no pipe, no redirection (for `cd`). */
function singleCommand(segment: ShellSegment): readonly string[] | null {
  const [stage] = segment.stages;
  return segment.stages.length === 1 && stage && stage.redirections.length === 0 ? stage.words : null;
}

/** A segment that is one command starting with `cd`, with or without redirections. */
function isChangeDirectory(segment: ShellSegment): boolean {
  return segment.stages.length === 1 && segment.stages[0]?.words[0] === 'cd';
}

/** `cd <dir>` where the directory is the working directory itself, however it is spelled. */
function staysInPlace(segment: ShellSegment, cwd: string): boolean {
  const words = singleCommand(segment);
  return words !== null && words.length === 2 && namesDirectory(cwd, words[1]!);
}

function isRoutineStep(words: readonly string[], context: WorktreeRoutineContext): boolean {
  // A `-C` to the working directory changes nothing, and the rest is judged as if it were absent.
  // The word after `git` must then be the subcommand: `git -C dir …` to another directory, a second
  // `-C`, `git -c key=value …`, `--git-dir` and `--work-tree` are not routine.
  const [program, subcommand, ...args] = withoutOwnDirectory(words, [context.cwd]);
  if (program === 'npm') {
    if (subcommand === 'run' && args.length === 1 && args[0] === 'format') return true;
    return (subcommand === 'ci' || subcommand === 'install') && args.every((flag) => INSTALL_FLAGS.has(flag));
  }
  if (program === 'npx' && subcommand === 'prettier') return isFormatting(args, context.cwd);
  if (program !== 'git') return false;
  switch (subcommand) {
    case 'add':
      return isAdd(args, context.cwd);
    case 'commit':
      return isCommit(args);
    case 'merge':
      return isFastForwardMerge(args, context.defaultBranch);
    default:
      return false;
  }
}

/** Prettier writing explicitly named paths inside the worktree, with no other options. */
function isFormatting(args: readonly string[], cwd: string): boolean {
  const root = path.resolve(cwd);
  let writes = false;
  let paths = 0;
  let onlyPaths = false;
  for (const arg of args) {
    if (!onlyPaths && FORMAT_WRITE_FLAGS.has(arg)) {
      writes = true;
    } else if (!onlyPaths && arg === '--') {
      onlyPaths = true;
    } else {
      if (arg === '' || (!onlyPaths && arg.startsWith('-'))) return false;
      const resolved = resolveWord(root, arg);
      if (resolved === null || !isWithin(root, resolved)) return false;
      paths += 1;
    }
  }
  return writes && paths > 0;
}

/** `git add` of everything or of paths inside the worktree (the shell expands globs there). */
function isAdd(args: readonly string[], cwd: string): boolean {
  const root = path.resolve(cwd);
  let onlyPaths = false;
  for (const arg of args) {
    if (!onlyPaths && arg === '--') {
      onlyPaths = true;
    } else if (!onlyPaths && arg.startsWith('-')) {
      if (!ADD_FLAGS.has(arg)) return false;
    } else {
      const resolved = resolveWord(root, arg);
      if (resolved === null || !isWithin(root, resolved)) return false;
    }
  }
  return true;
}

/** `git commit` with at least one message, so it never opens an editor, and nothing that rewrites or skips checks. */
function isCommit(args: readonly string[]): boolean {
  let messages = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (COMMIT_FLAGS.has(arg)) continue;
    if (COMMIT_MESSAGE_FLAGS.has(arg)) {
      // The message is the next word, whatever it looks like.
      if (i + 1 >= args.length) return false;
      i += 1;
      messages += 1;
    } else if (arg.startsWith('--message=')) {
      messages += 1;
    } else {
      return false;
    }
  }
  return messages > 0;
}

/** `git merge --ff-only <ref>` where the ref is the default branch, its remote branch or a commit id. */
function isFastForwardMerge(args: readonly string[], defaultBranch: string | undefined): boolean {
  let fastForwardOnly = false;
  const refs: string[] = [];
  for (const arg of args) {
    if (arg === '--ff-only') fastForwardOnly = true;
    else if (!MERGE_FLAGS.has(arg)) refs.push(arg);
  }
  const [ref] = refs;
  if (!fastForwardOnly || refs.length !== 1 || ref === undefined || ref.startsWith('-')) return false;
  return (
    COMMIT_ID.test(ref) ||
    (defaultBranch !== undefined && (ref === defaultBranch || ref === `origin/${defaultBranch}`))
  );
}
