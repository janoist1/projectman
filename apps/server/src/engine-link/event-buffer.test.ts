import { describe, expect, it } from 'vitest';
import { createEngineEventBuffer } from './event-buffer';
import { decodeFrame } from './protocol';

describe('engine event buffer', () => {
  it.each([undefined, '2026-10-25T05:10:58.000Z'])(
    'carries a provider quota event with reset %s',
    (resetsAt) => {
      const event = {
        kind: 'runner' as const,
        event: {
          type: 'rate_limited' as const,
          sessionId: 'ses_test',
          provider: 'gemini' as const,
          message: 'Individual quota reached',
          at: '2026-10-22T12:00:00.000Z',
          ...(resetsAt ? { resetsAt } : {}),
        },
      };
      const buffer = createEngineEventBuffer();
      const sent: string[] = [];
      buffer.emit(event);
      buffer.connect((data) => sent.push(data), 0);
      expect(sent.map(decodeFrame)).toEqual([{ t: 'evt', seq: 1, event }]);
    },
  );
  it('replays only unacknowledged sequenced events and never terminal output', () => {
    const buffer = createEngineEventBuffer();
    const sent: string[] = [];
    buffer.emit({ kind: 'pending_input', sessionId: 'ses_test', pending: true });
    buffer.terminal('ses_test', 'offline output');
    expect(buffer.nextSeq()).toBe(1);
    buffer.connect((data) => sent.push(data), 0);
    expect(sent.map(decodeFrame)).toEqual([
      { t: 'evt', seq: 1, event: { kind: 'pending_input', sessionId: 'ses_test', pending: true } },
    ]);
    buffer.terminal('ses_test', 'online output');
    buffer.acknowledge(1);
    expect(buffer.nextSeq()).toBe(2);
    buffer.disconnect();
    buffer.emit({ kind: 'screenshot_started', runId: 'run' });
    buffer.connect((data) => sent.push(data), 1);
    expect(sent.map(decodeFrame).map((frame) => frame.t)).toEqual(['evt', 'term', 'evt']);
    expect(buffer.pending()).toBe(1);
    expect(() => buffer.acknowledge(3)).toThrow();
    buffer.disconnect();
    buffer.connect((data) => sent.push(data), 0);
    expect(buffer.pending()).toBe(1);
  });
});
