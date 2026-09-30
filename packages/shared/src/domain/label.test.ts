import { describe, expect, it } from 'vitest';
import {
  isHumanOnlyLabel,
  isReleaseApprovalLabel,
  LabelSetBy,
  releaseApprovalSetBy,
  releaseGateAccepts,
} from './label';

type SetBy = Parameters<typeof isHumanOnlyLabel>[0]['setBy'];

describe('release approval labels (decision 19)', () => {
  it('is the release approval duty, humans only, and nothing wider', () => {
    const setBy = releaseApprovalSetBy();
    expect(setBy).toEqual({ duties: ['release_approval'], humansOnly: true });
    expect(LabelSetBy.safeParse(setBy).success).toBe(true);
    expect(isReleaseApprovalLabel({ setBy })).toBe(true);
    expect(isHumanOnlyLabel({ setBy })).toBe(true);
    // Every call hands out its own object, so a migration may keep it in a configuration.
    expect(releaseApprovalSetBy()).not.toBe(setBy);
  });

  it.each<[string, SetBy, boolean]>([
    ['the release approval duty, humans only', { duties: ['release_approval'], humansOnly: true }, true],
    [
      'the release approval duty listed twice',
      { duties: ['release_approval', 'release_approval'], humansOnly: true },
      true,
    ],
    ['an empty list of members', { duties: ['release_approval'], members: [], humansOnly: true }, true],
    ['the release approval duty without humansOnly', { duties: ['release_approval'] }, false],
    ['a named member', { members: ['owner'], humansOnly: true }, false],
    [
      'the release approval duty and a named member',
      { duties: ['release_approval'], members: ['owner'], humansOnly: true },
      false,
    ],
    ['another duty', { duties: ['final_decision'], humansOnly: true }, false],
    ['two duties', { duties: ['release_approval', 'final_decision'], humansOnly: true }, false],
    ['every human', 'humans', false],
    ['anyone', 'anyone', false],
    ['the system', 'system', false],
  ])('%s: release approval is %s', (_name, setBy, expected) => {
    expect(isReleaseApprovalLabel({ setBy })).toBe(expected);
  });

  it.each<[string, SetBy, boolean]>([
    // Approvals: only the release approval duty's.
    ['the release approval duty, humans only', { duties: ['release_approval'], humansOnly: true }, true],
    ['every human', 'humans', false],
    ['a named member, humans only', { members: ['owner'], humansOnly: true }, false],
    ['another duty, humans only', { duties: ['final_decision'], humansOnly: true }, false],
    // Facts: free, as before.
    ['anyone', 'anyone', true],
    ['the system', 'system', true],
    ['the holders of a duty', { duties: ['testing_acceptance'] }, true],
    ['a named member', { members: ['owner'] }, true],
  ])('a release gate takes a label that %s may set: %s', (_name, setBy, expected) => {
    expect(releaseGateAccepts({ setBy })).toBe(expected);
  });
});
