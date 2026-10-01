import { describe, expect, it } from 'vitest';
import { applyConfigPatch, PatchConfigRequest } from '../config/edit';
import { DEFAULT_MESSAGE_BURST, TeamLimits } from '../config/schema';
import { burstMembers, messageBurstAlertFor, messageBurstOf, messageBurstSince } from './message-burst';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ createdAt: NOW.toISOString(), actor: i % 2 ? 'cr' : 'owner' }));
const alertFor = (n: number, earlier: { open: boolean; at: string }[] = []) =>
  messageBurstAlertFor({
    taskKey: 'AR-1',
    burst: DEFAULT_MESSAGE_BURST,
    now: NOW,
    entries: entries(n),
    earlier,
  });

describe('the message storm threshold', () => {
  it('is 10 in 15 minutes unless the limits name one', () => {
    expect(messageBurstOf({})).toEqual({ count: 10, minutes: 15 });
    expect(messageBurstOf({ messageBurst: { count: 3, minutes: 1 } })).toEqual({ count: 3, minutes: 1 });
  });

  it('takes a count of 3 to 100 and minutes of 1 to 240', () => {
    const parse = (messageBurst: unknown) => TeamLimits.safeParse({ messageBurst }).success;
    expect(parse({ count: 3, minutes: 1 })).toBe(true);
    expect(parse({ count: 100, minutes: 240 })).toBe(true);
    expect(parse({ count: 2, minutes: 15 })).toBe(false);
    expect(parse({ count: 101, minutes: 15 })).toBe(false);
    expect(parse({ count: 10, minutes: 0 })).toBe(false);
    expect(parse({ count: 10, minutes: 241 })).toBe(false);
    expect(parse({ count: 10.5, minutes: 15 })).toBe(false);
  });

  it('is set by a patch and kept when a patch does not name it', () => {
    const base = { team: { limits: TeamLimits.parse({}) } } as Parameters<typeof applyConfigPatch>[0];
    const patch = (limits: Record<string, unknown>) =>
      PatchConfigRequest.parse({ baseVersion: 'v1', limits });
    const set = applyConfigPatch(base, patch({ messageBurst: { count: 5, minutes: 30 } }));
    expect(set.team.limits.messageBurst).toEqual({ count: 5, minutes: 30 });
    expect(applyConfigPatch(set, patch({ aiEnabled: false })).team.limits.messageBurst).toEqual({
      count: 5,
      minutes: 30,
    });
    expect(() => patch({ messageBurst: { count: 2, minutes: 30 } })).toThrow();
  });
});

