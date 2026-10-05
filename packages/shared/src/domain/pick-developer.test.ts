import { describe, expect, it } from 'vitest';
import { pickDeveloper } from './developer-level';
import type { DeveloperCandidate } from './developer-level';

const candidate = (
  handle: string,
  index: number,
  extra: Partial<DeveloperCandidate> = {},
): DeveloperCandidate => ({ handle, senior: false, temp: false, load: 0, index, ...extra });

describe('pickDeveloper (PM-348)', () => {
  const senior = candidate('senior', 0, { senior: true });
  const dev = candidate('dev', 1);
  const dev2 = candidate('dev2', 2);

  it('gives a Senior card to a free Senior, the least loaded first', () => {
    const busier = candidate('senior2', 3, { senior: true, load: 1 });
    expect(
      pickDeveloper({
        level: 'senior',
        anyDecided: false,
        seniors: ['senior', 'senior2'],
        free: [dev, busier, senior],
      }),
    ).toEqual({
      kind: 'member',
      handle: 'senior',
    });
    expect(
      pickDeveloper({
        level: 'senior',
        anyDecided: false,
        seniors: ['senior', 'senior2'],
        free: [candidate('senior', 0, { senior: true, load: 2 }), busier],
      }),
    ).toEqual({ kind: 'member', handle: 'senior2' });
  });

  it('makes a Senior card wait while every Senior is busy, whoever else is free', () => {
    expect(
      pickDeveloper({ level: 'senior', anyDecided: false, seniors: ['senior'], free: [dev, dev2] }),
    ).toEqual({
      kind: 'senior_busy',
      seniors: ['senior'],
    });
    expect(pickDeveloper({ level: 'senior', anyDecided: false, seniors: ['senior'], free: [] })).toEqual({
      kind: 'senior_busy',
      seniors: ['senior'],
    });
  });

  it('lets a free developer take the Senior card once the owners said so', () => {
    expect(
      pickDeveloper({ level: 'senior', anyDecided: true, seniors: ['senior'], free: [dev, dev2] }),
    ).toEqual({
      kind: 'member',
      handle: 'dev',
    });
    expect(pickDeveloper({ level: 'senior', anyDecided: true, seniors: ['senior'], free: [senior] })).toEqual(
      {
        kind: 'member',
        handle: 'senior',
      },
    );
  });

  it('never gives a Senior card to a temp worker', () => {
    const temp = candidate('temp', 3, { temp: true });
    expect(pickDeveloper({ level: 'senior', anyDecided: true, seniors: ['senior'], free: [temp] })).toEqual({
      kind: 'none',
      tempAllowed: false,
    });
    expect(pickDeveloper({ level: 'senior', anyDecided: false, seniors: [], free: [temp] })).toEqual({
      kind: 'none',
      tempAllowed: false,
    });
  });

  it('treats a Senior card as an any card when the team has no Senior', () => {
    expect(pickDeveloper({ level: 'senior', anyDecided: false, seniors: [], free: [dev] })).toEqual({
      kind: 'member',
      handle: 'dev',
    });
  });

  it('gives an any card to a Senior only when no other developer is free', () => {
    expect(
      pickDeveloper({ level: 'any', anyDecided: false, seniors: ['senior'], free: [senior, dev] }),
    ).toEqual({
      kind: 'member',
      handle: 'dev',
    });
    expect(pickDeveloper({ level: 'any', anyDecided: false, seniors: ['senior'], free: [senior] })).toEqual({
      kind: 'member',
      handle: 'senior',
    });
    // Even a more loaded non-Senior goes before the Senior.
    expect(
      pickDeveloper({
        level: 'any',
        anyDecided: false,
        seniors: ['senior'],
        free: [senior, candidate('dev', 1, { load: 1 })],
      }),
    ).toEqual({ kind: 'member', handle: 'dev' });
  });

  it('orders an any card by load, then by place in the team', () => {
    expect(
      pickDeveloper({
        level: 'any',
        anyDecided: false,
        seniors: [],
        free: [candidate('b', 2, { load: 1 }), dev2, dev],
      }),
    ).toEqual({ kind: 'member', handle: 'dev' });
  });

  it('reports nobody free, with a temp worker allowed, for an any card', () => {
    expect(pickDeveloper({ level: 'any', anyDecided: false, seniors: ['senior'], free: [] })).toEqual({
      kind: 'none',
      tempAllowed: true,
    });
  });
});
