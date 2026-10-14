import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../chat/chat';
import { TOOL_FAILED_CODE, workMetadataAfterChat } from './session-work';

const NOW = Date.parse('2026-10-14T10:00:00.000Z');
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
const working = { state: 'working' as const, now: NOW };
const idle = { state: 'idle' as const, now: NOW };

const call = (ts: string, name = 'update_task'): ChatItem => ({
  id: `c_${ts}`,
  ts,
  kind: 'tool_call',
  toolUseId: `t_${ts}`,
  name,
  summary: 'secret summary',
  input: { text: 'secret input' },
});
const text = (ts: string): ChatItem => ({
  id: `a_${ts}`,
  ts,
  kind: 'assistant_text',
  text: 'thinking aloud',
});
const result = (ts: string, ok: boolean): ChatItem => ({
  id: `r_${ts}`,
  ts,
  kind: 'tool_result',
  toolUseId: `t_${ts}`,
  ok,
  summary: 'secret error text',
});
const team = (ts: string, direction: 'in' | 'out'): ChatItem => ({
  id: `m_${ts}`,
  ts,
  kind: 'team_message',
  direction,
  from: 'owner',
  to: ['dev-1'],
  text: 'hello',
});

describe('workMetadataAfterChat', () => {
  it('takes a tool call and an outgoing team message as steps, and an incoming one as none', () => {
    expect(workMetadataAfterChat(undefined, [call(at(-30))], idle)).toEqual({
      lastWorkAt: at(-30),
      lastTool: { name: 'update_task', at: at(-30) },
      lastError: null,
    });
    expect(workMetadataAfterChat(undefined, [team(at(-20), 'out')], idle)).toMatchObject({
      lastWorkAt: at(-20),
      lastTool: null,
    });
    expect(workMetadataAfterChat(undefined, [team(at(-10), 'in')], idle)).toBeNull();
  });

  it('counts assistant text only while the session is working', () => {
    expect(workMetadataAfterChat(undefined, [text(at(-5))], idle)).toBeNull();
    expect(workMetadataAfterChat(undefined, [text(at(-5))], working)).toMatchObject({ lastWorkAt: at(-5) });
  });

  it('keeps only a code for a failed tool result, never its text', () => {
    const next = workMetadataAfterChat(undefined, [result(at(-3), false)], idle);
    expect(next).toEqual({
      lastWorkAt: null,
      lastTool: null,
      lastError: { code: TOOL_FAILED_CODE, at: at(-3) },
    });
    expect(JSON.stringify(next)).not.toContain('secret');
    expect(workMetadataAfterChat(undefined, [result(at(-3), true)], idle)).toBeNull();
  });

  it('keeps no text of the tool call', () => {
    expect(JSON.stringify(workMetadataAfterChat(undefined, [call(at(-1))], idle))).not.toContain('secret');
  });

  it('does not write forward when the items were seen or are earlier', () => {
    const current = workMetadataAfterChat(undefined, [call(at(-10))], idle)!;
    expect(workMetadataAfterChat(current, [call(at(-10))], idle)).toBeNull();
    expect(workMetadataAfterChat(current, [call(at(-60))], idle)).toBeNull();
    expect(workMetadataAfterChat(current, [call(at(-9), 'send_message')], idle)).toMatchObject({
      lastWorkAt: at(-9),
      lastTool: { name: 'send_message', at: at(-9) },
    });
    const failed = workMetadataAfterChat(undefined, [result(at(-3), false)], idle)!;
    expect(workMetadataAfterChat(failed, [result(at(-3), false)], idle)).toBeNull();
  });

  it('never goes beyond now, nor reads an unparsable time', () => {
    expect(workMetadataAfterChat(undefined, [call(at(600))], idle)).toMatchObject({ lastWorkAt: at(0) });
    expect(workMetadataAfterChat(undefined, [call('not a time')], idle)).toBeNull();
  });

  it('shortens a long tool name', () => {
    const next = workMetadataAfterChat(undefined, [call(at(-1), 'x'.repeat(300))], idle);
    expect(next?.lastTool?.name).toHaveLength(120);
  });
});
