import { readFile } from 'node:fs/promises';
import type { ChatItem } from '@projectman/shared';
import type { TranscriptReader } from '../../contracts';
import { parseTranscript, type TranscriptParserOptions } from './parser';

/** Reads a whole transcript; a missing file is an empty conversation. */
export async function readTranscript(path: string, opts: TranscriptParserOptions = {}): Promise<ChatItem[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return parseTranscript(text, opts);
}

export function createTranscriptReader(): TranscriptReader {
  return {
    read: (path, opts) => readTranscript(path, { self: opts?.self ?? null }),
  };
}
