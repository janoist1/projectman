import { describe, expect, it } from 'vitest';
import { chooseDeveloper, reachingDevelopers } from './choose-developer';
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
    extra: { anyDecided?: boolean; developers?: StageDeveloper[] } = {},
  ) =>
    chooseDeveloper({
      points,
      anyDecided: extra.anyDecided ?? false,
      reaching: reachingDevelopers(extra.developers ?? developers, points),
      free: pool,
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
    expect(reachingDevelopers(team, 5)).toEqual(['small', 'big']);
    expect(reachingDevelopers(team, 8)).toEqual(['big']);
    expect(reachingDevelopers(team, null)).toEqual([]);
  });
});
