import { readFile } from 'node:fs/promises';
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
  opts: TranscriptParserOptions & { provider?: AgentProvider } = {},
): Promise<ChatItem[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const provider = opts.provider ?? (CODEX_ROLLOUT_FILE.test(path) ? 'codex' : 'claude');
  if (provider === 'codex') return parseCodexTranscript(text, opts);
  return parseTranscript(text, opts);
}

export function createTranscriptReader(): TranscriptReader {
  return {
    read: (path, opts) =>
      readTranscript(path, {
        provider: opts?.provider,
        self: opts?.self ?? null,
        cwd: opts?.cwd ?? null,
        firstUserOrigin: opts?.firstUserOrigin,
      }),
  };
}
