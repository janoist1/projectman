import type { MemberView } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { aiSponsors } from './members';

const ai = (sponsor: string | null) => ({ kind: 'ai', sponsor }) as unknown as MemberView;
const human = { kind: 'human', sponsor: null } as unknown as MemberView;

describe('aiSponsors', () => {
  it('names the only sponsor and ignores humans', () => {
    expect(aiSponsors([ai('owner'), ai('owner'), human])).toEqual({
      mixed: false,
      only: 'owner',
      usual: null,
    });
  });

  it('finds the sponsor most AI members share', () => {
    expect(aiSponsors([ai('owner'), ai('owner'), ai('owner'), ai('kata'), ai('kata')])).toEqual({
      mixed: true,
      only: null,
      usual: 'owner',
    });
  });

  it('has no usual sponsor on a tie or when the most common is "none"', () => {
    expect(aiSponsors([ai('owner'), ai('kata')]).usual).toBeNull();
    expect(aiSponsors([ai(null), ai(null), ai('kata')])).toMatchObject({ mixed: true, usual: null });
  });

  it('has no sponsor at all without AI members', () => {
    expect(aiSponsors([human])).toEqual({ mixed: false, only: null, usual: null });
  });
});
