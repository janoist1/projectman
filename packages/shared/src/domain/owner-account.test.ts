import { describe, expect, it } from 'vitest';
import { canCreateEngine, canCreateProject, canManageEngine, isOwnerAccount } from './owner-account';

describe('owner account rules', () => {
  it.each([
    ['no row', null, false],
    ['an active row', { revokedAt: null }, true],
    ['a revoked row', { revokedAt: '2026-10-27T10:00:00.000Z' }, false],
  ])('knows %s', (_name, row, expected) => {
    expect(isOwnerAccount(row)).toBe(expected);
  });

  it.each([
    ['the host owner', { isHostOwner: true, isOwnerAccount: false }, true],
    ['an owner account', { isHostOwner: false, isOwnerAccount: true }, true],
    ['anyone else', { isHostOwner: false, isOwnerAccount: false }, false],
  ])('lets %s create projects and engines as the rules say', (_name, input, expected) => {
    expect(canCreateProject(input)).toBe(expected);
    expect(canCreateEngine(input)).toBe(expected);
  });

  it.each([
    ['the host owner, any engine', { isHostOwner: true, actorUserId: 'u1', engineOwnerUserId: 'u2' }, true],
    ['an owner account, its own', { isHostOwner: false, actorUserId: 'u2', engineOwnerUserId: 'u2' }, true],
    [
      'an owner account, another one',
      { isHostOwner: false, actorUserId: 'u1', engineOwnerUserId: 'u2' },
      false,
    ],
  ])('lets %s manage', (_name, input, expected) => {
    expect(canManageEngine(input)).toBe(expected);
  });
});
