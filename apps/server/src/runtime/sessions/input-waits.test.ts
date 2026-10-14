import type { Session } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainContext } from '../../core/base';
import { InputWaits } from './input-waits';
import { SessionTimers } from './session-timers';

const STALL = 10 * 60_000;

function sessionOf(state: Session['state'] = 'waiting_input'): Session {
  return { id: 's1', projectKey: 'PM', state } as Session;
}

describe('InputWaits', () => {
  const logger = { error: vi.fn(), warn: vi.fn() };
  let timers: SessionTimers;
  let stored: Session['state'] | undefined;
  let paused: boolean;
  const raise = vi.fn();
  let waits: InputWaits;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T10:00:00.000Z'));
    logger.warn.mockClear();
    raise.mockReset().mockReturnValue({ id: 'item' });
    stored = 'waiting_input';
    paused = false;
    timers = new SessionTimers(logger);
    const ctx = {
      now: () => new Date(),
      logger,
      repos: { sessions: { get: () => (stored ? { id: 's1', state: stored } : null) } },
    } as unknown as DomainContext;
    waits = new InputWaits({ ctx, timers, alerts: { raise }, stallMs: STALL, isPaused: () => paused });
  });
  afterEach(() => {
    timers.close();
    vi.useRealTimers();
  });

  it('tells the owners once, after the stall time', async () => {
    waits.watch(sessionOf());
    await vi.advanceTimersByTimeAsync(STALL - 1);
    expect(raise).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(raise).toHaveBeenCalledExactlyOnceWith('s1', '2026-10-14T10:00:00.000Z', 10);
    await vi.advanceTimersByTimeAsync(STALL * 2);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('does not start the wait again for a repeated state', async () => {
    waits.watch(sessionOf());
    await vi.advanceTimersByTimeAsync(STALL / 2);
    waits.watch(sessionOf());
    await vi.advanceTimersByTimeAsync(STALL / 2);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('drops the wait when the session leaves waiting_input', async () => {
    waits.watch(sessionOf());
    waits.watch(sessionOf('working'));
    await vi.advanceTimersByTimeAsync(STALL * 2);
    expect(raise).not.toHaveBeenCalled();
  });

  it('drops the wait when the session ends', async () => {
    waits.watch(sessionOf());
    waits.ended('s1');
    await vi.advanceTimersByTimeAsync(STALL * 2);
    expect(raise).not.toHaveBeenCalled();
  });

  it('says nothing when the wait ended some other way', async () => {
    waits.watch(sessionOf());
    stored = 'idle';
    await vi.advanceTimersByTimeAsync(STALL);
    expect(raise).not.toHaveBeenCalled();
  });

  it('says nothing while a pause holds the session', async () => {
    waits.watch(sessionOf());
    paused = true;
    await vi.advanceTimersByTimeAsync(STALL);
    expect(raise).not.toHaveBeenCalled();
  });

  it('watches the wait again after it fired', async () => {
    waits.watch(sessionOf());
    await vi.advanceTimersByTimeAsync(STALL);
    waits.watch(sessionOf());
    await vi.advanceTimersByTimeAsync(STALL);
    expect(raise).toHaveBeenCalledTimes(2);
  });

  it('logs an alert that fails', async () => {
    const err = new Error('no inbox');
    raise.mockImplementation(() => {
      throw err;
    });
    waits.watch(sessionOf());
    await vi.advanceTimersByTimeAsync(STALL);
    expect(logger.warn).toHaveBeenCalledWith({ err, sessionId: 's1' }, 'input wait alert failed');
  });

  it('forgets the waits at shutdown', async () => {
    waits.watch(sessionOf());
    waits.dispose();
    timers.close();
    await vi.advanceTimersByTimeAsync(STALL * 2);
    expect(raise).not.toHaveBeenCalled();
  });
});
