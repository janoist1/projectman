import { describe, expect, it } from 'vitest';
import { GithubError, classifyGhFailure, toGithubError } from './errors';

describe('classifyGhFailure', () => {
  it.each([
    [1, 'GraphQL: API rate limit exceeded for user ID 1234.', 'rate_limited'],
    [
      1,
      'HTTP 403: API rate limit exceeded for user ID 1234. (https://api.github.com/graphql)',
      'rate_limited',
    ],
    [1, 'HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes.', 'rate_limited'],
    [1, 'HTTP 429: Too Many Requests', 'rate_limited'],
    [
      4,
      'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.',
      'not_authenticated',
    ],
    [1, 'HTTP 401: Bad credentials (https://api.github.com/graphql)', 'not_authenticated'],
    [1, 'You are not logged into any GitHub hosts. To log in, run: gh auth login', 'not_authenticated'],
    [
      1,
      'GraphQL: Could not resolve to a PullRequest with the number of 99999. (repository.pullRequest)',
      'not_found',
    ],
    [1, "GraphQL: Could not resolve to a Repository with the name 'acme/nope'. (repository)", 'not_found'],
    [1, 'HTTP 404: Not Found (https://api.github.com/repos/acme/nope)', 'not_found'],
    [
      1,
      'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com',
      'unreachable',
    ],
    [
      1,
      'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host',
      'unreachable',
    ],
    [1, 'Get "https://api.github.com/graphql": net/http: TLS handshake timeout', 'unreachable'],
    [1, 'HTTP 502: Bad Gateway', 'server_error'],
    [1, 'HTTP 503: Service Unavailable', 'server_error'],
    [
      1,
      'GraphQL: Something went wrong while executing your query. This may be the result of a timeout',
      'server_error',
    ],
    [1, 'HTTP 403: Resource not accessible by integration', 'failed'],
    [1, '', 'failed'],
  ])('exit %i with %j is %s', (exitCode, stderr, code) => {
    expect(classifyGhFailure(exitCode, stderr)).toBe(code);
  });
});

describe('toGithubError', () => {
  it('keeps GithubError instances', () => {
    const error = new GithubError('not_found', 'missing');
    expect(toGithubError(error)).toBe(error);
  });

  it('wraps anything else as failed', () => {
    const error = toGithubError(new Error('boom'));
    expect(error).toBeInstanceOf(GithubError);
    expect(error.code).toBe('failed');
    expect(error.message).toBe('boom');
  });
});
