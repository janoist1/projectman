import { describe, expect, it } from 'vitest';
import type { TeamMessage } from './message';
import {
  canSeeAllTeamMessages,
  canSeeTeamMessage,
  cardThreadRecipients,
  isUnreadBy,
  threadPeersOf,
} from './message';

const message = (from: string, to: string[], readBy: string[] = []) =>
  ({
    from,
    to,
    receipts: to.map((handle) => ({
      handle,
      kind: 'human',
      deliveredAt: null,
      readAt: readBy.includes(handle) ? '2026-10-02T10:00:00.000Z' : null,
    })),
  }) as Pick<TeamMessage, 'from' | 'to' | 'receipts'>;

describe('team message visibility', () => {
  it('lets only an owner and an admin see every message', () => {
    expect(canSeeAllTeamMessages({ access: 'owner' })).toBe(true);
    expect(canSeeAllTeamMessages({ access: 'admin' })).toBe(true);
    for (const access of ['developer', 'viewer', 'client', 'ai'] as const)
      expect(canSeeAllTeamMessages({ access })).toBe(false);
  });

  it('shows everyone else only what they sent or got', () => {
    const m = message('qa', ['designer', 'dev']);
    expect(canSeeTeamMessage({ access: 'owner', handle: 'owner' }, m)).toBe(true);
    expect(canSeeTeamMessage({ access: 'admin', handle: 'boss' }, m)).toBe(true);
    expect(canSeeTeamMessage({ access: 'ai', handle: 'qa' }, m)).toBe(true);
    expect(canSeeTeamMessage({ access: 'developer', handle: 'dev' }, m)).toBe(true);
    expect(canSeeTeamMessage({ access: 'viewer', handle: 'reader' }, m)).toBe(false);
    expect(canSeeTeamMessage({ access: 'client', handle: 'acme' }, m)).toBe(false);
  });
});

describe('isUnreadBy', () => {
  it('is true for a recipient who has not read the message', () => {
    const m = message('qa', ['dev', 'owner'], ['owner']);
    expect(isUnreadBy(m, 'dev')).toBe(true);
    expect(isUnreadBy(m, 'owner')).toBe(false);
  });

  it('is false for the sender, an outsider and no viewer', () => {
    const m = message('qa', ['dev']);
    expect(isUnreadBy(m, 'qa')).toBe(false);
    expect(isUnreadBy(m, 'other')).toBe(false);
    expect(isUnreadBy(m, null)).toBe(false);
  });

  it('counts a message without receipts as unread', () => {
    expect(isUnreadBy({ to: ['dev'] }, 'dev')).toBe(true);
  });
});

describe('threadPeersOf', () => {
  const m = message('a', ['b', 'c']);

  it('puts a message in the sender thread with each recipient', () => {
    expect(threadPeersOf(m, 'a')).toEqual(['b', 'c']);
  });

  it('puts a message in a recipient thread with the sender only', () => {
    expect(threadPeersOf(m, 'b')).toEqual(['a']);
    expect(threadPeersOf(m, 'c')).toEqual(['a']);
  });

  it('puts it in no thread of anyone else', () => {
    expect(threadPeersOf(m, 'd')).toEqual([]);
  });

  it('leaves the sender out of their own thread list', () => {
    expect(threadPeersOf(message('a', ['a', 'b']), 'a')).toEqual(['b']);
  });
});

describe('cardThreadRecipients', () => {
  const base = {
    workers: ['dev', 'qa'],
    assignee: 'claude',
    stageOwners: ['architect'],
    writer: 'owner',
    canReceive: () => true,
  };

  it('goes to the members working on the card first', () => {
    expect(cardThreadRecipients(base)).toEqual({ basis: 'workers', to: ['dev', 'qa'] });
  });

  it('falls back to the assignee, then to the stage owners, then to nobody', () => {
    const idle = { ...base, workers: [] };
    expect(cardThreadRecipients(idle)).toEqual({ basis: 'assignee', to: ['claude'] });
    expect(cardThreadRecipients({ ...idle, assignee: null })).toEqual({
      basis: 'stage_owners',
      to: ['architect'],
    });
    expect(cardThreadRecipients({ ...idle, assignee: null, stageOwners: [] })).toEqual({
      basis: 'none',
      to: [],
    });
  });

  it('leaves out the writer and members who cannot receive', () => {
    expect(
      cardThreadRecipients({ ...base, workers: ['owner', 'dev', 'qa'], canReceive: (h) => h !== 'qa' }),
    ).toEqual({ basis: 'workers', to: ['dev'] });
  });

  it('falls through when every worker is excluded', () => {
    expect(cardThreadRecipients({ ...base, workers: ['owner'], assignee: 'claude' })).toEqual({
      basis: 'assignee',
      to: ['claude'],
    });
    expect(cardThreadRecipients({ ...base, workers: [], assignee: 'owner' })).toEqual({
      basis: 'stage_owners',
      to: ['architect'],
    });
  });
});
