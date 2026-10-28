import path from 'node:path';
import { parseShellCommand } from './shell-words';
import type { ShellCommand } from './shell-words';

/**
 * Commands that rewrite a file through the shell (`sed -i`, `perl -pi -e ...`). An AI member
 * changes files with its editing tools, which need no permission; the shell is the wrong way and
 * would only land in the owner's inbox. `commandVerdict` refuses these at once, with guidance.
 *
 * The check reads a command the strict parser (`shell-words.ts`) understood: every stage of every
 * segment, so a chain (`cd dir && sed -i ...`) or a pipeline is covered. A program run through a
 * common wrapper (`xargs sed -i`, `find -exec sed -i`, `env`, `sudo`, `bash -c "sed -i ..."`)
 * is covered too. It is a guard for a habit, not a sandbox: other ways to write a file still reach a
 * human like any unknown command.
 */

/** The message a refused command returns: it names the right tool. */
export const IN_PLACE_EDIT_MESSAGE =
  'Edit files with your Edit or Write tool; in-place edits through the shell are refused without asking anyone.';

/** Programs that run the words after them as a command, with the options to skip. */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Options of xargs that take their value as the next word.
  ['xargs', new Set(['-n', '-P', '-I', '-L', '-s', '-E', '-d', '-a'])],
  ['env', new Set(['-u', '-C', '-S'])],
  ['sudo', new Set(['-u', '-g', '-C'])],
  ['nice', new Set(['-n'])],
  ['command', new Set()],
  ['exec', new Set()],
  ['nohup', new Set()],
  ['time', new Set()],
]);

/** `find ... -exec sed -i ... ;` runs the words after the action. */
const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash']);

/** `NAME=value` in front of a command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * sed options whose value is the rest of the cluster or, when nothing is left, the next word:
 * `-e script`, `-f file`, `-l width`. `-i` (GNU) and `-I` (BSD) edit in place; the rest of a
 * cluster after `-i` is its backup suffix.
 */
const SED_VALUE_OPTIONS = new Set(['e', 'f', 'l']);

/** perl switches whose value is the rest of the cluster (`-e code`, `-Mstrict`, `-I dir`). */
const PERL_VALUE_OPTIONS = new Set(['e', 'E', 'I', 'M', 'm', 'F', 'x', 'C', 'd', 'D', 'V', 'A']);

function sedEditsInPlace(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') return false;
    if (arg === '--in-place' || arg.startsWith('--in-place=')) return true;
    if (!arg.startsWith('-') || arg.startsWith('--') || arg === '-') continue;
    // GNU sed reads options anywhere among its words, so the whole line is scanned.
    for (let c = 1; c < arg.length; c += 1) {
      const flag = arg[c]!;
      if (flag === 'i' || flag === 'I') return true;
      if (SED_VALUE_OPTIONS.has(flag)) {
        if (c === arg.length - 1) i += 1;
        break;
      }
    }
  }
  return false;
}

function perlEditsInPlace(args: readonly string[]): boolean {
  // perl reads switches up to the first word that is not one; the rest belongs to the script.
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--' || !arg.startsWith('-') || arg === '-') return false;
    for (let c = 1; c < arg.length; c += 1) {
      const flag = arg[c]!;
      if (flag === 'i') return true;
      if (PERL_VALUE_OPTIONS.has(flag)) {
        // `-e code` and `-I dir` may take the next word; the others are attached or have no value.
        if (c === arg.length - 1 && (flag === 'e' || flag === 'E' || flag === 'I')) i += 1;
        break;
      }
    }
  }
  return false;
}

/** Whether the command starting at `words[start]` edits a file in place. */
function commandEditsInPlace(words: readonly string[], start: number): boolean {
  let at = start;
  while (at < words.length && ASSIGNMENT.test(words[at]!)) at += 1;
  const name = words[at] === undefined ? '' : path.posix.basename(words[at]!);
  const args = words.slice(at + 1);
  if (name === 'sed') return sedEditsInPlace(args);
  if (name === 'perl') return perlEditsInPlace(args);
  const skip = WRAPPERS.get(name);
  if (skip) {
    // Past the wrapper's own options to the command it runs.
    let next = at + 1;
    while (next < words.length && words[next]!.startsWith('-')) next += skip.has(words[next]!) ? 2 : 1;
    return commandEditsInPlace(words, next);
  }
  if (name === 'find') {
    return words.some((word, index) => FIND_ACTIONS.has(word) && commandEditsInPlace(words, index + 1));
  }
  if (SHELLS.has(name)) {
    // `bash -c "sed -i ..."`: the string is a command line of its own.
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    const script = flag >= 0 ? args[flag + 1] : undefined;
    const parsed = script === undefined ? null : parseShellCommand(script);
    return parsed !== null && editsFilesInPlace(parsed);
  }
  return false;
}

/** Whether any command of the line rewrites a file in place. */
export function editsFilesInPlace(parsed: ShellCommand): boolean {
  return parsed.segments.some((segment) => segment.stages.some(({ words }) => commandEditsInPlace(words, 0)));
}
