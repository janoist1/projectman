import { describe, expect, it } from 'vitest';
import { UpdateTaskRequest } from '../api/dto';
import { prioritySetterCandidates, prioritySetterMembers } from '../config/priority';
import { PROJECT_MANAGER_ROLE } from '../config/project-manager';
import { ProjectConfig } from '../config/schema';
import type { PrioritySetter } from '../config/schema';
import { priorityRefusal, TASK_PRIORITIES } from './task';

const base = {
  schemaVersion: 1,
  project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
  team: {
    members: [
      { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
      { kind: 'ai', handle: 'pm', displayName: 'PM', role: PROJECT_MANAGER_ROLE, sponsor: 'owner' },
      { kind: 'ai', handle: 'dev-1', displayName: 'Dev', role: 'developer', sponsor: 'owner' },
      {
        kind: 'ai',
        handle: 'temp-pm',
        displayName: 'Temp',
        role: PROJECT_MANAGER_ROLE,
        sponsor: 'owner',
        temp: true,
      },
    ],
    limits: {},
  },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'ideas', name: 'Ideas', kind: 'queue', columnId: 'all' },
      { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
    ],
    labels: [],
  },
};
const config = ProjectConfig.parse(base);

/** The test project with a priority setting, a role override or custom roles, and more members. */
function withSetters(
  prioritySetters: PrioritySetter[],
  extra: {
    roleOverrides?: Record<string, { duties: string[]; instructions: string }>;
    roles?: { id: string; name: string; duties: string[]; instructions: string }[];
    extraMembers?: Record<string, unknown>[];
  } = {},
) {
  return ProjectConfig.parse({
    ...base,
    team: {
      ...base.team,
      prioritySetters,
      members: [...base.team.members, ...(extra.extraMembers ?? [])],
      ...(extra.roleOverrides ? { roleOverrides: extra.roleOverrides } : {}),
      ...(extra.roles ? { roles: extra.roles.map((role) => ({ summary: 'A planner.', ...role })) } : {}),
    },
  });
}

describe('card priority', () => {
  it('allows people and the project manager, including when clearing or keeping the same level', () => {
    expect(priorityRefusal({ kind: 'human', handle: 'owner' }, config)).toBeNull();
    expect(priorityRefusal({ kind: 'ai', handle: 'pm' }, config)).toBeNull();
  });
  it('refuses any other AI member, a temp worker, an unknown handle and the system', () => {
    expect(priorityRefusal({ kind: 'ai', handle: 'dev-1' }, config)).toBe('priority_humans_only');
    expect(priorityRefusal({ kind: 'ai', handle: 'temp-pm' }, config)).toBe('priority_humans_only');
    expect(priorityRefusal({ kind: 'ai', handle: 'ghost' }, config)).toBe('priority_humans_only');
    expect(priorityRefusal({ kind: 'ai', handle: null }, config)).toBe('priority_humans_only');
    expect(priorityRefusal({ kind: 'system', handle: null }, config)).toBe('priority_humans_only');
    // The handle alone is not enough: a person's actor cannot borrow it, and a system actor named pm is no AI.
    expect(priorityRefusal({ kind: 'system', handle: 'pm' }, config)).toBe('priority_humans_only');
  });
  it('refuses the project manager when only people may set it', () => {
    const humansOnly = withSetters([]);
    expect(priorityRefusal({ kind: 'ai', handle: 'pm' }, humansOnly)).toBe('priority_humans_only');
    expect(priorityRefusal({ kind: 'human', handle: 'owner' }, humansOnly)).toBeNull();
  });
  it('lets the holders of the prioritization duty set it, by a role override or a custom role', () => {
    const duty = withSetters(['prioritization_duty'], {
      roleOverrides: { developer: { duties: ['implementation', 'prioritization'], instructions: '' } },
      roles: [{ id: 'planner', name: 'Planner', duties: ['prioritization'], instructions: '' }],
      extraMembers: [
        { kind: 'ai', handle: 'plan-1', displayName: 'Plan', role: 'planner', sponsor: 'owner' },
      ],
    });
    expect(priorityRefusal({ kind: 'ai', handle: 'dev-1' }, duty)).toBeNull();
    expect(priorityRefusal({ kind: 'ai', handle: 'plan-1' }, duty)).toBeNull();
    // The project manager keeps the right only through the duty, which its role does not hold.
    expect(priorityRefusal({ kind: 'ai', handle: 'pm' }, duty)).toBe('priority_humans_only');
  });
  it('refuses a temp worker even when it holds the duty', () => {
    const duty = withSetters(['project_manager', 'prioritization_duty'], {
      roleOverrides: { developer: { duties: ['implementation', 'prioritization'], instructions: '' } },
      extraMembers: [
        {
          kind: 'ai',
          handle: 'temp-dev',
          displayName: 'Temp',
          role: 'developer',
          sponsor: 'owner',
          temp: true,
        },
      ],
    });
    expect(priorityRefusal({ kind: 'ai', handle: 'temp-dev' }, duty)).toBe('priority_humans_only');
  });
  it('lists the AI members who may set it in team order', () => {
    const both = withSetters(['prioritization_duty', 'project_manager'], {
      roleOverrides: { developer: { duties: ['implementation', 'prioritization'], instructions: '' } },
    });
    expect(prioritySetterMembers(both).map((m) => m.handle)).toEqual(['pm', 'dev-1']);
    expect(prioritySetterCandidates(both, 'project_manager').map((m) => m.handle)).toEqual(['pm']);
  });
  it('accepts the four named levels and clearing, but refuses numbers and unknown names', () => {
    for (const priority of [...TASK_PRIORITIES, null])
      expect(UpdateTaskRequest.parse({ priority })).toEqual({ priority });
    for (const priority of ['medium', 2])
      expect(UpdateTaskRequest.safeParse({ priority }).success).toBe(false);
  });
});
