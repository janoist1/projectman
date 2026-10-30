import { describe, expect, it } from 'vitest';
import { lifecycleAllowed, projectManagerLifecycleOf, projectManagerMayLifecycle } from './lifecycle';
import type { ProjectConfig, ProjectManagerLifecycleAction } from './schema';
import { TEAM_SETTING_POLICY } from './team-settings';

type Team = Pick<ProjectConfig, 'team'>;

function teamWith(lifecycle?: ProjectManagerLifecycleAction[]): Team {
  const members = [
    { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
    { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'admin' },
    { kind: 'human', handle: 'bob', displayName: 'Bob', access: 'developer' },
    { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager' },
    { kind: 'ai', handle: 'dev-1', displayName: 'Dev', role: 'developer' },
  ];
  return { team: { members, projectManagerLifecycle: lifecycle } } as unknown as Team;
}

const pm = { kind: 'ai', handle: 'pm' } as const;

describe('the project manager lifecycle setting (PM-1098)', () => {
  it('defaults to reassigning and cancelling, not reopening', () => {
    const config = teamWith();
    expect(projectManagerLifecycleOf(config)).toEqual(TEAM_SETTING_POLICY.projectManagerLifecycle.default);
    expect(projectManagerMayLifecycle(config, pm, 'assign')).toBe(true);
    expect(projectManagerMayLifecycle(config, pm, 'cancel')).toBe(true);
    expect(projectManagerMayLifecycle(config, pm, 'reopen')).toBe(false);
  });

  it('lets an empty list keep the project manager out of every action', () => {
    for (const action of ['assign', 'cancel', 'reopen'] as const)
      expect(projectManagerMayLifecycle(teamWith([]), pm, action)).toBe(false);
  });

  it.each([
    ['an AI member that is not the project manager', { kind: 'ai', handle: 'dev-1' }],
    ['the project manager through an integrator', { kind: 'ai', handle: 'pm', via: 'integrator' }],
  ] as const)('does not extend the listed actions to %s', (_name, actor) => {
    expect(lifecycleAllowed(teamWith(['assign', 'cancel', 'reopen']), actor, 'cancel')).toBe(false);
  });

  it('does not let a project manager on leave act', () => {
    const config = teamWith(['cancel']);
    (config.team.members.find((m) => m.handle === 'pm') as { onLeave?: boolean }).onLeave = true;
    expect(lifecycleAllowed(config, pm, 'cancel')).toBe(false);
  });

  it('lets a human of admin access or more always act, and nobody below', () => {
    const config = teamWith([]);
    expect(lifecycleAllowed(config, { kind: 'human', handle: 'owner' }, 'reopen')).toBe(true);
    expect(lifecycleAllowed(config, { kind: 'human', handle: 'ann' }, 'assign')).toBe(true);
    expect(lifecycleAllowed(config, { kind: 'human', handle: 'bob' }, 'cancel')).toBe(false);
    expect(lifecycleAllowed(config, { kind: 'human', handle: 'ghost' }, 'cancel')).toBe(false);
  });
});
