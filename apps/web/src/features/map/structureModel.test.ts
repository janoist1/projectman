import { describe, expect, it } from 'vitest';
import { moduleSize, sortCards } from './structureModel';
import { structureFixture } from '../../mocks/fixtures';

describe('moduleSize', () => {
  it('handles empty repositories and zero-file modules', () => {
    expect(moduleSize(0, 0)).toBe(1);
    expect(moduleSize(0, 200)).toBe(1);
  });
  it('uses the four logarithmic thresholds', () => {
    const count = (ratio: number) => Math.expm1(Math.log1p(10000) * ratio);
    expect(moduleSize(count(0.44), 10000)).toBe(1);
    expect(moduleSize(count(0.46), 10000)).toBe(2);
    expect(moduleSize(count(0.64), 10000)).toBe(2);
    expect(moduleSize(count(0.66), 10000)).toBe(3);
    expect(moduleSize(count(0.84), 10000)).toBe(3);
    expect(moduleSize(count(0.86), 10000)).toBe(4);
    expect(moduleSize(10000, 10000)).toBe(4);
  });
});

it('sorts work by urgency and keeps merged cards last', () => {
  const cards = structureFixture.repos[0]!.cards;
  expect(
    sortCards(
      cards,
      new Map([
        ['AC-17', 'waiting'],
        ['AC-18', 'needs_you'],
        ['AC-19', 'needs_you'],
      ]),
    ).map((c) => c.taskKey),
  ).toEqual(['AC-18', 'AC-17', 'AC-19']);
});
