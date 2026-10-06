import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { GeminiTranscriptParser } from './transcript';
describe('Gemini transcript', () => {
  it('reads the probe tool calls, results, text and token counts', async () => {
    const text = await readFile(
      new URL('../../../../test/fixtures/gemini/transcript/transcript_full.sample.jsonl', import.meta.url),
      'utf8',
    );
    const result = new GeminiTranscriptParser().parseLines(text.split('\n'));
    expect(result.items.filter((i) => i.kind === 'tool_call').map((i) => i.name)).toEqual([
      'Read',
      'Write',
      'Bash',
      'mcp__probe__ping',
      'WebFetch',
    ]);
    expect(result.items.at(-1)).toMatchObject({ kind: 'assistant_text', text: 'DONE' });
    expect(result.turnEnded).toBe(true);
    expect(result.contextTokens).toBeGreaterThan(10000);
    expect(result.usage![0]!.input).toBeGreaterThan(10000);
  });
  it('hides ephemeral instructions and thinking, and reports failed results', async () => {
    const text = await readFile(
      new URL(
        '../../../../test/fixtures/gemini/transcript/transcript_full.ephemeral-and-thinking.sample.jsonl',
        import.meta.url,
      ),
      'utf8',
    );
    const result = new GeminiTranscriptParser({ firstUserOrigin: 'human' }).parseLines(text.split('\n'));
    expect(result.items[0]).toMatchObject({
      kind: 'user_text',
      text: 'Reply with the single word OK',
      origin: 'human',
    });
    expect(result.items.some((i) => i.kind === 'tool_result' && !i.ok)).toBe(true);
    expect(JSON.stringify(result.items)).not.toContain('System note from the hook');
    expect(result.turnEnded).toBe(false);
  });
});
