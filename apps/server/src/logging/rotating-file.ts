import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export interface RotatingFile {
  /** Appends `text` (a whole line, with its newline); rotates first when it would pass the size limit. Throws on I/O errors. */
  append(text: string): void;
}

/**
 * Appends to `file` and rotates it at `maxBytes`: `file` becomes `file.1`, `file.1` `file.2`, and so
 * on; the oldest of `keep` files is deleted. So the files together stay below `keep * maxBytes`.
 * The directory and files are private to the owner (0700, 0600).
 */
export function createRotatingFile(file: string, options: { maxBytes: number; keep: number }): RotatingFile {
  const { maxBytes } = options;
  const keep = Math.max(1, options.keep);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  const moveIfExists = (from: string, to: string) => {
    try {
      renameSync(from, to);
    } catch (error) {
      // A rotated file that does not exist yet is normal.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  const rotate = () => {
    rmSync(`${file}.${keep - 1}`, { force: true });
    for (let index = keep - 2; index >= 1; index -= 1)
      moveIfExists(`${file}.${index}`, `${file}.${index + 1}`);
    if (keep > 1) moveIfExists(file, `${file}.1`);
    else rmSync(file, { force: true });
    size = 0;
  };
  return {
    append(text) {
      const bytes = Buffer.byteLength(text);
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(file, text, { mode: 0o600 });
      size += bytes;
    },
  };
}
