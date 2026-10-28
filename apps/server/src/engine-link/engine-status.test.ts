import { describe, expect, it } from 'vitest';
import { createRunningTracker } from './engine-status';

describe('the running sessions of the engine status', () => {
  const now = () => new Date('2026-10-09T10:00:00Z');

  it('adds who runs a session to its row, and nothing else of the spec', () => {
    const tracker = createRunningTracker(now);
    tracker.started({ sessionId: 's1', member: 'dev', provider: 'claude', displayName: 'Dev · PM-1' });
    expect(tracker.decorate([{ sessionId: 's1', state: 'working' }])).toEqual([
      {
        sessionId: 's1',
        state: 'working',
        member: 'dev',
        provider: 'claude',
        label: 'Dev · PM-1',
        startedAt: '2026-10-09T10:00:00.000Z',
      },
    ]);
  });

  it('leaves the row of a session it was not told about as the runner reports it', () => {
    const tracker = createRunningTracker(now);
    expect(tracker.decorate([{ sessionId: 's2', state: 'idle' }])).toEqual([
      { sessionId: 's2', state: 'idle' },
    ]);
  });

  it('forgets a session when it exits, and one the runner no longer lists', () => {
    const tracker = createRunningTracker(now);
    tracker.started({ sessionId: 's1', displayName: 'a' });
    tracker.started({ sessionId: 's2', displayName: 'b' });
    tracker.exited('s1');
    expect(tracker.decorate([{ sessionId: 's2', state: 'idle' }])).toHaveLength(1);
    // s2 vanished without an exit event; a later session with its id starts without the old details.
    expect(tracker.decorate([])).toEqual([]);
    expect(tracker.decorate([{ sessionId: 's2', state: 'idle' }])).toEqual([
      { sessionId: 's2', state: 'idle' },
    ]);
  });
});
