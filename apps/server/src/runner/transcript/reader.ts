import { readFile, stat } from 'node:fs/promises';
import { MAX_CONFINED_TRANSCRIPT_BYTES, openConfined } from './confined';
import type { AgentProvider, ChatItem } from '@projectman/shared';
import type { TranscriptReader } from '../../contracts';
import { CODEX_ROLLOUT_FILE, parseCodexTranscript } from '../providers/codex/transcript';
import { parseTranscript, type TranscriptParserOptions } from '../providers/claude/transcript';

/**
 * Reads a whole transcript of `provider`'s CLI; a missing file is an empty conversation.
 * Without a provider, Codex rollouts (rollout-*.jsonl) are parsed as such and everything else
 * as a Claude Code transcript.
 */
export async function readTranscript(
  path: string,
  opts: TranscriptParserOptions & { provider?: AgentProvider; confineTo?: string } = {},
): Promise<ChatItem[]> {
  const text = await readTranscriptText(path, opts.confineTo);
  const provider = opts.provider ?? (CODEX_ROLLOUT_FILE.test(path) ? 'codex' : 'claude');
  if (provider === 'codex') return parseCodexTranscript(text, opts);
  return parseTranscript(text, opts);
}

/**
 * The text of a whole transcript; a missing file is empty. With `confineTo` (a worker home,
 * PM-140) only a regular file whose real path lies in it is read (`openConfined`).
 */
export async function readTranscriptText(path: string, confineTo?: string): Promise<string> {
  try {
    if (!confineTo) return await readFile(path, 'utf8');
    const handle = await openConfined(path, confineTo);
    try {
      if ((await handle.stat()).size > MAX_CONFINED_TRANSCRIPT_BYTES) throw new Error('transcript too large');
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Whether a transcript is a file with something in it; a missing file is not. With `confineTo` (a
 * worker home, PM-140) it must also be a regular file whose real path lies in it (`openConfined`).
 */
export async function transcriptHasContent(path: string, confineTo?: string): Promise<boolean> {
  try {
    if (!confineTo) {
      const info = await stat(path);
      return info.isFile() && info.size > 0;
    }
    const handle = await openConfined(path, confineTo);
    try {
      return (await handle.stat()).size > 0;
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function createTranscriptReader(): TranscriptReader {
  return {
    hasContent: (path, opts) => transcriptHasContent(path, opts?.confineTo),
    read: (path, opts) =>
      readTranscript(path, {
        provider: opts?.provider,
        self: opts?.self ?? null,
        cwd: opts?.cwd ?? null,
        firstUserOrigin: opts?.firstUserOrigin,
        confineTo: opts?.confineTo,
      }),
  };
}
