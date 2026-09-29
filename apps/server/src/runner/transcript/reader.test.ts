import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranscriptReader } from './reader';

const at = '2026-10-01T10:00:00.000Z';
const texts = ['Fictional opening prompt', 'Human follow-up'];

describe('whole transcript origins', () => {
  it.each(['claude', 'codex'] as const)(
    'keeps task briefs and general human prompts distinct for %s on reload',
    async (provider) => {
      const dir = await mkdtemp(join(tmpdir(), 'pm-origins-'));
      try {
        const path = join(dir, provider === 'codex' ? 'rollout-fictional.jsonl' : 'fictional.jsonl');
        const lines = texts.map((text, index) =>
          JSON.stringify(
            provider === 'claude'
              ? { uuid: `u-${index}`, timestamp: at, type: 'user', message: { role: 'user', content: text } }
              : {
                  timestamp: at,
                  type: 'response_item',
                  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
                },
          ),
        );
        await writeFile(path, lines.join('\n'));
        const reader = createTranscriptReader();
        const task = await reader.read(path, { firstUserOrigin: 'brief' });
        const general = await reader.read(path, { firstUserOrigin: 'human' });
        expect(task.filter((item) => item.kind === 'user_text').map((item) => item.origin)).toEqual([
          'brief',
          'human',
        ]);
        expect(general.filter((item) => item.kind === 'user_text').map((item) => item.origin)).toEqual([
          'human',
          'human',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
