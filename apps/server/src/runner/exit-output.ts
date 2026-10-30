/** Longest line, line count and total length kept from a CLI's last output (it ends up in the session's activity). */
const MAX_LINE = 160;
const MAX_LINES = 8;
const MAX_TOTAL = 480;

const SECRET_WORD = '(?:token|secret|password|passwd|api[_-]?key|authorization|credential)';
/** A value (8 characters or more) after one of these names is a secret: `NAME=value`, `NAME: value`. */
const SECRET_PAIR = new RegExp(`\\b([\\w.-]*${SECRET_WORD}[\\w.-]*)(\\s*[=:]\\s*)\\S{8,}`, 'gi');
/** The same on a command line: `--name value`. */
const SECRET_FLAG = new RegExp(`(--[\\w-]*${SECRET_WORD}[\\w-]*\\s+)\\S+`, 'gi');
const BEARER = /\bBearer\s+\S+/gi;
/** The team server's URLs carry the session's token in the path (`/mcp/<token>`, `/hooks/<token>`). */
const URL_TOKEN = /(\/(?:mcp|hooks)\/)[^/\s"']+/gi;
/** Provider keys and the engine key have a known prefix. */
const KEY_PREFIX = /\b(?:sk|pme|ghp|gho|ghs|github_pat|xox[a-z])[_-][A-Za-z0-9_-]{10,}/g;
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g;

/** A long run is a token when it looks random: hex, or mixed case with a digit. Branch names are not. */
function looksRandom(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run)) return true;
  return /\d/.test(run) && (run.match(/[a-z][A-Z]|[A-Z][a-z]/g)?.length ?? 0) >= 4;
}

const TAIL_BYTES = 8192;
/** Cursor moves and erases start a new line in the plain text; every other escape sequence is dropped. */
const LINE_BREAKING_CSI = /\x1b\[[0-?]*[ -/]*[HfABEFJK]/g;
const ESCAPE_SEQUENCE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][0-2AB]|\x1b[=>78cDEHMNOZ]/g;

/**
 * The last raw output of a PTY. The screen cannot be read at an exit: it parses asynchronously, so
 * the last chunk may not be on it yet. This keeps the end of the stream as it came.
 */
export class OutputTail {
  private tail = '';

  push(data: string): void {
    this.tail += data;
    if (this.tail.length > TAIL_BYTES * 2) this.tail = this.tail.slice(-TAIL_BYTES);
  }

  /** The kept output as plain text, one row per line (no escape sequences, no control characters). */
  plainText(): string {
    return this.tail
      .slice(-TAIL_BYTES)
      .replace(LINE_BREAKING_CSI, '\n')
      .replace(ESCAPE_SEQUENCE, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  }
}

/** Hides what looks like a credential in a line of CLI output. */
export function redactOutput(text: string): string {
  return text
    .replace(URL_TOKEN, '$1[redacted]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(SECRET_PAIR, (_all, name: string, separator: string) => `${name}${separator}[redacted]`)
    .replace(SECRET_FLAG, '$1[redacted]')
    .replace(KEY_PREFIX, '[redacted]')
    .replace(LONG_RUN, (run) => (looksRandom(run) ? '[redacted]' : run));
}

/**
 * The last lines of what a CLI printed, redacted and bounded, as one line of text: the reason a
 * CLI that exited before it was ready would otherwise take with it. Empty when nothing is on screen.
 */
export function exitOutputTail(screenText: string): string {
  const lines = screenText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-MAX_LINES)
    .map((line) => redactOutput(line).slice(0, MAX_LINE));
  const joined = lines.join(' | ');
  return joined.length > MAX_TOTAL ? `…${joined.slice(-MAX_TOTAL)}` : joined;
}
