import { describe, expect, it } from 'vitest';
import {
  assigneeFitRefusal,
  canReplaceUnstartedAssignee,
  chooseDeveloper,
  humanStageOwner,
  reachingDevelopers,
} from './choose-developer';
import { ProjectConfig } from '../config/schema';
import type { FreeDeveloper, StageDeveloper } from './choose-developer';
import type { ComplexityPoints } from './complexity';

const free = (
  handle: string,
  index: number,
  limit: ComplexityPoints,
  extra: Partial<FreeDeveloper> = {},
): FreeDeveloper => ({ handle, limit, temp: false, load: 0, index, ...extra });

describe('chooseDeveloper (PM-1007)', () => {
  const small = free('small', 0, 5);
  const big = free('big', 1, 13);
  const developers: StageDeveloper[] = [
    { handle: 'small', limit: 5 },
    { handle: 'big', limit: 13 },
  ];
  const pick = (
    points: ComplexityPoints | null,
    pool: FreeDeveloper[],
    extra: {
      anyDecided?: boolean;
      developers?: StageDeveloper[];
      labels?: string[];
      tempMaxPoints?: ComplexityPoints;
    } = {},
  ) =>
    chooseDeveloper({
      points,
      labels: extra.labels ?? [],
      anyDecided: extra.anyDecided ?? false,
      reaching: reachingDevelopers(extra.developers ?? developers, points, extra.labels ?? []),
      free: pool,
      tempMaxPoints: extra.tempMaxPoints ?? 5,
    });

  it('skips a specialist for an unlabelled card', () => {
    expect(pick(null, [{ ...small, specialtyLabels: ['ui'] }, big])).toEqual({
      kind: 'member',
      handle: 'big',
    });
  });

  it('assigns a matching card to a specialist', () => {
    expect(pick(3, [{ ...small, specialtyLabels: ['ui'] }, big], { labels: ['ui'] })).toEqual({
      kind: 'member',
      handle: 'small',
    });
  });

  it('does not wait for or fall back to a nonmatching specialist', () => {
    const specialist = { ...big, specialtyLabels: ['ui'] };
    expect(reachingDevelopers([small, specialist], 8, [])).toEqual([]);
    expect(pick(8, [small, specialist], { developers: [small, specialist] })).toEqual({
      kind: 'member',
      handle: 'small',
    });
  });

  it('gives a card to the free developer with the smallest limit that reaches it', () => {
    expect(pick(8, [small, big])).toEqual({ kind: 'member', handle: 'big' });
    expect(pick(3, [big, small])).toEqual({ kind: 'member', handle: 'small' });
  });

  it('treats an unscored card as one every developer reaches', () => {
    expect(pick(null, [big, small])).toEqual({ kind: 'member', handle: 'small' });
  });

  it('prefers the less loaded developer, then the team order, among equal limits', () => {
    const a = free('a', 0, 8, { load: 1 });
    const b = free('b', 2, 8);
    const c = free('c', 1, 8);
    expect(pick(5, [a, b, c], { developers: [] })).toEqual({ kind: 'member', handle: 'c' });
  });

  it('makes a scored card wait while every developer that reaches it is busy', () => {
    expect(pick(8, [small])).toEqual({ kind: 'senior_busy', seniors: ['big'] });
    expect(pick(13, [])).toEqual({ kind: 'senior_busy', seniors: ['big'] });
  });

  it('lets the largest free developer take the card once the owners said so', () => {
    const mid = free('mid', 2, 8);
    expect(pick(13, [small, mid], { anyDecided: true })).toEqual({ kind: 'member', handle: 'mid' });
  });

  it('gives a card nobody reaches to the largest free developer', () => {
    const lowOnly: StageDeveloper[] = [{ handle: 'small', limit: 5 }];
    expect(pick(13, [small], { developers: lowOnly })).toEqual({ kind: 'member', handle: 'small' });
  });

  it('never gives a card above 5 points to a temp worker', () => {
    const temp = free('temp', 3, 5, { temp: true });
    expect(pick(8, [temp], { anyDecided: true })).toEqual({ kind: 'none', tempAllowed: false });
    expect(pick(8, [temp], { developers: [] })).toEqual({ kind: 'none', tempAllowed: false });
  });

  it('hires a temp worker up to the project temp limit', () => {
    const only: StageDeveloper[] = [{ handle: 'big', limit: 13 }];
    expect(pick(8, [], { developers: only, tempMaxPoints: 8 })).toEqual({ kind: 'none', tempAllowed: true });
    expect(pick(13, [], { developers: [], tempMaxPoints: 8 })).toEqual({ kind: 'none', tempAllowed: false });
  });

  it('may hire a temp worker for a small card when nobody is free', () => {
    expect(pick(3, [], { developers: [{ handle: 'big', limit: 13 }] })).toEqual({
      kind: 'none',
      tempAllowed: true,
    });
    expect(pick(null, [])).toEqual({ kind: 'none', tempAllowed: true });
  });
});

