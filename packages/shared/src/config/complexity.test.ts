import { describe, expect, it } from 'vitest';
import { AiMemberConfig, ProjectConfig } from './schema';
import {
  assigneeFitApplies,
  canSetComplexity,
  complexityLimitOf,
  complexitySetterMembers,
  isDeveloper,
} from './complexity';
import { complexityText, isComplexityPoints } from '../domain/complexity';

const config = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'AR', name: 'Example', workspacePath: '/work', repos: [] },
  team: {
    limits: {},
    members: [
      { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: [] },
      ...['developer', 'architect', 'qa'].map((role) => ({
        kind: 'ai',
        handle: role,
        displayName: role,
        role,
        sponsor: 'owner',
      })),
    ],
  },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'dev', name: 'Dev', kind: 'work', owners: ['architect'], columnId: 'all' },
      { id: 'qa', name: 'QA', kind: 'step', owners: ['qa'], columnId: 'all' },
    ],
  },
});

describe('complexity rules', () => {
  it.each([
    ['architect', true],
    ['developer', true],
    ['qa', false],
    ['owner', false],
  ])('identifies work owners and duty holders: %s', (handle, expected) => {
    expect(
      isDeveloper(
        config,
        config.team.members.find((m) => m.handle === handle)!,
      ),
    ).toBe(expected);
  });

  it.each([
    ['owner', true],
    ['architect', true],
    ['developer', false],
    ['missing', false],
  ])('checks who may set complexity: %s', (handle, expected) => {
    expect(canSetComplexity(config, handle)).toBe(expected);
  });

  it.each([
    [[], 'architect', false],
    [[], 'owner', true],
    [['implementation'], 'developer', true],
    [['implementation'], 'architect', false],
  ] as const)('follows team.complexitySetters %j: %s', (complexitySetters, handle, expected) => {
    const custom = { team: { ...config.team, complexitySetters: [...complexitySetters] } };
    expect(canSetComplexity(custom, handle)).toBe(expected);
  });

  it('lists the members who may set complexity in team order', () => {
    expect(complexitySetterMembers(config).map((m) => m.handle)).toEqual(['owner', 'architect']);
  });

  it.each([
    [{}, undefined, 5],
    [{ complexityLimit: 13 }, undefined, 13],
    [{ complexityLimit: 13, temp: true }, undefined, 5],
    [{ complexityLimit: 13, temp: true }, 8, 8],
  ])('resolves the effective limit for %j with the temp limit %s', (fields, maxPoints, expected) => {
    const member = AiMemberConfig.parse({
      kind: 'ai',
      handle: 'dev',
      displayName: 'Dev',
      role: 'developer',
      sponsor: 'owner',
      ...fields,
    });
    const limited = ProjectConfig.parse({
      ...config,
      team: { ...config.team, limits: { tempWorkers: { maxPoints } } },
    });
    expect(complexityLimitOf(limited, member)).toBe(expected);
  });

  it.each([
    ['automatic_and_ai', 'ai', true],
    ['automatic_and_ai', 'human', false],
    ['automatic', 'ai', false],
    [undefined, 'ai', false],
  ] as const)('applies the assignee fit for setting %s and actor %s: %s', (setting, kind, expected) => {
    const configured = { team: { ...config.team, assigneeFit: setting } };
    expect(assigneeFitApplies(configured, { kind })).toBe(expected);
  });

  it('accepts only scale values', () => {
    expect([1, 2, 3, 5, 8, 13].every(isComplexityPoints)).toBe(true);
    expect([0, 4, 21, '5', null].some(isComplexityPoints)).toBe(false);
  });

  it('formats points and an optional reason on one line', () => {
    const c = { points: 5 as const, reason: null, setBy: 'owner', setAt: 'now' };
    expect(complexityText(c)).toBe('5 points');
    expect(complexityText({ ...c, reason: 'two\nmodules' })).toBe('5 points — two modules');
  });
});
