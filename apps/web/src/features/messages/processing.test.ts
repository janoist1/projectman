import { describe, expect, it } from 'vitest';
import type { MessageProcessing } from '@projectman/shared';
import { processingView } from './processing';

const at = '2026-11-07T10:00:00.000Z';

describe('the tone of a processing state (PM-1305)', () => {
  it.each<[string, string, MessageProcessing]>([
    [
      'a state that needs attention',
      'warn',
      { handle: 'be-1', state: 'stale', cause: 'no_report', lastSeenAt: at },
    ],
    ['a message that was not sent', 'warn', { handle: 'be-1', state: 'not_sent' }],
    ['a wait for an answer', 'neutral', { handle: 'be-1', state: 'waiting', reason: 'input', since: at }],
    ['a turn that ended without an answer', 'neutral', { handle: 'be-1', state: 'turn_ended', at }],
    ['work in progress', 'progress', { handle: 'be-1', state: 'working', since: at }],
    ['an answer', 'ok', { handle: 'be-1', state: 'replied', at, reply: { eventId: 'evt_1' } }],
  ])('colours %s as %s', (_name, tone, item) => {
    expect(processingView(item).tone).toBe(tone);
  });

  it('keeps the why and what-next line apart from the label', () => {
    const view = processingView({ handle: 'be-1', state: 'waiting', reason: 'paused', since: at });
    expect(view.detail).toBeTruthy();
    expect(view.detail).not.toBe(view.label);
  });
});
