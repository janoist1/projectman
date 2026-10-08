import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HANDOFF_SUMMARY_MAX } from '@projectman/shared';
import { createTranscriptReader } from './reader';
import { summarizeTranscript } from './summary';

const time = (n: number) => `2026-10-01T10:${String(n).padStart(2, '0')}:00.000Z`;
const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join('\n');

const claudeUser = (n: number, text: string) => ({
  type: 'user',
  uuid: `u${n}`,
  timestamp: time(n),
  message: { role: 'user', content: text },
});
const claudeReply = (n: number, text: string) => ({
  type: 'assistant',
  uuid: `a${n}`,
  timestamp: time(n),
  message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
});
const claudeCompact = (n: number, text: string) => ({
  type: 'user',
  uuid: `c${n}`,
  timestamp: time(n),
  isCompactSummary: true,
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const codexReply = (n: number, text: string) => ({
  timestamp: time(n),
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});
const codexCompacted = (n: number, message: string) => ({
  timestamp: time(n),
  type: 'compacted',
  payload: { message, replacement_history: [] },
});

const geminiReply = (n: number, content: string) => ({
  type: 'PLANNER_RESPONSE',
  step_index: n,
  created_at: time(n),
  content,
});

describe('summarizeTranscript', () => {
  it('takes the last Claude compaction summary and the last 4 replies after it', () => {
    const text = jsonl(
      claudeUser(1, 'Start'),
      claudeReply(2, 'before the first compaction'),
      claudeCompact(3, 'First summary'),
      claudeCompact(4, 'Second summary'),
      ...[5, 6, 7, 8, 9, 10].map((n) => claudeReply(n, `reply ${n}`)),
    );
    expect(summarizeTranscript(text, 'claude')).toEqual({
      source: 'compact',
      text: ['Second summary', 'reply 7', 'reply 8', 'reply 9', 'reply 10'].join('\n\n---\n\n'),
      at: time(10),
    });
  });

  it('gives only the compaction summary when no reply follows it', () => {
    const text = jsonl(claudeReply(1, 'old'), claudeCompact(2, 'The summary'));
    expect(summarizeTranscript(text, 'claude')).toEqual({
      source: 'compact',
      text: 'The summary',
      at: time(2),
    });
  });

  it('takes the message of the last Codex compacted line and the replies after it', () => {
    const text = jsonl(
      codexReply(1, 'early'),
      codexCompacted(2, 'Codex summary'),
      codexReply(3, 'after one'),
      codexReply(4, 'after two'),
    );
    const expected = {
      source: 'compact',
      text: 'Codex summary\n\n---\n\nafter one\n\n---\n\nafter two',
      at: time(4),
    };
    expect(summarizeTranscript(text, 'codex')).toEqual(expected);
    expect(summarizeTranscript(text, 'nanogpt')).toEqual(expected);
  });

  it('ignores a compacted line without a message', () => {
    const text = jsonl(codexReply(1, 'only reply'), codexCompacted(2, ''));
    expect(summarizeTranscript(text, 'codex')).toEqual({
      source: 'last_replies',
      text: 'only reply',
      at: time(1),
    });
  });

  it('takes the last 6 replies of a conversation without compaction, oldest first', () => {
    const text = jsonl(
      claudeUser(1, 'Start'),
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => claudeReply(n, `reply ${n}`)),
    );
    expect(summarizeTranscript(text, 'claude')).toEqual({
      source: 'last_replies',
      text: [4, 5, 6, 7, 8, 9].map((n) => `reply ${n}`).join('\n\n---\n\n'),
      at: time(9),
    });
  });

  it('takes the last replies of a Gemini conversation, and no time it does not know', () => {
    const text = jsonl(geminiReply(1, 'first'), geminiReply(2, 'second'), {
      type: 'PLANNER_RESPONSE',
      step_index: 3,
      content: 'third',
    });
    expect(summarizeTranscript(text, 'gemini')).toEqual({
      source: 'last_replies',
      text: 'first\n\n---\n\nsecond\n\n---\n\nthird',
      at: null,
    });
  });

  it('gives null without a reply or compaction, and for text it cannot read', () => {
    expect(summarizeTranscript(jsonl(claudeUser(1, 'Only a question')), 'claude')).toBeNull();
    expect(summarizeTranscript('not json\n{"broken":', 'codex')).toBeNull();
    expect(summarizeTranscript('', 'gemini')).toBeNull();
  });

  it('keeps the first 6000 characters of a long compaction summary and fits the replies in the rest', () => {
    const text = jsonl(
      claudeCompact(1, 'S'.repeat(20_000)),
      claudeReply(2, 'oldest '.padEnd(3000, 'o')),
      claudeReply(3, 'newer '.padEnd(1000, 'n')),
      claudeReply(4, 'newest'),
    );
    const summary = summarizeTranscript(text, 'claude')!;
    expect(summary.text.length).toBeLessThanOrEqual(HANDOFF_SUMMARY_MAX);
    expect(summary.text.startsWith(`${'S'.repeat(6000)}…\n\n---\n\n`)).toBe(true);
    expect(summary.text).not.toContain('oldest');
    expect(summary.text.endsWith(`${'newer '.padEnd(1000, 'n')}\n\n---\n\nnewest`)).toBe(true);
    expect(summary.at).toBe(time(4));
  });

  it('drops the oldest replies of a conversation without compaction to fit', () => {
    const text = jsonl(
      claudeReply(1, 'a'.repeat(7000)),
      claudeReply(2, 'b'.repeat(2000)),
      claudeReply(3, 'c'.repeat(500)),
    );
    const summary = summarizeTranscript(text, 'claude')!;
    expect(summary.text).toBe(`${'b'.repeat(2000)}\n\n---\n\n${'c'.repeat(500)}`);
  });

  it('keeps the end of a single reply that is too long', () => {
    const summary = summarizeTranscript(jsonl(claudeReply(1, `${'x'.repeat(9000)}END`)), 'claude')!;
    expect(summary.text.length).toBe(HANDOFF_SUMMARY_MAX);
    expect(summary.text.startsWith('…x')).toBe(true);
    expect(summary.text.endsWith('xEND')).toBe(true);
  });
});

describe('TranscriptReader.summary', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pm-summary-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the summary of a transcript file', async () => {
    const path = join(dir, 'conversation.jsonl');
    await writeFile(path, jsonl(claudeUser(1, 'Hi'), claudeReply(2, 'Hello')));
    expect(await createTranscriptReader().summary(path, { provider: 'claude' })).toEqual({
      source: 'last_replies',
      text: 'Hello',
      at: time(2),
    });
  });

  it('gives null for a missing file, a directory and a file outside the worker home', async () => {
    const reader = createTranscriptReader();
    expect(await reader.summary(join(dir, 'missing.jsonl'), { provider: 'claude' })).toBeNull();
    expect(await reader.summary(dir, { provider: 'claude' })).toBeNull();
    const home = join(dir, 'home');
    await mkdir(home);
    const outside = join(dir, 'outside.jsonl');
    await writeFile(outside, jsonl(claudeReply(1, 'secret')));
    expect(await reader.summary(outside, { provider: 'claude', confineTo: home })).toBeNull();
    const link = join(home, 'link.jsonl');
    await symlink(outside, link);
    expect(await reader.summary(link, { provider: 'claude', confineTo: home })).toBeNull();
    const inside = join(home, 'inside.jsonl');
    await writeFile(inside, jsonl(claudeReply(1, 'mine')));
    expect((await reader.summary(inside, { provider: 'claude', confineTo: home }))?.text).toBe('mine');
  });
});
