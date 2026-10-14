import { GithubError, type GithubErrorCode } from '../../contracts';
export { GithubError, type GithubErrorCode } from '../../contracts';

/** gh exits with 4 when a command needs authentication ("gh auth login"). */
const GH_EXIT_AUTH_REQUIRED = 4;

const RATE_LIMITED = /rate limit|HTTP 429|abuse detection|too many requests/i;
const NOT_AUTHENTICATED = /gh auth login|HTTP 401|bad credentials|not logged in|requires authentication/i;
const NOT_FOUND = /could not resolve to a|HTTP 404|no pull requests found/i;
const UNREACHABLE =
  /error connecting to|could not resolve host|no such host|connection refused|connection reset|network is unreachable|i\/o timeout|tls handshake timeout/i;
const SERVER_ERROR =
  /HTTP 5\d\d|bad gateway|service unavailable|gateway timeout|something went wrong while executing your query/i;

/** Maps a failed gh run (exit code and stderr) to an error code. */
export function classifyGhFailure(exitCode: number | null, stderr: string): GithubErrorCode {
  if (RATE_LIMITED.test(stderr)) return 'rate_limited';
  if (exitCode === GH_EXIT_AUTH_REQUIRED || NOT_AUTHENTICATED.test(stderr)) return 'not_authenticated';
  if (NOT_FOUND.test(stderr)) return 'not_found';
  if (UNREACHABLE.test(stderr)) return 'unreachable';
  if (SERVER_ERROR.test(stderr)) return 'server_error';
  return 'failed';
}

export function toGithubError(err: unknown): GithubError {
  if (err instanceof GithubError) return err;
  return new GithubError('failed', err instanceof Error ? err.message : String(err), { cause: err });
}
