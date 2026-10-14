import { describe, expect, it } from 'vitest';
import { isCommitId, isMergeId, isPlainBranchName } from './merge-input';

describe('pure merge input validation', () => {
  it.each(['a'.repeat(40), 'F'.repeat(40), '0123456789abcdef'.repeat(4)])('accepts commit %s', (value) => {
    expect(isCommitId(value)).toBe(true);
  });
  it.each(['', 'main', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 'a'.repeat(65)])(
    'refuses a non-commit %s',
    (value) => expect(isCommitId(value)).toBe(false),
  );

  it.each(['mrg_abcdefgh', 'merge_abcdefgh', `mrg_${'0'.repeat(40)}`, 'merge_abc01234'])(
    'accepts current and historical merge ids: %s',
    (value) => expect(isMergeId(value)).toBe(true),
  );
  it.each([
    '',
    'mrg_short',
    'merge_short',
    'other_abcdefgh',
    'mrg_ABC01234',
    '../mrg_abcdefgh',
    `merge_${'a'.repeat(41)}`,
  ])('refuses an invalid merge id: %s', (value) => {
    expect(isMergeId(value)).toBe(false);
  });

  it.each([
    'main',
    'feature-x',
    'release/1.0',
    'PM-659-change',
    'feature/árvíz',
    'topic/-part',
    'topic/part./next',
    'topic.LOCK',
    'a'.repeat(200),
  ])('accepts a plain branch: %s', (name) => {
    expect(isPlainBranchName(name)).toBe(true);
  });
  it.each([
    '',
    'HEAD',
    '@',
    '-x',
    '--upload-pack=x',
    '@{-1}',
    'topic@{1}',
    'a..b',
    'a b',
    'a\nb',
    'a\0b',
    'a\x7fb',
    'a\tb',
    'a\u00a0b',
    'a:b',
    'a~1',
    'a^1',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    '/topic',
    'topic/',
    'topic//next',
    '.topic',
    'topic/.hidden',
    'topic.lock',
    'topic.lock/next',
    'topic.',
    'a'.repeat(201),
  ])('refuses a branch expansion or invalid ref: %s', (name) => {
    expect(isPlainBranchName(name)).toBe(false);
  });
});
