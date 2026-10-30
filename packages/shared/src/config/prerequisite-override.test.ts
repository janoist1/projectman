import { describe, expect, it } from 'vitest';
import type { Actor } from '../domain/event';
import { mayOverridePrerequisites, prerequisiteOverrideOf } from './prerequisite-override';
import type { PrerequisiteOverride } from './schema';

const credential = { id: 'ikey_1', prefix: 'pmi_abcdefgh' };

function configWith(prerequisiteOverride?: PrerequisiteOverride) {
  return {
    team: {
      ...(prerequisiteOverride ? { prerequisiteOverride } : {}),
      members: [
        { kind: 'human', handle: 'owner', access: 'owner' },
        { kind: 'ai', handle: 'dev', role: 'developer' },
        { kind: 'ai', handle: 'pm', role: 'project_manager' },
      ],
      roles: [],
    },
  } as never;
}

const human: Actor = { kind: 'human', handle: 'owner' };
const pm: Actor = { kind: 'ai', handle: 'pm' };
const pmViaIntegrator: Actor = { kind: 'ai', handle: 'pm', via: 'integrator' };
const coordinatorSuper: Actor = {
  kind: 'ai',
  handle: 'pm',
  via: 'integrator',
  operatorMode: 'super',
  credential,
};
const developer: Actor = { kind: 'ai', handle: 'dev' };

describe('the prerequisite override (PM-1099)', () => {
  it('defaults to people only', () => {
    expect(prerequisiteOverrideOf(configWith())).toBe('people');
  });

  it.each<[string, Actor, PrerequisiteOverride | undefined, boolean]>([
    ['a person by default', human, undefined, true],
    ['a person when the project manager may too', human, 'people_and_project_manager', true],
    ['the project manager by default', pm, undefined, false],
    ['the project manager when people only', pm, 'people', false],
    ['the project manager when the project allows it', pm, 'people_and_project_manager', true],
    ['the project manager through an integrator', pmViaIntegrator, 'people_and_project_manager', false],
    ['the coordinator on the owner request, whatever the setting', coordinatorSuper, 'people', true],
    ['another AI member even when the project manager may', developer, 'people_and_project_manager', false],
  ])('honors the flag of %s: %s', (_name, actor, setting, expected) => {
    expect(mayOverridePrerequisites(configWith(setting), actor)).toBe(expected);
  });
});
