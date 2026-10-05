import { describe, expect, it } from 'vitest';
import { SessionStop, SessionStopKind } from './involvement';

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
