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

  it('comes after a closed one only when a whole window has passed since it was raised', () => {
    expect(alertFor(10, [{ open: false, at: '2026-10-01T11:50:00.000Z' }])).toBeNull();
    expect(alertFor(10, [{ open: false, at: '2026-10-01T11:45:00.001Z' }])).toBeNull();
    expect(alertFor(10, [{ open: false, at: '2026-10-01T11:45:00.000Z' }])).not.toBeNull();
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
