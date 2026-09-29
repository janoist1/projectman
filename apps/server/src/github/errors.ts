/** Why a GitHub call failed. Callers branch on `code`; `message` is meant for logs. */
export type GithubErrorCode =
  /** A bad repo, pull request number or branch was passed in; gh was not run. */
  | 'invalid_argument'
  /** The gh binary could not be started (not installed or not executable). */
  | 'not_installed'
  /** gh is not logged in, or its token is no longer valid. */
  | 'not_authenticated'
  /** GitHub API rate limit (primary or secondary). */
  | 'rate_limited'
  /** The repository or pull request does not exist, or the login cannot see it. */
  | 'not_found'
  /** gh did not finish in time and was killed. */
  | 'timeout'
  /** GitHub could not be reached (offline, DNS, connection refused …); usually temporary. */
  | 'unreachable'
  /** GitHub answered with a server error (5xx, failed query); usually temporary. */
  | 'server_error'
  /** gh printed something that is not the JSON we asked for. */
  | 'invalid_response'
  /** The caller cancelled the call (e.g. a watch was unsubscribed). */
  | 'aborted'
  /** Anything else. */
  | 'failed';

export class GithubError extends Error {
  readonly code: GithubErrorCode;
  /** Exit code of gh when it ran and failed; null otherwise. */
  readonly exitCode: number | null;
  /** Beginning of gh's stderr, for logs. */
  readonly stderr: string;

  constructor(
    code: GithubErrorCode,
    message: string,
    details: { exitCode?: number | null; stderr?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'GithubError';
    this.code = code;
    this.exitCode = details.exitCode ?? null;
    this.stderr = details.stderr ?? '';
  }
}

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
