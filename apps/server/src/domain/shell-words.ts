/**
 * A small, strict parser for the shell command lines AI members ask permission for. It splits a
 * line into segments, pipeline stages and words, the way a POSIX shell (bash or zsh) would read
 * it, and returns `null` as soon as anything is unsafe or unclear, so a caller can only ever
 * approve what it understood completely.
 *
 * - Words are made of unquoted "safe" characters (letters, digits and `_ - . / , : = + @ % * ? [ ]
 *   ^ #`, where the shell expands `* ? [ ]` inside the current directory), single-quoted text
 *   (literal) and double-quoted text. Inside double quotes an unescaped `$` or backtick is
 *   refused; a backslash escapes only `$`, a backtick, `"` and `\\` (as in POSIX shells) and
 *   stays literal before anything else, so `"task\.(edit|save)"` reads as `task\.(edit|save)`.
 * - Segments are separated by `&&`, `||` and `;`; the stages of a pipeline by `|`.
 * - The only redirections are `2>&1`, `>/dev/null`, `1>/dev/null` and `2>/dev/null`, each a word
 *   of its own.
 * - Refused (`null`): a newline or any other control character, a single `&`, any other `<` or
 *   `>`, an unquoted `$`, backtick, `(`, `)`, `{`, `}`, `\` or `!`, a word that starts with `~`
 *   (or has `~` right after an unquoted `=` or `:`), `=` or `#`, an unbalanced quote, and an
 *   empty segment or stage.
 *
 * Nothing is expanded or interpreted: the result tells what was written, not what it would do.
 */

export type ShellSeparator = '&&' | '||' | ';';

/** The redirections the parser accepts; every other `<` or `>` makes a command unparseable. */
export const SHELL_REDIRECTIONS = ['2>&1', '>/dev/null', '1>/dev/null', '2>/dev/null'] as const;
export type ShellRedirection = (typeof SHELL_REDIRECTIONS)[number];

/** One command of a pipeline: its words (quotes removed) and its redirections. */
export interface ShellStage {
  words: string[];
  redirections: ShellRedirection[];
}

/** Commands joined by `|`; at least one. */
export interface ShellSegment {
  stages: ShellStage[];
}

export interface ShellCommand {
  segments: ShellSegment[];
  /** `separators[i]` sits between `segments[i]` and `segments[i + 1]`. */
  separators: ShellSeparator[];
}

/** Every control character but the tab: newlines, carriage returns, NUL, escapes, DEL, C1. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

/** One unquoted character of a word (quotes, operators and whitespace are handled apart). */
const UNQUOTED_CHARACTER = /^[\p{L}\p{M}\p{N}_./,:=+@%*?[\]^#~-]$/u;

function isBlank(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

/** Parses a command line, or returns `null` when any part of it is unsafe or unclear. */
export function parseShellCommand(command: string): ShellCommand | null {
  if (CONTROL_CHARACTER.test(command)) return null;

  const segments: ShellSegment[] = [];
  const separators: ShellSeparator[] = [];
  let stages: ShellStage[] = [];
  let words: string[] = [];
  let redirections: ShellRedirection[] = [];

  /** Closes the current stage; false when it holds no command (only redirections, or nothing). */
  const endStage = (): boolean => {
    if (words.length === 0) return false;
    stages.push({ words, redirections });
    words = [];
    redirections = [];
    return true;
  };
  const endSegment = (): boolean => {
    if (!endStage()) return false;
    segments.push({ stages });
    stages = [];
    return true;
  };

  let i = 0;
  while (i < command.length) {
    const char = command[i]!;
    if (isBlank(char)) {
      i += 1;
    } else if (char === ';') {
      if (!endSegment()) return null;
      separators.push(';');
      i += 1;
    } else if (char === '&') {
      if (command[i + 1] !== '&' || !endSegment()) return null;
      separators.push('&&');
      i += 2;
    } else if (char === '|') {
      if (command[i + 1] === '|') {
        if (!endSegment()) return null;
        separators.push('||');
        i += 2;
      } else {
        if (!endStage()) return null;
        i += 1;
      }
    } else {
      const redirection = SHELL_REDIRECTIONS.find((candidate) => command.startsWith(candidate, i));
      if (redirection) {
        // A redirection is a word of its own: anything glued to it is something else.
        const next = command[i + redirection.length];
        if (next !== undefined && !isBlank(next) && next !== ';' && next !== '|' && next !== '&') return null;
        redirections.push(redirection);
        i += redirection.length;
      } else {
        const word = readWord(command, i);
        if (!word) return null;
        words.push(word.text);
        i = word.end;
      }
    }
  }
  if (!endSegment()) return null;
  return { segments, separators };
}

/** The word starting at `start`: its text with quotes removed, and where it ends. */
function readWord(command: string, start: number): { text: string; end: number } | null {
  let text = '';
  let i = start;
  /** Something, even an empty pair of quotes, belongs to the word. */
  let started = false;
  /** The unquoted character just before the current one ('' at the start and after a quote). */
  let previous = '';
  while (i < command.length) {
    const char = command[i]!;
    if (isBlank(char) || char === ';' || char === '|' || char === '&') break;
    if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return null;
      text += command.slice(i + 1, close);
      i = close + 1;
      started = true;
      previous = '';
    } else if (char === '"') {
      let j = i + 1;
      for (;;) {
        const inner = command[j];
        if (inner === undefined || inner === '$' || inner === '`') return null;
        if (inner === '"') break;
        if (inner === '\\') {
          const escaped = command[j + 1];
          if (escaped === undefined) return null;
          // POSIX: inside double quotes a backslash escapes only $ ` " \ (and a newline, refused
          // above); before anything else both characters are kept.
          text += '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`;
          j += 2;
        } else {
          text += inner;
          j += 1;
        }
      }
      i = j + 1;
      started = true;
      previous = '';
    } else {
      const unquoted = String.fromCodePoint(command.codePointAt(i)!);
      if (!UNQUOTED_CHARACTER.test(unquoted)) return null;
      // `#` starts a comment, `=cmd` expands to a path in zsh, and `~` expands to a home directory.
      if (!started && (unquoted === '#' || unquoted === '=')) return null;
      if (unquoted === '~' && (!started || previous === '=' || previous === ':')) return null;
      text += unquoted;
      started = true;
      previous = unquoted;
      i += unquoted.length;
    }
  }
  return { text, end: i };
}
