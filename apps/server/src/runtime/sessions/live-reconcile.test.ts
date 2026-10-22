import type { Session } from '@projectman/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capturingLogger } from '../../../test/helpers/fakes';
import { LIVE_SESSION_SWEEP_GRACE_MS, LiveSessionSweep } from './live-reconcile';

describe('LiveSessionSweep', () => {
  let session: Session;
  let live: Session[];
  let running: boolean;
  let connected: boolean;
  let now: number;
  let sweep: LiveSessionSweep;
  let log: ReturnType<typeof capturingLogger>;
  const end = vi.fn();

  beforeEach(() => {
    now = Date.parse('2026-10-21T10:00:00.000Z');
    const at = new Date(now - LIVE_SESSION_SWEEP_GRACE_MS).toISOString();
    session = {
      id: 'ses_ghost',
      projectKey: 'PM',
      member: 'dev',
      workItem: { type: 'general' },
      claudeSessionId: 'conversation',
      cwd: '/workspace',
      branch: null,
      transcriptPath: null,
      state: 'working',
      activity: null,
      startedAt: at,
      lastActivityAt: at,
      endedAt: null,
    };
    live = [session];
    running = false;
    connected = true;
    log = capturingLogger();
    end.mockReset().mockImplementation((id: string) => {
      live = live.filter((s) => s.id !== id);
    });
    sweep = new LiveSessionSweep({
      listLive: () => live,
      isRunning: () => running,
      engineConnected: () => connected,
      end,
      now: () => now,
      logger: log.logger,
    });
  });

  it('ends a session on the second missing round, including at the grace boundary', () => {
    session.engineId = 'eng_abcdefghijkl';
    sweep.sweep();
    expect(end).not.toHaveBeenCalled();
    expect(log.warnings).toEqual([]);

    now += 60_000;
    sweep.sweep();
    expect(end).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(log.warnings).toEqual([
      [{ sessionId: session.id, member: session.member, engineId: session.engineId }, expect.any(String)],
    ]);
  });

  it.each([
    {
      name: 'a running process',
      skip: () => {
        running = true;
      },
      restore: () => {
        running = false;
      },
    },
    {
      name: 'a starting session',
      skip: () => {
        session.state = 'starting';
      },
      restore: () => {
        session.state = 'working';
      },
    },
    {
      name: 'a disconnected engine',
      skip: () => {
        connected = false;
      },
      restore: () => {
        connected = true;
      },
    },
    {
      name: 'a recent start',
      skip: () => {
        session.startedAt = new Date(now - LIVE_SESSION_SWEEP_GRACE_MS + 1).toISOString();
      },
      restore: () => {
        session.startedAt = session.lastActivityAt;
      },
    },
    {
      name: 'recent activity',
      skip: () => {
        session.lastActivityAt = new Date(now - LIVE_SESSION_SWEEP_GRACE_MS + 1).toISOString();
      },
      restore: () => {
        session.lastActivityAt = session.startedAt;
      },
    },
  ])('skips $name and clears its previous missing round', ({ skip, restore }) => {
    sweep.sweep();
    skip();
    sweep.sweep();
    sweep.sweep();
    expect(end).not.toHaveBeenCalled();

    restore();
    sweep.sweep();
    expect(end).not.toHaveBeenCalled();
    sweep.sweep();
    expect(end).toHaveBeenCalledExactlyOnceWith(session.id);
  });

  it('forgets sessions that are no longer live', () => {
    sweep.sweep();
    live = [];
    sweep.sweep();

    live = [session];
    sweep.sweep();
    expect(end).not.toHaveBeenCalled();
    sweep.sweep();
    expect(end).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(log.warnings[0]).toEqual([
      { sessionId: session.id, member: session.member, engineId: 'local' },
      expect.any(String),
    ]);
  });
});
