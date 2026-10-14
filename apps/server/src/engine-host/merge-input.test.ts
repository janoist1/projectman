import { describe, expect, it } from 'vitest';
import { newId } from '../kernel';
import { isBranchName, isCommitId, isMergeId, isMergeMessage } from './merge-input';

describe('input checks', () => {
  it('accepts commit ids, merge ids and messages only in their shape', () => {
    expect(isCommitId('a'.repeat(40))).toBe(true);
    expect(isCommitId('A'.repeat(64))).toBe(true);
    expect(isCommitId('main')).toBe(false);
    expect(isCommitId('a'.repeat(39))).toBe(false);
    expect(isMergeId('mrg_abcdefgh1')).toBe(true);
    expect(isMergeId('mrg_short')).toBe(false);
    expect(isMergeId('merge_abcdefgh1')).toBe(true);
    expect(isMergeId('merge_short')).toBe(false);
    expect(isMergeId('other_abcdefgh1')).toBe(false);
    for (let i = 0; i < 50; i++) expect(isMergeId(newId('merge'))).toBe(true);
    expect(isMergeId('../x')).toBe(false);
    expect(isMergeId('')).toBe(false);
    expect(isMergeMessage('Merge PM-1')).toBe(true);
    expect(isMergeMessage('a\0b')).toBe(false);
    expect(isMergeMessage('x'.repeat(2001))).toBe(false);
  });

  it('accepts branch names git accepts and refuses expansions and options', async () => {
    for (const ok of ['main', 'release/1.0', 'feature-x']) expect(await isBranchName(ok)).toBe(true);
    for (const bad of [
      '',
      'HEAD',
      '@',
      '-x',
      '--upload-pack=x',
      '@{-1}',
      'a..b',
      'a b',
      'a\nb',
      'x.lock',
      'a:b',
      'a~1',
    ])
      expect(await isBranchName(bad), bad).toBe(false);
  });
});
