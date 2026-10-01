import { describe, expect, it } from 'vitest';
import {
  branchBelongsToTask,
  checkPublishTarget,
  isFullCommitId,
  isPlainBranchName,
  isProtectedBranchName,
  publishRefspec,
} from './publishing';

const COMMIT = 'a'.repeat(40);
const target = (over: Partial<Parameters<typeof checkPublishTarget>[0]> = {}) => ({
  taskKey: 'PM-142',
  github: 'acme/app',
  defaultBranch: 'main',
  branch: 'PM-142-publish',
  commit: COMMIT,
  ...over,
});

describe('checkPublishTarget', () => {
  it('names one commit to one fully qualified, unforced branch', () => {
    expect(checkPublishTarget(target())).toEqual({
      ok: true,
      branch: 'PM-142-publish',
      commit: COMMIT,
      refspec: `${COMMIT}:refs/heads/PM-142-publish`,
    });
    expect(publishRefspec(COMMIT, 'PM-142')).not.toMatch(/^\+/);
  });

  it.each([
    ['a local-only repository', { github: undefined }, 'local_only'],
    ['no task branch', { branch: null }, 'no_task_branch'],
    ['the default branch', { branch: 'main' }, 'protected_branch'],
    ['a custom default branch', { branch: 'trunk-x', defaultBranch: 'trunk-x' }, 'protected_branch'],
    ['a protected name in another case', { branch: 'Main' }, 'protected_branch'],
    ['a release branch', { branch: 'release/1.0' }, 'protected_branch'],
    ['a branch of another task', { branch: 'PM-143-other' }, 'foreign_branch'],
    ['a task whose key is a prefix of this one', { branch: 'PM-14-x' }, 'foreign_branch'],
    ['a task whose key extends this one', { branch: 'PM-1420-x' }, 'foreign_branch'],
    ['a full ref name', { branch: 'refs/heads/PM-142-x' }, 'invalid_branch'],
    ['a refspec in the branch', { branch: 'PM-142-x:main' }, 'invalid_branch'],
    ['a force marker', { branch: '+PM-142-x' }, 'invalid_branch'],
    ['a flag', { branch: '--delete' }, 'invalid_branch'],
    ['a short commit id', { commit: 'abc1234' }, 'invalid_commit'],
    ['a revision instead of a commit', { commit: 'HEAD' }, 'invalid_commit'],
    ['a commit id in upper case', { commit: 'A'.repeat(40) }, 'invalid_commit'],
  ])('refuses %s', (_name, over, code) => {
    expect(checkPublishTarget(target(over))).toMatchObject({ ok: false, code });
  });
});

describe('branch rules', () => {
  it('reads a task branch by its key and a dash', () => {
    expect(branchBelongsToTask('PM-142', 'PM-142')).toBe(true);
    expect(branchBelongsToTask('PM-142', 'PM-142-publish')).toBe(true);
    expect(branchBelongsToTask('PM-142', 'feature/PM-142-x')).toBe(false);
  });

  it.each([
    'a b',
    'a..b',
    'a/',
    'a.',
    '.a',
    'a/.b',
    'a.lock',
    'a@{1}',
    'a~1',
    'a^',
    'a?',
    'a*',
    'a[',
    'a\\b',
    '',
  ])('refuses the branch name %j', (name) => expect(isPlainBranchName(name)).toBe(false));

  it('keeps the default branch protected whatever its case', () => {
    expect(isProtectedBranchName('MAIN', 'main')).toBe(true);
    expect(isProtectedBranchName('PM-142-x', 'main')).toBe(false);
  });

  it('wants 40 lower case hex digits', () => {
    expect(isFullCommitId(COMMIT)).toBe(true);
    expect(isFullCommitId(`${COMMIT}0`)).toBe(false);
  });
});
