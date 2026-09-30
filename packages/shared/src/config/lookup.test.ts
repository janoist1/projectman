import { describe, expect, it } from 'vitest';
import { memberOf, memberRoles, stageOf } from './lookup';
import { ProjectConfig } from './schema';

const config = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
  team: {
    members: [
      {
        kind: 'human',
        handle: 'owner',
        displayName: 'Owner',
        access: 'owner',
        roles: ['operator', 'product_owner'],
      },
      { kind: 'human', handle: 'vic', displayName: 'Vic', access: 'viewer' },
      { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
    ],
    limits: {},
  },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
      { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
    ],
    labels: [],
  },
});

describe('config lookups', () => {
  it.each([
    ['owner', 'owner'],
    ['dev-1', 'dev-1'],
    ['nobody', undefined],
    [null, undefined],
  ])('finds the member %s', (handle, expected) => {
    expect(memberOf(config, handle)?.handle).toBe(expected);
  });

  it.each([
    ['ready', 'Ready'],
    ['nowhere', undefined],
  ])('finds the stage %s', (id, expected) => {
    expect(stageOf(config, id)?.name).toBe(expected);
  });

  it.each([
    ['owner', ['operator', 'product_owner']],
    ['vic', []],
    ['dev-1', ['developer']],
  ])('lists the roles %s holds', (handle, roles) => {
    expect(memberRoles(memberOf(config, handle)!)).toEqual(roles);
  });
});
