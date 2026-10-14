import { TaskLink } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { isValidBranch, isValidRepo, parsePullRequestUrl, pullRequestLink, taskKeyFromBranch } from './refs';
import { pullRequestInfo } from './test-fixtures/harness';

describe('parsePullRequestUrl', () => {
  it.each([
    ['https://github.com/acme/infra/pull/3', { repo: 'acme/infra', number: 3 }],
    ['https://github.com/acme/app/pull/12/files', { repo: 'acme/app', number: 12 }],
    ['https://github.com/acme/app/pull/12/checks?check_run_id=1', { repo: 'acme/app', number: 12 }],
    ['https://github.com/acme/app/pull/12#issuecomment-1', { repo: 'acme/app', number: 12 }],
    ['https://github.com/acme/app/pull/12/', { repo: 'acme/app', number: 12 }],
    ['  http://www.github.com/acme/my.app/pull/7 ', { repo: 'acme/my.app', number: 7 }],
    ['github.com/acme/.github/pull/1', { repo: 'acme/.github', number: 1 }],
    ['https://GitHub.com/Acme/App/pull/5', { repo: 'Acme/App', number: 5 }],
  ])('parses %s', (url, expected) => {
    expect(parsePullRequestUrl(url)).toEqual(expected);
  });

  it.each([
    'https://github.com/acme/app/issues/12',
    'https://github.com/acme/app/pull/',
    'https://github.com/acme/app/pull/0',
    'https://github.com/acme/app/pull/12abc',
    'https://github.com/acme/pull/12',
    'https://gitlab.com/acme/app/pull/12',
    'https://github.example.com/acme/app/pull/12',
    'https://github.com.evil.example/acme/app/pull/12',
    'https://github.com/acme/../pull/12',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(parsePullRequestUrl(url)).toBeNull();
  });
});

describe('taskKeyFromBranch', () => {
  it.each([
    ['AR-21-short-name', 'AR-21'],
    ['AR-21', 'AR-21'],
    ['AR-21_fix', 'AR-21'],
    ['feature/AR-21-short-name', 'AR-21'],
    ['refs/heads/AR-21-short-name', 'AR-21'],
    ['AR-007-leading-zeros', 'AR-7'],
    ['PROJ2-5-x', 'PROJ2-5'],
  ])('reads %s as %s', (branch, key) => {
    expect(taskKeyFromBranch(branch)).toBe(key);
  });

  it.each([
    'CU-869f4byk9-legacy-room-redirects',
    'CU-8691234567-all-digit-clickup-id',
    'feature/alerting',
    'main',
    'ar-21-lowercase',
    'AR-21x-no-separator',
    'AR-0-zero',
    'AR--21',
    '',
  ])('gives null for %s', (branch) => {
    expect(taskKeyFromBranch(branch)).toBeNull();
  });

  it('accepts only the given project key', () => {
    expect(taskKeyFromBranch('AR-21-x', 'AR')).toBe('AR-21');
    expect(taskKeyFromBranch('BO-3-x', 'AR')).toBeNull();
    expect(taskKeyFromBranch('UTF-8-fix', 'AR')).toBeNull();
  });

  it('accepts CU when it is the project key', () => {
    expect(taskKeyFromBranch('CU-12-x', 'CU')).toBe('CU-12');
  });
});

describe('pullRequestLink', () => {
  it('builds a pull_request task link with the state', () => {
    const link = pullRequestLink(pullRequestInfo({ state: 'merged' }));
    expect(link).toEqual({
      kind: 'pull_request',
      ref: '12',
      repo: 'acme/app',
      title: 'AR-21 Add room search',
      state: 'merged',
    });
    expect(TaskLink.parse(link)).toEqual(link);
  });
});

describe('input validation', () => {
  it.each(['acme/app', 'acme-corp/infra', 'acme/.github', 'my_org/my.repo'])('accepts repo %s', (repo) => {
    expect(isValidRepo(repo)).toBe(true);
  });

  it.each(['acme', 'acme/app/extra', '/app', 'acme/', 'acme/..', '../app', 'acme/app name', '--repo=x/y'])(
    'rejects repo %s',
    (repo) => {
      expect(isValidRepo(repo)).toBe(false);
    },
  );

  it.each(['AR-21-x', 'feature/AR-21', 'fix.dots_and-dashes'])('accepts branch %s', (branch) => {
    expect(isValidBranch(branch)).toBe(true);
  });

  it.each(['', '-x', 'has space', 'tab\tname', 'new\nline', 'x'.repeat(256)])(
    'rejects branch %j',
    (branch) => {
      expect(isValidBranch(branch)).toBe(false);
    },
  );
});
