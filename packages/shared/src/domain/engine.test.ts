import { describe, expect, it } from 'vitest';
import { canBindEngine, canSeeEngine, canSeeEngineMachine, canUnbindEngine, projectEngineOf } from './engine';
import type { ProjectEngineBinding } from './engine';

const A = 'eng_aaaaaaaaaaaa';
const B = 'eng_bbbbbbbbbbbb';
const binding = (engineId: string, isDefault: boolean, revoked = false): ProjectEngineBinding => ({
  engineId,
  isDefault,
  revoked,
});

describe('projectEngineOf', () => {
  it.each([
    ['the default binding while its engine is live', [binding(A, false), binding(B, true)], ['usr_x'], B],
    [
      'nothing when the default binding is revoked: no move to another machine',
      [binding(A, false), binding(B, true, true)],
      ['usr_host'],
      null,
    ],
    ['the global default when its owner owns the project', [], ['usr_x', 'usr_host'], A],
    ['nothing when the global default belongs to someone else', [], ['usr_x'], null],
  ] as const)('chooses %s', (_name, bindings, projectOwnerUserIds, expected) => {
    expect(
      projectEngineOf({
        bindings,
        globalDefault: { id: A, ownerUserId: 'usr_host' },
        projectOwnerUserIds,
        projectCreatedBy: null,
      }),
    ).toBe(expected);
  });

  it('chooses nothing without a binding and without a global default', () => {
    expect(
      projectEngineOf({
        bindings: [],
        globalDefault: null,
        projectOwnerUserIds: ['usr_host'],
        projectCreatedBy: null,
      }),
    ).toBeNull();
  });

  // The fallback to the host's machine rests on who created the project too: a configuration that names the
  // host as an owner is not enough (PM-1062).
  it.each([
    ['the host owner registered it', null, ['usr_x', 'usr_host'], A],
    ['the host owner created it', 'usr_host', ['usr_x', 'usr_host'], A],
    ['another user created it, although the host is named an owner', 'usr_x', ['usr_x', 'usr_host'], null],
  ] as const)(
    'falls back to the global default only when %s',
    (_name, projectCreatedBy, owners, expected) => {
      expect(
        projectEngineOf({
          bindings: [],
          globalDefault: { id: A, ownerUserId: 'usr_host' },
          projectOwnerUserIds: owners,
          projectCreatedBy,
        }),
      ).toBe(expected);
    },
  );

  it('keeps an explicit binding whoever created the project', () => {
    expect(
      projectEngineOf({
        bindings: [binding(A, true)],
        globalDefault: { id: B, ownerUserId: 'usr_host' },
        projectOwnerUserIds: ['usr_host'],
        projectCreatedBy: 'usr_x',
      }),
    ).toBe(A);
  });
});

describe('binding rules', () => {
  const actor = (actorUserId: string, engineOwnerUserId: string, actorIsProjectOwner: boolean) => ({
    actorUserId,
    engineOwnerUserId,
    actorIsProjectOwner,
  });

  it.each([
    ['the engine owner who owns the project', actor('u1', 'u1', true), true, true],
    ['the engine owner who does not own the project', actor('u1', 'u1', false), false, true],
    ['the project owner who does not own the engine', actor('u2', 'u1', true), false, true],
    ['someone with neither', actor('u2', 'u1', false), false, false],
  ])('lets %s decide as the rules say', (_name, input, canBind, canUnbind) => {
    expect(canBindEngine(input)).toBe(canBind);
    expect(canUnbindEngine(input)).toBe(canUnbind);
  });
});

describe('engine visibility (PM-1061)', () => {
  const viewer = (viewerUserId: string, viewerIsHostOwner: boolean, engineOwnerUserId: string) => ({
    viewerUserId,
    viewerIsHostOwner,
    engineOwnerUserId,
  });

  it.each([
    ['the host owner', viewer('usr_host', true, 'usr_other'), false, true, true],
    [
      'the engine’s owner without a project on it',
      viewer('usr_other', false, 'usr_other'),
      false,
      true,
      true,
    ],
    ['a member of a project that uses it', viewer('usr_member', false, 'usr_other'), true, true, false],
    ['someone with no project on it', viewer('usr_member', false, 'usr_other'), false, false, false],
  ])('shows an engine to %s as the rules say', (_name, input, usedByViewerProject, sees, seesMachine) => {
    expect(canSeeEngine({ ...input, usedByViewerProject })).toBe(sees);
    expect(canSeeEngineMachine(input)).toBe(seesMachine);
  });
});
