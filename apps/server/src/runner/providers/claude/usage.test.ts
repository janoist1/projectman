import { describe, expect, it } from 'vitest';
import { TranscriptParser } from './transcript';

/** An assistant entry of Claude Code's transcript with the usage of its response. */
function assistant(
  id: string | null,
  usage: Record<string, number>,
  extra: Record<string, unknown> = {},
  model = 'claude-opus-5-5',
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `u-${Math.random()}`,
    timestamp: '2026-10-01T10:00:00.000Z',
    ...extra,
    message: {
      ...(id ? { id } : {}),
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'hi' }],
      usage,
    },
  });
}

const FULL = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 20,
};

describe('token usage of a Claude Code transcript (PM-178)', () => {
  it('counts every response per model, with the four kinds of tokens', () => {
    const parser = new TranscriptParser();
    const { usage } = parser.parseLines([
      assistant('msg_1', FULL),
      assistant('msg_2', { ...FULL, output_tokens: 7 }),
      assistant('msg_3', { input_tokens: 1, output_tokens: 1 }, {}, 'claude-sonnet-5-5'),
    ]);
    expect(usage).toEqual([
      { model: 'claude-opus-5-5', scope: 'main', input: 20, output: 12, cacheRead: 200, cacheWrite: 40 },
      { model: 'claude-sonnet-5-5', scope: 'main', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  it('counts a response written in several entries once, by its message id', () => {
    const parser = new TranscriptParser();
    const first = parser.parseLines([assistant('msg_1', FULL), assistant('msg_1', FULL)]);
    expect(first.usage).toEqual([
      { model: 'claude-opus-5-5', scope: 'main', input: 10, output: 5, cacheRead: 100, cacheWrite: 20 },
    ]);
    // The same response again in a later read adds nothing.
    expect(parser.parseLines([assistant('msg_1', FULL)]).usage).toEqual([]);
  });

  it('adds only the difference when a later entry of a response has a larger output count', () => {
    const parser = new TranscriptParser();
    const early = parser.parseLines([assistant('msg_1', { ...FULL, output_tokens: 1 })]);
    expect(early.usage).toEqual([
      { model: 'claude-opus-5-5', scope: 'main', input: 10, output: 1, cacheRead: 100, cacheWrite: 20 },
    ]);
    const later = parser.parseLines([assistant('msg_1', { ...FULL, output_tokens: 42 })]);
    expect(later.usage).toEqual([
      { model: 'claude-opus-5-5', scope: 'main', input: 0, output: 41, cacheRead: 0, cacheWrite: 0 },
    ]);
    // A smaller placeholder after the real count changes nothing.
    expect(parser.parseLines([assistant('msg_1', { ...FULL, output_tokens: 1 })]).usage).toEqual([]);
  });

  it('skips API error messages, the synthetic model, entries without usage and malformed lines', () => {
    const parser = new TranscriptParser();
    const { usage, items } = parser.parseLines([
      assistant('msg_e', FULL, { isApiErrorMessage: true }),
      assistant('msg_s', FULL, {}, '<synthetic>'),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_n', model: 'claude-opus-5-5', content: [] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      '{not json',
      assistant('msg_x', { input_tokens: -3, output_tokens: 2.7 }),
    ]);
    expect(usage).toEqual([
      { model: 'claude-opus-5-5', scope: 'main', input: 0, output: 2, cacheRead: 0, cacheWrite: 0 },
    ]);
    // The chat is read as before.
    expect(items.map((i) => i.kind)).toEqual([
      'system_note',
      'assistant_text',
      'user_text',
      'assistant_text',
    ]);
  });

  it('counts entries without a message id each time they appear', () => {
    const parser = new TranscriptParser();
    expect(parser.parseLines([assistant(null, FULL), assistant(null, FULL)]).usage).toEqual([
      { model: 'claude-opus-5-5', scope: 'main', input: 20, output: 10, cacheRead: 200, cacheWrite: 40 },
    ]);
  });

  it("puts a subagent's usage on rows of its own, from its own file or from sidechain entries", () => {
    const parser = new TranscriptParser();
    const inline = parser.parseLines([
      assistant('msg_side', FULL, { isSidechain: true }, 'claude-haiku-4-5'),
      assistant('msg_main', FULL),
    ]);
    expect(inline.usage).toEqual([
      { model: 'claude-opus-5-5', scope: 'main', input: 10, output: 5, cacheRead: 100, cacheWrite: 20 },
      { model: 'claude-haiku-4-5', scope: 'subagent', input: 10, output: 5, cacheRead: 100, cacheWrite: 20 },
    ]);
    const own = parser.subagentUsage([
      // Counted already from the main transcript.
      assistant('msg_side', FULL, { isSidechain: true }, 'claude-haiku-4-5'),
      assistant('msg_sub', { input_tokens: 3, output_tokens: 1 }, { isSidechain: true }, 'claude-haiku-4-5'),
      assistant('msg_sub', { input_tokens: 3, output_tokens: 2 }, { isSidechain: true }, 'claude-haiku-4-5'),
      '',
    ]);
    expect(own).toEqual([
      { model: 'claude-haiku-4-5', scope: 'subagent', input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
    ]);
  });
});

describe('the context of the last step (PM-213)', () => {
  it('is the input, cache read and cache write of the latest main-conversation step', () => {
    const parser = new TranscriptParser();
    expect(
      parser.parseLines([assistant('msg_1', FULL), assistant('msg_2', { ...FULL, input_tokens: 40 })]),
    ).toMatchObject({
      contextTokens: 40 + 100 + 20,
    });
    // Taken once: lines without a step carry none.
    expect(parser.parseLines([''])).not.toHaveProperty('contextTokens');
  });

  it("ignores a subagent's steps, and keeps the step of a response whose usage was counted already", () => {
    const parser = new TranscriptParser();
    parser.parseLines([assistant('msg_1', FULL)]);
    const { contextTokens } = parser.parseLines([
      assistant('msg_1', { ...FULL, output_tokens: 9 }),
      assistant('msg_side', { input_tokens: 900_000, output_tokens: 1 }, { isSidechain: true }),
    ]);
    expect(contextTokens).toBe(130);
  });
});
