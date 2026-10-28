/**
 * Reading the options of a command from its words, for the automatic command rules. Nothing
 * here knows what a command does: it only tells which words are options, and lets a rule accept
 * the options it has checked and refuse any other.
 */

/**
 * `arg` is the long option `name`, or an abbreviation of it (`getopt_long` tools accept any
 * unambiguous one), with or without a `=value`.
 */
export function namesOption(arg: string, name: string, minLength = 3): boolean {
  if (!arg.startsWith('--')) return false;
  const given = arg.split('=', 1)[0]!;
  return given.length >= minLength && name.startsWith(given);
}

/** A short option cluster (`-nr`, `-ofile`) that includes one of `letters`. */
export function hasShortOption(arg: string, letters: string): boolean {
  if (!arg.startsWith('-') || arg.startsWith('--')) return false;
  const run = /^[A-Za-z]*/.exec(arg.slice(1))![0];
  return [...run].some((letter) => letters.includes(letter));
}

/** The options a command may have; every other option refuses the command. */
export interface OptionList {
  /** Short options without a value, which may share one word (`-rl`). */
  letters: string;
  /** Short options with a value, written `-e PATTERN` or `-ePATTERN`. */
  valueLetters: string;
  /** Long options without a value, written in full. */
  flags: readonly string[];
  /** Long options with a value, written `--glob=PATTERN` or `--glob PATTERN`. */
  valueFlags: readonly string[];
  /** A line count written as a number (`-5`). */
  counts?: boolean;
}

export interface ParsedOptions {
  /** The options present: short ones as `-l`, long ones as `--files`, a count as `-N`. */
  present: ReadonlySet<string>;
  /** The words that are no options: patterns, revisions, paths. */
  words: string[];
}

/**
 * Splits `args` into the options of `list` and the other words, or returns `null` when an
 * option is not in the list. `--` ends the options. A value belongs to the option before it, so
 * `-e -l` is a pattern `-l`, not the option `-l`.
 */
export function parseOptions(args: readonly string[], list: OptionList): ParsedOptions | null {
  const present = new Set<string>();
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      words.push(arg);
    } else if (arg.startsWith('--')) {
      const name = arg.split('=', 1)[0]!;
      const assigned = arg.includes('=');
      if (!assigned && list.flags.includes(arg)) {
        present.add(arg);
      } else if (list.valueFlags.includes(name)) {
        present.add(name);
        if (!assigned) {
          // The value is the next word.
          if (i + 1 >= args.length) return null;
          i += 1;
        }
      } else {
        return null;
      }
    } else if (list.counts && /^-\d+$/.test(arg)) {
      present.add('-N');
    } else {
      for (let j = 1; j < arg.length; j += 1) {
        const letter = arg[j]!;
        if (list.letters.includes(letter)) {
          present.add(`-${letter}`);
        } else if (list.valueLetters.includes(letter)) {
          present.add(`-${letter}`);
          // Letters after it are its value; at the end of the word the value is the next word.
          if (j === arg.length - 1) {
            if (i + 1 >= args.length) return null;
            i += 1;
          }
          break;
        } else {
          return null;
        }
      }
    }
  }
  return { present, words };
}
