import { describe, expect, it } from 'vitest';
import { isValidRepo, parsePullRequestUrl } from './github-refs';

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
});
