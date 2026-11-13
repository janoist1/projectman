import { describe, expect, it } from 'vitest';
import type { TeamMessage } from './message';
import {
  canSeeAllTeamMessages,
  canSeeProjectManagerSessions,
  canSeeTeamMessage,
  isUnreadBy,
  isCardMessage,
  messageConversationOf,
  sameWorkItem,
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

describe('stored message placement', () => {
  it.each([
    [{ fromHuman: true, toHuman: false }, 'direct'],
    [{ fromHuman: false, toHuman: true }, 'direct'],
    [{ fromHuman: false, toHuman: false }, undefined],
    ...['via', 'origin', 'answer', 'operatorRequest', 'operatorSignal'].map(
      (key) => [{ fromHuman: true, toHuman: false, [key]: 'present' }, undefined] as const,
    ),
  ] as const)('classifies %j at write time', (input, expected) => {
    expect(messageConversationOf(input as Parameters<typeof messageConversationOf>[0])).toBe(expected);
  });

  it('keeps legacy task messages on the card and excludes direct or general messages', () => {
    expect(isCardMessage({ taskKey: 'AR-1' })).toBe(true);
    expect(isCardMessage({ taskKey: 'AR-1', conversation: 'direct' })).toBe(false);
    expect(isCardMessage({ taskKey: null })).toBe(false);
  });
});

describe('team message visibility', () => {
  it('lets only an owner and an admin see every message', () => {
    expect(canSeeAllTeamMessages({ access: 'owner' })).toBe(true);
    expect(canSeeAllTeamMessages({ access: 'admin' })).toBe(true);
    for (const access of ['developer', 'viewer', 'client', 'ai'] as const)
      expect(canSeeAllTeamMessages({ access })).toBe(false);
  });

  it('lets only an owner and an admin see the project manager’s sessions (PM-475)', () => {
    expect(canSeeProjectManagerSessions({ access: 'owner' })).toBe(true);
    expect(canSeeProjectManagerSessions({ access: 'admin' })).toBe(true);
    for (const access of ['developer', 'viewer', 'client', 'ai'] as const)
      expect(canSeeProjectManagerSessions({ access })).toBe(false);
  });

  it('tells the project manager’s conversations apart by the person they are with (PM-475)', () => {
    const general = { type: 'general' } as const;
    expect(sameWorkItem(general, { type: 'general' })).toBe(true);
    expect(sameWorkItem({ type: 'general', with: 'cleo' }, { type: 'general', with: 'cleo' })).toBe(true);
    expect(sameWorkItem({ type: 'general', with: 'cleo' }, { type: 'general', with: 'dana' })).toBe(false);
    expect(sameWorkItem({ type: 'general', with: 'cleo' }, general)).toBe(false);
    expect(sameWorkItem(general, { type: 'general', with: 'cleo' })).toBe(false);
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
