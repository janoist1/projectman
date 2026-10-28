import type { Session } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTimers } from './session-timers';
import { TurnFinishes } from './turn-finish';

const LIMIT = 5 * 60_000;
const session = { id: 's1', projectKey: 'PM' } as Session;

describe('TurnFinishes', () => {
  const logger = { error: vi.fn(), info: vi.fn() };
  const cleanUp = vi.fn();
  let timers: SessionTimers;
  let turns: TurnFinishes;

  beforeEach(() => {
    vi.useFakeTimers();
    logger.info.mockClear();
    cleanUp.mockReset();
    timers = new SessionTimers(logger);
    turns = new TurnFinishes({ logger: logger as never, timers, limitMs: LIMIT, cleanUp });
  });
  afterEach(() => {
    timers.close();
    vi.useRealTimers();
  });

  it('cleans up once when the turn ends, and the limit no longer fires', async () => {
    turns.wait(session, 'PM-1');
    turns.ended('s1');
    expect(cleanUp).toHaveBeenCalledExactlyOnceWith('PM', 'PM-1');
    turns.ended('s1');
    await vi.advanceTimersByTimeAsync(LIMIT * 2);
    expect(cleanUp).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up at the limit, once', async () => {
    turns.wait(session, 'PM-1');
    await vi.advanceTimersByTimeAsync(LIMIT - 1);
    expect(cleanUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cleanUp).toHaveBeenCalledExactlyOnceWith('PM', 'PM-1');
    expect(logger.info).toHaveBeenCalledWith(
      { sessionId: 's1', taskKey: 'PM-1' },
      'done task: the turn limit passed',
    );
    turns.ended('s1');
    expect(cleanUp).toHaveBeenCalledTimes(1);
  });

  it('keeps the first deadline when it waits again', async () => {
    turns.wait(session, 'PM-1');
    await vi.advanceTimersByTimeAsync(LIMIT / 2);
    turns.wait(session, 'PM-2');
    await vi.advanceTimersByTimeAsync(LIMIT / 2);
    expect(cleanUp).toHaveBeenCalledExactlyOnceWith('PM', 'PM-1');
  });

  it('does nothing for a session that is not finishing', () => {
    turns.ended('s1');
    expect(cleanUp).not.toHaveBeenCalled();
  });

  it('forgets the waits at shutdown: a later end does nothing', async () => {
    turns.wait(session, 'PM-1');
    turns.dispose();
    timers.close();
    turns.ended('s1');
    await vi.advanceTimersByTimeAsync(LIMIT * 2);
    expect(cleanUp).not.toHaveBeenCalled();
  });
});
