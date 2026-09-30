import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../providers/claude';
import { createCodexAdapter } from '../providers/codex';
import { silentLogger } from '../test-helpers';
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

describe('whole transcript paths', () => {
  const cwd = '/work/AR-1';
  const lines = {
    claude: [
      {
        uuid: 'a1',
        timestamp: at,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: `${cwd}/src/app.ts` } },
          ],
        },
      },
    ],
    codex: [
      {
        timestamp: at,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_1',
          name: 'apply_patch',
          input: `*** Begin Patch\n*** Update File: ${cwd}/src/app.ts\n@@\n-a\n+b\n*** End Patch`,
        },
      },
    ],
  };
  const adapters = {
    claude: createClaudeAdapter({ bin: 'claude', logger: silentLogger() }),
    codex: createCodexAdapter({ bin: 'codex', codexHome: '/nonexistent', logger: silentLogger() }),
  };

  it.each(['claude', 'codex'] as const)(
    'shows paths relative to the working directory like the live chat for %s',
    async (provider) => {
      const dir = await mkdtemp(join(tmpdir(), 'pm-paths-'));
      try {
        const path = join(dir, provider === 'codex' ? 'rollout-fictional.jsonl' : 'fictional.jsonl');
        const text = lines[provider].map((line) => JSON.stringify(line));
        await writeFile(path, text.join('\n'));
        const reloaded = await createTranscriptReader().read(path, { self: 'fe-1', cwd });
        const live = adapters[provider].createTranscriptParser({ self: 'fe-1', cwd }).parseLines(text).items;
        expect(reloaded).toEqual(live);
        expect(reloaded).toMatchObject([{ kind: 'tool_call', summary: 'src/app.ts' }]);
        // Without a working directory the path stays absolute.
        expect(await createTranscriptReader().read(path, { self: 'fe-1' })).toMatchObject([
          { kind: 'tool_call', summary: `${cwd}/src/app.ts` },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
