import { readFile } from 'node:fs/promises';
import type { ChatItem } from '@projectman/shared';
import type { TranscriptReader } from '../../contracts';
import { CODEX_ROLLOUT_FILE, parseCodexTranscript } from '../providers/codex/transcript';
import { parseTranscript, type TranscriptParserOptions } from '../providers/claude/transcript';

/**
 * Reads a whole transcript; a missing file is an empty conversation. Codex rollouts
 * (rollout-*.jsonl) are parsed as such, everything else as a Claude Code transcript.
 */
export async function readTranscript(path: string, opts: TranscriptParserOptions = {}): Promise<ChatItem[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (CODEX_ROLLOUT_FILE.test(path)) return parseCodexTranscript(text, opts);
  return parseTranscript(text, opts);
}

export function createTranscriptReader(): TranscriptReader {
  return {
    read: (path, opts) =>
      readTranscript(path, {
        self: opts?.self ?? null,
        cwd: opts?.cwd ?? null,
        firstUserOrigin: opts?.firstUserOrigin,
      }),
  };
}
