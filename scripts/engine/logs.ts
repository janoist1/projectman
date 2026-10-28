import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** The most of a log file that `logs` reads (the end of it); older lines are not looked at. */
export const LOG_TAIL_BYTES = 256 * 1024;
export const LOG_LINES_DEFAULT = 50;
export const LOG_LINES_MAX = 200;

/** The last `lines` lines of a file, reading at most its last 256 KiB; a missing or unreadable file has none. */
export function tailLines(file: string, lines: number): string[] {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (read === 0) break;
      filled += read;
    }
    const all = buffer.subarray(0, filled).toString('utf8').split('\n');
    if (all[all.length - 1] === '') all.pop();
    // The first line of a cut-off read may be partial.
    if (start > 0) all.shift();
    return all.slice(-lines);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}
