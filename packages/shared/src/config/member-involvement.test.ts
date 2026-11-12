import { describe, expect, it } from 'vitest';
import type { Actor } from '../domain/event';
import { mayInvolveMembers, memberInvolvementOf } from './member-involvement';
import type { MemberInvolvement } from './schema';

const credential = { id: 'ikey_1', prefix: 'pmi_abcdefgh' };

function configWith(memberInvolvement?: MemberInvolvement) {
  return {
    team: {
      ...(memberInvolvement ? { memberInvolvement } : {}),
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
const coordinatorSuper: Actor = {
  kind: 'ai',
  handle: 'pm',
  via: 'integrator',
  operatorMode: 'super',
  credential,
};
const developer: Actor = { kind: 'ai', handle: 'dev' };

describe('the member involvement setting (PM-1267)', () => {
  it('defaults to people only', () => {
    expect(memberInvolvementOf(configWith())).toBe('people');
  });

  it.each<[string, Actor, MemberInvolvement | undefined, boolean]>([
    ['a person by default', human, undefined, true],
    ['the coordinator super actor by default', coordinatorSuper, undefined, true],
    ['the project manager not by default', pm, undefined, false],
    ['the project manager not with people only', pm, 'people', false],
    ['the project manager when the project allows it', pm, 'people_and_project_manager', true],
    ['another AI member never', developer, 'people_and_project_manager', false],
  ])('%s', (_name, actor, setting, expected) => {
    expect(mayInvolveMembers(configWith(setting), actor)).toBe(expected);
  });
});
