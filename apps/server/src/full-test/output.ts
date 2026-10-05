/** What the full test's output says: the failed files and the part of the output worth showing (PM-217). */

/** The most output kept in memory. */
export const OUTPUT_LIMIT_BYTES = 256 * 1024;
/** The most characters of output shown for a failed or errored run. */
export const OUTPUT_TAIL_CHARS = 6000;
/** The most failed files named. */
export const FAILED_FILES_LIMIT = 20;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Keeps the last `OUTPUT_LIMIT_BYTES` characters of what a process wrote, however much that is.
 * Characters rather than bytes: the limit is a memory guard, not a contract.
 */
export class OutputTail {
  private text = '';

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > OUTPUT_LIMIT_BYTES * 2) this.text = this.text.slice(-OUTPUT_LIMIT_BYTES);
  }

  value(): string {
    return this.text.length > OUTPUT_LIMIT_BYTES ? this.text.slice(-OUTPUT_LIMIT_BYTES) : this.text;
  }
}

/**
 * The files of vitest's ` FAIL ` lines (` FAIL  test/a.test.ts > suite > test`, with a project name
 * ` FAIL  |server| test/a.test.ts`), unique, in order of appearance. Empty for a failure that is
 * not a test (a type check).
 */
export function failedFiles(output: string): string[] {
  const files: string[] = [];
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const found = /^\s*FAIL\s+(?:\|[^|]*\|\s+)?(\S+)/.exec(line);
    const file = found?.[1];
    if (!file || !/[./]/.test(file) || files.includes(file)) continue;
    files.push(file);
    if (files.length >= FAILED_FILES_LIMIT) break;
  }
  return files;
}

/**
 * The output of a failed run for people and the developer: ANSI removed, vitest's "Failed Tests"
 * section from its start if there is one, else the end of the output; at most `limit` characters
 * (default `OUTPUT_TAIL_CHARS`).
 */
export function outputTail(output: string, limit = OUTPUT_TAIL_CHARS): string {
  const text = stripAnsi(output).replace(/\r\n/g, '\n').trim();
  const marker = /^.*Failed Tests.*$/m.exec(text);
  if (marker) return text.slice(marker.index, marker.index + limit);
  return text.length > limit ? text.slice(-limit) : text;
}
