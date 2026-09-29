import { appendFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { MemberHandle, ProjectConfig } from '@projectman/shared';
import type { MemberMemoryStore } from '../contracts';

/** How much of a member's memory a session gets: the most recent ~8 KB. */
export const MEMORY_LIMIT_BYTES = 8 * 1024;

const ProjectKey = ProjectConfig.shape.project.shape.key;

export interface MemberMemoryStoreOptions {
  /** Directory holding `<projectKey>/<handle>.md`, e.g. ~/.projectman/memory. */
  rootDir: string;
  /** Upper bound for read(); older entries are left out. Default MEMORY_LIMIT_BYTES. */
  maxReadBytes?: number;
  /** Clock for entry timestamps (tests). */
  now?: () => Date;
}

/**
 * AI member memory: durable learnings saved with the save_memory team tool, one markdown
 * file per member at `<rootDir>/<projectKey>/<handle>.md`. Every note is appended under a
 * UTC timestamp heading ("## 2026-09-29T14:05:00Z"); read() returns the most recent whole
 * entries that fit into the byte limit, reading only the end of the file.
 */
export function createMemberMemoryStore(opts: MemberMemoryStoreOptions): MemberMemoryStore {
  const rootDir = path.resolve(opts.rootDir);
  const maxReadBytes = opts.maxReadBytes ?? MEMORY_LIMIT_BYTES;
  const now = opts.now ?? (() => new Date());

  function fileOf(projectKey: string, handle: string): string {
    if (!ProjectKey.safeParse(projectKey).success) {
      throw new Error(`invalid project key: ${JSON.stringify(projectKey)}`);
    }
    if (!MemberHandle.safeParse(handle).success) {
      throw new Error(`invalid member handle: ${JSON.stringify(handle)}`);
    }
    return path.join(rootDir, projectKey, `${handle}.md`);
  }

  return {
    async read(projectKey, handle) {
      // one byte more than the limit, so an entry starting right at the cut is kept
      const bytes = await readLastBytes(fileOf(projectKey, handle), maxReadBytes + 1);
      return bytes ? recentEntries(bytes, maxReadBytes) : '';
    },

    async append(projectKey, handle, note) {
      const body = note.trim();
      if (!body) throw new Error('memory note is empty');
      const file = fileOf(projectKey, handle);
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, formatMemoryEntry(now(), body), 'utf8');
    },
  };
}

/** One memory entry: a UTC timestamp heading, the note and a blank line. */
export function formatMemoryEntry(at: Date, note: string): string {
  return `## ${at.toISOString().replace(/\.\d{3}Z$/, 'Z')}\n${note}\n\n`;
}

/** The most recent whole entries of a memory text that fit into `limitBytes`. */
export function recentMemory(
  text: string,
  limitBytes = MEMORY_LIMIT_BYTES,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text.trim(), 'utf8');
  return { text: recentEntries(bytes, limitBytes), truncated: bytes.byteLength > limitBytes };
}

/**
 * Cuts a memory text to its last `limit` bytes at an entry boundary ("\n## "), or at a line
 * boundary when no entry heading is in reach.
 */
function recentEntries(bytes: Buffer, limit: number): string {
  if (bytes.byteLength <= limit) return bytes.toString('utf8').trim();
  const tail = bytes.subarray(bytes.byteLength - limit - 1).toString('utf8');
  const entry = tail.indexOf('\n## ');
  if (entry >= 0) return tail.slice(entry + 1).trim();
  const line = tail.indexOf('\n');
  if (line >= 0) return tail.slice(line + 1).trim();
  return bytes
    .subarray(bytes.byteLength - limit)
    .toString('utf8')
    .replace(LEADING_BROKEN_CHARS, '')
    .trim();
}

/** U+FFFD replacement characters left by a cut through a multi-byte character. */
const LEADING_BROKEN_CHARS = new RegExp(`^${String.fromCharCode(0xfffd)}+`);

async function readLastBytes(file: string, maxBytes: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}
