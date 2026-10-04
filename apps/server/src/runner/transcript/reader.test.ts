import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
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

describe('whether a transcript was written (PM-340)', () => {
  async function inTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'pm-written-'));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('counts only a file with content', async () => {
    await inTempDir(async (dir) => {
      const reader = createTranscriptReader();
      await writeFile(join(dir, 'empty.jsonl'), '');
      await writeFile(join(dir, 'written.jsonl'), '{}\n');
      expect(await reader.hasContent(join(dir, 'missing.jsonl'))).toBe(false);
      expect(await reader.hasContent(join(dir, 'empty.jsonl'))).toBe(false);
      expect(await reader.hasContent(join(dir, 'written.jsonl'))).toBe(true);
      // A directory is no transcript.
      expect(await reader.hasContent(dir)).toBe(false);
    });
  });

  it('counts a file in a worker home only inside it', async () => {
    await inTempDir(async (dir) => {
      const reader = createTranscriptReader();
      const home = join(dir, 'home');
      await mkdir(home);
      await writeFile(join(home, 'written.jsonl'), '{}\n');
      await writeFile(join(dir, 'outside.jsonl'), '{}\n');
      expect(await reader.hasContent(join(home, 'written.jsonl'), { confineTo: home })).toBe(true);
      expect(await reader.hasContent(join(home, 'missing.jsonl'), { confineTo: home })).toBe(false);
      await expect(reader.hasContent(join(dir, 'outside.jsonl'), { confineTo: home })).rejects.toThrow();
    });
  });
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

describe('whole transcript providers', () => {
  it('parses a transcript as the provider that wrote it, whatever its file name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-provider-'));
    try {
      const path = join(dir, 'fictional.jsonl');
      const line = {
        timestamp: at,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
      };
      await writeFile(path, JSON.stringify(line));
      const reader = createTranscriptReader();
      expect(await reader.read(path, { provider: 'codex' })).toMatchObject([
        { kind: 'assistant_text', text: 'Done.' },
      ]);
      // Guessed from the name, it is a Claude Code transcript, whose format this is not.
      expect(await reader.read(path)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
