import { describe, expect, it } from 'vitest';
import { UpdateTaskRequest } from '../api/dto';
import { PROJECT_MANAGER_ROLE } from '../config/project-manager';
import { ProjectConfig } from '../config/schema';
import { priorityRefusal, TASK_PRIORITIES } from './task';

const config = ProjectConfig.parse({
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
});

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
  it('accepts the four named levels and clearing, but refuses numbers and unknown names', () => {
    for (const priority of [...TASK_PRIORITIES, null])
      expect(UpdateTaskRequest.parse({ priority })).toEqual({ priority });
    for (const priority of ['medium', 2])
      expect(UpdateTaskRequest.safeParse({ priority }).success).toBe(false);
  });
});
