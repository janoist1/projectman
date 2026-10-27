import { describe, expect, it } from 'vitest';
import { canBindEngine, canUnbindEngine, projectEngineOf } from './engine';
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
      projectEngineOf({ bindings, globalDefault: { id: A, ownerUserId: 'usr_host' }, projectOwnerUserIds }),
    ).toBe(expected);
  });

  it('chooses nothing without a binding and without a global default', () => {
    expect(
      projectEngineOf({ bindings: [], globalDefault: null, projectOwnerUserIds: ['usr_host'] }),
    ).toBeNull();
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
