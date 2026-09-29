import { execFile } from 'node:child_process';
import { devNull } from 'node:os';

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

/** Runs git without a shell. Exit codes listed in `okCodes` resolve instead of rejecting. */
export function runGit(
  cwd: string,
  args: string[],
  opts: { env?: Record<string, string>; okCodes?: number[] } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', `core.hooksPath=${devNull}`, '-c', 'commit.gpgSign=false', ...args],
      { cwd, env: gitEnv(opts.env ?? {}), maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, code: 0 });
        const code = typeof error.code === 'number' ? error.code : -1;
        if (opts.okCodes?.includes(code)) return resolve({ stdout, stderr, code });
        reject(new GitError(args, code, stderr || error.message));
      },
    );
  });
}
