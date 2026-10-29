import { describe, expect, it } from 'vitest';
import type { HumanAccess } from '../domain/member';
import type { TaskCreateAccess } from './schema';
import { canCreateTasks, createsInFirstStageOnly } from './task-create';

const team = (taskCreateAccess?: TaskCreateAccess) => ({ team: { taskCreateAccess } }) as never;

describe('canCreateTasks', () => {
  it.each<[string, TaskCreateAccess | undefined, HumanAccess | undefined, boolean]>([
    ['default: a developer may', undefined, 'developer', true],
    ['default: a client may not', undefined, 'client', false],
    ['client setting: a client may', 'client', 'client', true],
    ['client setting: a viewer may not', 'client', 'viewer', false],
    ['client setting: an unknown member may not', 'client', undefined, false],
    ['admin setting: a developer may not', 'admin', 'developer', false],
    ['admin setting: an admin may', 'admin', 'admin', true],
  ])('%s', (_name, setting, access, expected) => {
    expect(canCreateTasks(team(setting), access as HumanAccess)).toBe(expected);
  });
});

describe('createsInFirstStageOnly', () => {
  it.each<[HumanAccess, boolean]>([
    ['client', true],
    ['developer', false],
  ])('%s: %s', (access, expected) => {
    expect(createsInFirstStageOnly(access)).toBe(expected);
  });
});
