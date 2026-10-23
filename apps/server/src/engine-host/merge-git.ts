import { execCommand, ExecCommandError } from '../exec';
import { BILLING_ENV_VARS } from '../runner';

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
const SAFE_GIT_CONFIG = [
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

const MERGE_GIT_TIMEOUT_MS = 120_000;
export const NETWORK_GIT_TIMEOUT_MS = 120_000;

interface GitResult {
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

function mergeGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REPOSITORY_OVERRIDES) delete env[name];
  for (const name of BILLING_ENV_VARS) delete env[name];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', ...extra };
}

/** Runs git; numeric exits and timeouts resolve, other process failures reject. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr, exitCode } = await execCommand('git', [...SAFE_GIT_CONFIG, '-C', cwd, ...args], {
      env: mergeGitEnv(options.env),
      timeoutMs: options.timeoutMs ?? MERGE_GIT_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024 * 1024,
      okExitCodes: 'any',
      input: options.input,
    });
    return { code: exitCode, stdout, stderr, timedOut: false };
  } catch (error) {
    if (!(error instanceof ExecCommandError) || error.reason !== 'timeout') throw error;
    return { code: null, stdout: error.stdout.toString(), stderr: error.stderr, timedOut: true };
  }
}

/** Runs git for its raw output: the standard output stays bytes (a file's content is not decoded here). */
export async function runGitBytes(
  cwd: string,
  args: readonly string[],
  options: Pick<GitRunOptions, 'timeoutMs' | 'env'> = {},
): Promise<{ code: number | null; stdout: Buffer; stderr: string; timedOut: boolean }> {
  try {
    const { stdout, stderr, exitCode } = await execCommand('git', [...SAFE_GIT_CONFIG, '-C', cwd, ...args], {
      env: mergeGitEnv(options.env),
      encoding: 'buffer',
      timeoutMs: options.timeoutMs ?? MERGE_GIT_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024 * 1024,
      okExitCodes: 'any',
    });
    return { code: exitCode, stdout, stderr, timedOut: false };
  } catch (error) {
    if (!(error instanceof ExecCommandError) || error.reason !== 'timeout') throw error;
    return {
      code: null,
      stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(error.stdout),
      stderr: error.stderr,
      timedOut: true,
    };
  }
}

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