describe('the message storm alert', () => {
  it('starts the window one threshold-length before now', () => {
    expect(messageBurstSince(DEFAULT_MESSAGE_BURST, NOW)).toBe('2026-10-01T11:45:00.000Z');
  });

  it('comes at the threshold and not below it', () => {
    expect(alertFor(9)).toBeNull();
    expect(alertFor(10)).toEqual({
      alert: 'message_burst',
      taskKey: 'AR-1',
      count: 10,
      minutes: 15,
      members: ['owner', 'cr'],
      at: NOW.toISOString(),
    });
  });

  it('does not come while an earlier one is open', () => {
    expect(alertFor(10, [{ open: true, at: '2026-10-01T09:00:00.000Z' }])).toBeNull();
  });

  describe('after a closed one', () => {
    // The last alert was raised at 12:00; `later` are the entries since, in minutes after it, and
    // the newest of them is now.
    const closed = [{ open: false, at: NOW.toISOString() }];
    const later = (...minutes: number[]) => {
      const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
      return messageBurstAlertFor({
        taskKey: 'AR-1',
        burst: DEFAULT_MESSAGE_BURST,
        now: at(minutes.at(-1)!),
        entries: minutes.map((m) => ({ createdAt: at(m).toISOString(), actor: 'owner' })),
        earlier: closed,
      });
    };
    const every = (from: number, to: number, step = 1) =>
      Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

    it('stays quiet while the storm goes on, however long after the owner saw it', () => {
      // One entry a minute for two hours.
      for (const end of [10, 15, 16, 30, 60, 120]) expect(later(...every(1, end))).toBeNull();
    });

    it('comes for a new storm after a whole window of quiet', () => {
      expect(later(...every(20, 29))).toMatchObject({ count: 10, at: '2026-10-01T12:29:00.000Z' });
      // A trickle below the threshold is quiet too.
      expect(later(...every(2, 62, 10), ...every(70, 79))).not.toBeNull();
    });

    it('counts the quiet from the alert to the first entry of the storm, ends included', () => {
      const burst = Array.from({ length: 10 }, () => 15);
      expect(later(...burst)).not.toBeNull();
      expect(later(...burst.map(() => 14.99))).toBeNull();
    });

    it('needs a whole window of quiet between storms, not only before the first entry', () => {
      // A storm of 10 in the first 5 minutes, and the next one 10 minutes after it ends: the quiet
      // in between (while fewer than 10 fell in any window) is shorter than 15 minutes.
      expect(later(...every(1, 5.5, 0.5), ...every(15, 20, 0.5))).toBeNull();
      // With the next one 30 minutes later the quiet is long enough.
      expect(later(...every(1, 5.5, 0.5), ...every(35, 40, 0.5))).not.toBeNull();
    });

    it('leaves out what was written up to the alert', () => {
      const entriesBefore = Array.from({ length: 10 }, () => ({
        createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
        actor: 'owner',
      }));
      expect(
        messageBurstAlertFor({
          taskKey: 'AR-1',
          burst: DEFAULT_MESSAGE_BURST,
          now: new Date(NOW.getTime() + 30_000),
          entries: entriesBefore,
          earlier: closed,
        }),
      ).toBeNull();
    });

    /** The alerts raised for a conversation entry by entry, each seen (closed) at once. */
    const alertsFor = (minutes: number[]) => {
      const raised: string[] = [];
      const written: { createdAt: string; actor: string }[] = [];
      for (const m of minutes) {
        const now = new Date(NOW.getTime() + m * 60_000);
        written.push({ createdAt: now.toISOString(), actor: 'owner' });
        const alert = messageBurstAlertFor({
          taskKey: 'AR-1',
          burst: DEFAULT_MESSAGE_BURST,
          now,
          entries: written,
          earlier: raised.map((at) => ({ open: false, at })),
        });
        if (alert) raised.push(alert.at);
      }
      return raised;
    };

    it('stays quiet for a storm near the threshold, whose old entries keep the windows hot', () => {
      // One entry every 95 seconds for about two hours: 9 or 10 in every window.
      expect(alertsFor(Array.from({ length: 80 }, (_, i) => (i * 95) / 60))).toHaveLength(1);
      // Ten at once every quarter of an hour.
      expect(alertsFor(Array.from({ length: 80 }, (_, i) => Math.floor(i / 10) * 15))).toHaveLength(1);
    });

    it('speaks again for a storm after a whole quiet window', () => {
      const storm = (from: number) => Array.from({ length: 10 }, (_, i) => from + i);
      expect(alertsFor([...storm(0), ...storm(40)])).toHaveLength(2);
      expect(alertsFor([...storm(0), ...storm(20)])).toHaveLength(1);
    });

    it('does not take a list cut short for a quiet one', () => {
      // The list begins at 12:50: what came before is unknown, and the storm there may be on.
      const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
      expect(
        messageBurstAlertFor({
          taskKey: 'AR-1',
          burst: DEFAULT_MESSAGE_BURST,
          now: at(60),
          entries: every(51, 60).map((m) => ({ createdAt: at(m).toISOString(), actor: 'owner' })),
          earlier: closed,
          coveredFrom: at(50).toISOString(),
        }),
      ).toBeNull();
    });
  });

  it('names who wrote and who was written to once each', () => {
    expect(
      burstMembers([
        { createdAt: 'x', actor: 'owner', to: ['cr', 'dev-1'] },
        { createdAt: 'x', actor: 'cr', to: ['owner'] },
        { createdAt: 'x', actor: null },
      ]),
    ).toEqual(['owner', 'cr', 'dev-1']);
  });
});
