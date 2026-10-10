import { execFile } from 'node:child_process';
import { MergeError } from '../contracts';
import { BILLING_ENV_VARS } from '../runner/env';

/**
 * The git runner of the merger (PM-451). Every call is an argument array without a shell, with the
 * repository's hooks switched off (a hook of the repository must not run in the owner's name: a merge
 * or a push is made by the engine, not by a session's hook), no signing, no terminal prompt and no
 * helper program the repository's own configuration could name (`core.fsmonitor`). The environment
 * is the engine's, without the billing variables and without the variables that point git at another
 * repository than the one named with `-C`.
 */

/** Variables that would point git at another repository than the one named with `-C`. */
const REPOSITORY_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
];

/** Config set on every call: hooks off, nothing signed, no filesystem monitor program. */
export const SAFE_GIT_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.ext.allow=never',
  // A replace ref cannot swap the content of an approved commit.
  '-c',
  'core.useReplaceRefs=false',
] as const;

export const MERGE_GIT_TIMEOUT_MS = 120_000;
export const NETWORK_GIT_TIMEOUT_MS = 120_000;

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GitRunOptions {
  timeoutMs?: number;
  /** Written to the command's standard input. */
  input?: string;
  /** Added to the environment (identity variables, locale). */
  env?: Record<string, string>;
}

export function mergeGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REPOSITORY_OVERRIDES) delete env[name];
  for (const name of BILLING_ENV_VARS) delete env[name];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', ...extra };
}

/** Runs git; resolves with the exit code and the output whatever it was (only a failure to start rejects). */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...SAFE_GIT_CONFIG, '-C', cwd, ...args],
      {
        env: mergeGitEnv(options.env),
        encoding: 'utf8',
        timeout: options.timeoutMs ?? MERGE_GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number' && !error.killed) {
          reject(error);
          return;
        }
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          stdout,
          stderr,
          timedOut: error?.killed === true,
        });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

export { MergeError };

/** The end of a git output, at most `max` characters, without credentials. */
export function outputTail(text: string, max = 2000): string {
  const clean = scrubCredentials(text.trim());
  return clean.length <= max ? clean : clean.slice(clean.length - max);
}

/** Hides user information in URLs and the usual token shapes in git's output. */
export function scrubCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-)[A-Za-z0-9_-]+/g, '***')
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*.*/gi, '$1: ***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
}
