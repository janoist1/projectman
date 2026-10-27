import { describe, expect, it } from 'vitest';
import { hasMachineAccess, machineAccessOf, machineTodoIssuerAllowed } from './machine-access';
import { memberOf } from './lookup';
import { PROJECT_MANAGER_ROLE } from './project-manager';
import { ProjectConfig } from './schema';

type MemberInput = Record<string, unknown>;

const OWNER = {
  kind: 'human',
  handle: 'owner',
  displayName: 'Owner',
  access: 'owner',
  email: 'owner@example.com',
};

function ai(handle: string, extra: MemberInput = {}): MemberInput {
  return { kind: 'ai', handle, displayName: handle, role: 'developer', sponsor: 'owner', ...extra };
}

function configWith(members: MemberInput[]): ProjectConfig {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: { members: [OWNER, ...members], limits: {} },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'ideas', name: 'Ideas', kind: 'queue', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [],
    },
  });
}

const config = configWith([
  ai('pm', { role: PROJECT_MANAGER_ROLE }),
  ai('pm-off', { role: PROJECT_MANAGER_ROLE, machineAccess: false }),
  ai('pm-temp', { role: PROJECT_MANAGER_ROLE, temp: true }),
  ai('dev'),
  ai('dev-on', { machineAccess: true }),
  ai('operator', { role: 'ai_operator' }),
]);

describe('machineAccessOf', () => {
  it.each([
    ['pm', true],
    ['pm-off', false],
    ['pm-temp', false],
    ['dev', false],
    ['dev-on', true],
    ['owner', false],
  ])('resolves %s to %s', (handle, expected) => {
    expect(machineAccessOf(memberOf(config, handle)!)).toBe(expected);
    expect(hasMachineAccess(config, handle)).toBe(expected);
  });
  it('is false for a handle that is not on the team', () => {
    expect(hasMachineAccess(config, 'ghost')).toBe(false);
  });
});

describe('machineTodoIssuerAllowed', () => {
  it.each([
    ['system', true],
    ['operator', true],
    ['pm', true],
    ['dev-on', true],
    ['dev', false],
    ['pm-off', false],
    ['ghost', false],
  ])('judges the issuer %s as %s', (issuer, expected) => {
    expect(machineTodoIssuerAllowed(config, issuer)).toBe(expected);
  });
});
