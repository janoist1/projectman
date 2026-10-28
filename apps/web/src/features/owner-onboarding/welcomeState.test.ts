import { describe, expect, it } from 'vitest';
import type { EngineView } from '@projectman/shared';
import { currentEngine, ownEngines, pmProvider, welcomeStep } from './welcomeState';

function engine(patch: Partial<EngineView>): EngineView {
  return {
    id: 'eng_aaaaaaaaaaaa',
    name: 'Laptop',
    isDefault: false,
    online: false,
    lastSeenAt: null,
    keyPrefix: 'pme_0001',
    createdAt: '2026-10-01T10:00:00.000Z',
    createdBy: 'usr_1',
    revokedAt: null,
    lastSeenIp: null,
    hostname: null,
    platform: null,
    version: null,
    versionMismatch: false,
    providers: [],
    runningSessions: 0,
    waitingStarts: 0,
    waitingMessages: 0,
    ownedByMe: true,
    ...patch,
  };
}
const loggedIn = (provider: 'claude' | 'codex', value: boolean | null) => ({ provider, loggedIn: value });

describe('welcomeStep', () => {
  it.each([
    ['no machine', null, null, 1],
    ['a machine that has not connected', { online: false }, null, 2],
    ['a connected machine that has not answered yet', { online: true }, null, 3],
    ['a connected machine without a login', { online: true }, [loggedIn('claude', false)], 3],
    [
      'a connected machine with a login',
      { online: true },
      [loggedIn('claude', false), loggedIn('codex', true)],
      4,
    ],
  ] as const)('puts %s at step %i', (_name, machine, logins, step) => {
    expect(welcomeStep(machine, logins)).toBe(step);
  });
});

describe('ownEngines', () => {
  it('keeps only the machines of the owner that are not revoked', () => {
    const mine = engine({ id: 'eng_bbbbbbbbbbbb' });
    const list = [
      mine,
      engine({ id: 'eng_cccccccccccc', ownedByMe: false }),
      engine({ id: 'eng_dddddddddddd', revokedAt: '2026-10-02T10:00:00.000Z' }),
    ];
    expect(ownEngines(list)).toEqual([mine]);
  });
});

describe('currentEngine', () => {
  it('prefers the latest connected machine over a newer one that is offline', () => {
    const online = engine({ id: 'eng_bbbbbbbbbbbb', online: true, createdAt: '2026-10-02T10:00:00.000Z' });
    const newerOffline = engine({ id: 'eng_cccccccccccc', createdAt: '2026-10-03T10:00:00.000Z' });
    expect(currentEngine([newerOffline, online])?.id).toBe(online.id);
  });

  it('falls back to the latest created machine and to none', () => {
    const older = engine({ id: 'eng_bbbbbbbbbbbb' });
    const newer = engine({ id: 'eng_cccccccccccc', createdAt: '2026-10-03T10:00:00.000Z' });
    expect(currentEngine([older, newer])?.id).toBe(newer.id);
    expect(currentEngine([])).toBeNull();
  });
});

describe('pmProvider', () => {
  it.each([
    [[loggedIn('claude', false), loggedIn('codex', true)], 'codex'],
    [[loggedIn('claude', false)], 'claude'],
  ] as const)('is the first logged-in provider, else Claude', (logins, expected) => {
    expect(pmProvider(logins)).toBe(expected);
  });
});