describe('reachingDevelopers', () => {
  it('lists the handles whose limit reaches the points, none for an unscored card', () => {
    const team: StageDeveloper[] = [
      { handle: 'small', limit: 5 },
      { handle: 'big', limit: 13 },
    ];
    expect(reachingDevelopers(team, 5, [])).toEqual(['small', 'big']);
    expect(reachingDevelopers(team, 8, [])).toEqual(['big']);
    expect(reachingDevelopers(team, null, [])).toEqual([]);
  });
});

describe('assigneeFitRefusal (PM-1136)', () => {
  const developers: StageDeveloper[] = [
    { handle: 'small', limit: 5 },
    { handle: 'big', limit: 13 },
    { handle: 'ui', limit: 13, specialtyLabels: ['ui'] },
  ];
  const refusal = (member: string, extra: Partial<Parameters<typeof assigneeFitRefusal>[0]> = {}) =>
    assigneeFitRefusal({
      member,
      points: 8,
      labels: [],
      developers,
      anyDecided: false,
      ...extra,
    });

  it('refuses a developer whose limit is below the points', () => {
    expect(refusal('small')).toEqual({ reason: 'over_complexity_limit', points: 8, limit: 5 });
  });
  it('refuses a developer whose specialty the card does not match', () => {
    expect(refusal('ui')).toEqual({ reason: 'specialty_mismatch', points: 8, limit: 13 });
  });
  it('accepts a developer that fits', () => {
    expect(refusal('big')).toBeNull();
    expect(refusal('ui', { labels: ['ui'] })).toBeNull();
  });
  it.each<[string, string, Partial<Parameters<typeof assigneeFitRefusal>[0]>]>([
    ['an unscored card', 'small', { points: null }],
    ['a card released to any developer', 'small', { anyDecided: true }],
    [
      'a card nobody reaches',
      'small',
      { points: 13, developers: [developers[0]!, { handle: 'big', limit: 5 }] },
    ],
    ['a person', 'owner', {}],
  ])('accepts %s', (_name, member, extra) => {
    expect(refusal(member, extra)).toBeNull();
  });
});

describe('canReplaceUnstartedAssignee (PM-1051)', () => {
  const replaceable = {
    providerBlocked: true,
    hasWorkSession: false,
    handoffOpen: false,
    fixLimitHeld: false,
  };

  it('replaces an assignee only when their provider is blocked and they have not begun the card', () => {
    expect(canReplaceUnstartedAssignee(replaceable)).toBe(true);
    expect(canReplaceUnstartedAssignee({ ...replaceable, providerBlocked: false })).toBe(false);
  });

  it.each(['hasWorkSession', 'handoffOpen', 'fixLimitHeld'] as const)(
    'keeps the assignee when %s',
    (guard) => {
      expect(canReplaceUnstartedAssignee({ ...replaceable, [guard]: true })).toBe(false);
    },
  );
});

describe('humanStageOwner', () => {
  it('selects eligible humans in team order rather than the stage owner order', () => {
    const config = {
      team: ProjectConfig.shape.team.parse({
        limits: {},
        members: [
          { kind: 'human', handle: 'outside', displayName: 'Outside', access: 'owner', roles: [] },
          { kind: 'ai', handle: 'dev', displayName: 'Dev', role: 'developer', sponsor: 'first' },
          { kind: 'human', handle: 'first', displayName: 'First', access: 'developer', roles: [] },
          { kind: 'human', handle: 'last', displayName: 'Last', access: 'developer', roles: [] },
        ],
      }),
    };
    expect(humanStageOwner(config, ['dev', 'last', 'first'])?.handle).toBe('first');
  });
});
