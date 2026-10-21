import { devNull } from 'node:os';
import { execCommand, ExecCommandError } from '../exec';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number;
  readonly stderr: string;
  constructor(args: string[], exitCode: number, stderr: string) {
    super(`git ${args[0] ?? ''} failed (${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Environment for git calls on the customization repository: independent from the user's
 * global/system git configuration (signing, hooks, default branch) and from any GIT_*
 * variables of the parent process (e.g. GIT_DIR when started from a hook).
 */
function gitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    ...extra,
  };
}

/** A git call on the customization repository that takes longer is killed (it would block every save). */
export const GIT_TIMEOUT_MS = 120_000;

/**
 * Runs git without a shell. Exit codes listed in `okCodes` resolve instead of rejecting; a call
 * running longer than `timeoutMs` is killed and rejects.
 */
export async function runGit(
  cwd: string,
  args: string[],
  opts: { env?: Record<string, string>; okCodes?: number[]; timeoutMs?: number } = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr, exitCode } = await execCommand(
      'git',
      ['-c', `core.hooksPath=${devNull}`, '-c', 'commit.gpgSign=false', ...args],
      {
        cwd,
        env: gitEnv(opts.env ?? {}),
        maxOutputBytes: 32 * 1024 * 1024,
        timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        okExitCodes: [0, ...(opts.okCodes ?? [])],
      },
    );
    return { stdout, stderr, code: exitCode };
  } catch (error) {
    if (!(error instanceof ExecCommandError)) throw error;
    throw new GitError(
      args,
      error.reason === 'exit_code' ? error.exitCode! : -1,
      error.reason === 'timeout' ? 'timed out' : error.stderr || error.message,
    );
  }
}
