import { describe, expect, it } from 'vitest';
import { quoteOf, SessionStartCause, SessionStop, SessionStopKind } from './involvement';

describe('quoteOf', () => {
  it.each([
    ['', ''],
    ['\n\n# A short sentence. Another one.', 'A short sentence.'],
    ['> - `Hello! More text.', 'Hello!'],
    ['First\nSecond', 'First'],
    ['A   short   question? Yes.', 'A short question?'],
  ])('quotes %j as %j', (input, expected) => expect(quoteOf(input)).toBe(expected));
  it('truncates at the last word and keeps the ellipsis within the limit', () => {
    expect(quoteOf('One two three four five six', 14)).toBe('One two three…');
    expect(quoteOf('abcdefghijklmnop', 6)).toBe('abcde…');
  });
  it('keeps integrator attribution in a start cause', () => {
    expect(
      SessionStartCause.parse({
        kind: 'message',
        by: { kind: 'human', handle: 'owner', via: 'integrator' },
        messageId: 'msg_1',
        quote: 'Hello.',
      }).by?.via,
    ).toBe('integrator');
  });
});

describe('SessionStop', () => {
  it.each([
    { kind: 'step_done', taskKey: 'AR-1', stageId: 'code_review' },
    { kind: 'sent_back', taskKey: 'AR-1', stageId: 'development' },
    { kind: 'idle', idleMinutes: 15 },
    { kind: 'pause' },
    { kind: 'manual', by: { kind: 'human', handle: 'owner' }, note: 'Wrong card' },
    { kind: 'restart', restartFor: 'new_round' },
  ])('accepts %j', (stop) => {
    expect(SessionStop.parse(stop)).toEqual(stop);
  });

  it.each([
    { kind: 'unknown' },
    { kind: 'idle', idleMinutes: 0 },
    { kind: 'idle', idleMinutes: 1.5 },
    { kind: 'restart', restartFor: 'whim' },
    { kind: 'step_done', taskKey: 'not a key' },
    { kind: 'manual', note: '' },
    {},
  ])('refuses %j', (stop) => {
    expect(SessionStop.safeParse(stop).success).toBe(false);
  });

  it('has the kinds of the involvement and the closing together', () => {
    expect(SessionStopKind.options).toEqual(
      expect.arrayContaining(['manual', 'task_cancelled', 'sent_back', 'step_done', 'idle', 'pause']),
    );
  });
});
