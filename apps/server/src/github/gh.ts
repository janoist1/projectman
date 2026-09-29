import { execFile, type ExecFileException } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import { GithubError, classifyGhFailure } from './errors';

/** Runs gh with the given arguments and resolves with its stdout. Rejects with a GithubError. */
export type GhRunner = (args: readonly string[], options?: { signal?: AbortSignal }) => Promise<string>;

export interface GhRunnerOptions {
  /** Path or name of the GitHub CLI. */
  ghBin: string;
  /** gh is killed when a call takes longer than this. */
  timeoutMs: number;
  /** Extra environment variables for gh (tests use it to configure the fake gh). */
  env?: Record<string, string>;
  logger: FastifyBaseLogger;
}

/** Large PR lists with many checks can be big; anything above this is treated as broken output. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STDERR_EXCERPT_CHARS = 500;

/**
 * gh is started directly (execFile, no shell) with the owner's existing login. Arguments are
 * passed as separate argv entries, so nothing is ever interpreted by a shell.
 */
export function createGhRunner(opts: GhRunnerOptions): GhRunner {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Never wait for input, never check for updates, and print plain JSON even if the
    // server's own environment forces colors or a terminal.
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    CLICOLOR_FORCE: '0',
    ...opts.env,
  };
  delete env.GH_FORCE_TTY;

  return (args, { signal } = {}) =>
    new Promise<string>((resolve, reject) => {
      const startedAt = Date.now();
      execFile(
        opts.ghBin,
        [...args],
        {
          encoding: 'utf8',
          env,
          timeout: opts.timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          signal,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          opts.logger.debug(
            { args: describe(args), ms: Date.now() - startedAt, ok: error === null },
            'github: gh call finished',
          );
          if (error === null) resolve(stdout);
          else reject(toGithubError(error, args, stderr, opts));
        },
      );
    });
}

/** "gh pr view 12" style label for messages; never includes the JSON field list. */
function describe(args: readonly string[]): string {
  return ['gh', ...args.filter((arg) => !arg.startsWith('--json'))].join(' ');
}

function toGithubError(
  error: ExecFileException,
  args: readonly string[],
  stderr: string,
  opts: GhRunnerOptions,
): GithubError {
  const command = describe(args);
  const excerpt = stderr.trim().slice(0, STDERR_EXCERPT_CHARS);
  if (error.name === 'AbortError') {
    return new GithubError('aborted', `${command} was aborted`, { cause: error });
  }
  if (error.code === 'ENOENT' || error.code === 'EACCES') {
    return new GithubError(
      'not_installed',
      `GitHub CLI could not be started (${error.code}): ${opts.ghBin}`,
      {
        cause: error,
      },
    );
  }
  if (error.killed) {
    return new GithubError('timeout', `${command} did not finish within ${opts.timeoutMs} ms`, {
      stderr: excerpt,
      cause: error,
    });
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new GithubError('invalid_response', `${command} printed more than ${MAX_OUTPUT_BYTES} bytes`, {
      cause: error,
    });
  }
  const exitCode = typeof error.code === 'number' ? error.code : null;
  const reason =
    excerpt.split('\n')[0] || (error.signal ? `killed by ${error.signal}` : `exit code ${exitCode}`);
  return new GithubError(classifyGhFailure(exitCode, stderr), `${command} failed: ${reason}`, {
    exitCode,
    stderr: excerpt,
    cause: error,
  });
}
