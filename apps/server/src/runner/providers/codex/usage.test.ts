import { describe, expect, it } from 'vitest';
import { CodexTranscriptParser } from './transcript';

const line = (type: string, payload: unknown) =>
  JSON.stringify({ timestamp: '2026-10-01T10:00:00.000Z', type, payload });
const turnContext = (model: string) => line('turn_context', { turn_id: 't', cwd: '/work', model });
const tokens = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: 1,
  total_tokens: input + output,
});
const tokenCount = (total: ReturnType<typeof tokens> | null, last: ReturnType<typeof tokens> | null) =>
  line('event_msg', {
    type: 'token_count',
    info:
      total || last
        ? { ...(total ? { total_token_usage: total } : {}), ...(last ? { last_token_usage: last } : {}) }
        : null,
    rate_limits: null,
  });

describe('token usage of a Codex rollout (PM-178)', () => {
  it("counts each response with the turn's model, cached input apart from the rest", () => {
    const parser = new CodexTranscriptParser();
    const { usage } = parser.parseLines([
      turnContext('gpt-5.5-codex'),
      tokenCount(tokens(10, 4, 5), tokens(10, 4, 5)),
      tokenCount(tokens(25, 10, 12), tokens(15, 6, 7)),
    ]);
    expect(usage).toEqual([
      { model: 'gpt-5.5-codex', scope: 'main', input: 15, output: 12, cacheRead: 10, cacheWrite: 0 },
    ]);
  });

  it('does not count repeated totals twice, also across reads', () => {
    const parser = new CodexTranscriptParser();
    const first = parser.parseLines([
      turnContext('gpt-5.5'),
      tokenCount(tokens(10, 4, 5), tokens(10, 4, 5)),
      tokenCount(tokens(10, 4, 5), tokens(10, 4, 5)),
      tokenCount(null, null),
    ]);
    expect(first.usage).toEqual([
      { model: 'gpt-5.5', scope: 'main', input: 6, output: 5, cacheRead: 4, cacheWrite: 0 },
    ]);
    expect(parser.parseLines([tokenCount(tokens(10, 4, 5), tokens(10, 4, 5))]).usage).toEqual([]);
    expect(parser.parseLines([tokenCount(tokens(13, 4, 6), tokens(3, 0, 1))]).usage).toEqual([
      { model: 'gpt-5.5', scope: 'main', input: 3, output: 1, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  it("counts only the latest response when it follows a resumed conversation from the file's end", () => {
    // The running total holds the whole history; the history is not counted again.
    const parser = new CodexTranscriptParser();
    const { usage } = parser.parseLines([
      turnContext('gpt-5.5'),
      tokenCount(tokens(5000, 4000, 900), tokens(20, 10, 3)),
    ]);
    expect(usage).toEqual([
      { model: 'gpt-5.5', scope: 'main', input: 10, output: 3, cacheRead: 10, cacheWrite: 0 },
    ]);
  });

  it('splits the usage by model when the model changes between turns', () => {
    const parser = new CodexTranscriptParser();
    const { usage } = parser.parseLines([
      tokenCount(tokens(2, 0, 1), tokens(2, 0, 1)),
      turnContext('gpt-5.5'),
      tokenCount(tokens(12, 0, 3), tokens(10, 0, 2)),
      turnContext('gpt-5.5-mini'),
      tokenCount(tokens(13, 0, 4), tokens(1, 0, 1)),
    ]);
    expect(usage).toEqual([
      { model: 'gpt-5.5', scope: 'main', input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
      { model: 'gpt-5.5-mini', scope: 'main', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { model: 'unknown', scope: 'main', input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  it('falls back to the last response when the running total went down', () => {
    const parser = new CodexTranscriptParser();
    parser.parseLines([turnContext('gpt-5.5'), tokenCount(tokens(100, 0, 10), tokens(100, 0, 10))]);
    expect(parser.parseLines([tokenCount(tokens(20, 0, 2), tokens(20, 0, 2))]).usage).toEqual([
      { model: 'gpt-5.5', scope: 'main', input: 20, output: 2, cacheRead: 0, cacheWrite: 0 },
    ]);
  });
});
