import { execFile } from 'node:child_process';

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
];

export const GIT_TIMEOUT_MS = 120_000;

export class GitCommandError extends Error {
  readonly args: string[];
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(args: string[], stderr: string, exitCode: number | null, cause: unknown) {
    const detail = stderr.trim() || (cause instanceof Error ? cause.message : String(cause));
    super(`git ${args.join(' ')} failed${exitCode === null ? '' : ` (exit ${exitCode})`}: ${detail}`, {
      cause,
    });
    this.name = 'GitCommandError';
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/**
 * Runs git without a shell and returns stdout. Git never prompts (no terminal), optional
 * locks are skipped so background status checks do not collide with a session's own git
 * commands, and inherited GIT_DIR-style variables are dropped. `isolatedConfig` also ignores the
 * system and global configuration and the inherited GIT_CONFIG_* variables (for repositories a
 * member controls, see `member-workspace-manager.ts`).
 */
export function git(
  args: string[],
  opts: { timeoutMs?: number; isolatedConfig?: boolean } = {},
): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const name of REPOSITORY_OVERRIDES) delete env[name];
  if (opts.isolatedConfig) {
    for (const name of Object.keys(env)) if (name.startsWith('GIT_CONFIG_')) delete env[name];
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = '/dev/null';
    env.GIT_NO_LAZY_FETCH = '1';
    delete env.GIT_TEMPLATE_DIR;
    delete env.GIT_EXEC_PATH;
    delete env.GIT_SSH_COMMAND;
    delete env.GIT_ASKPASS;
  }
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        env,
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new GitCommandError(args, stderr, typeof error.code === 'number' ? error.code : null, error),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** Runs git; stdout on success, null when git exits with an error (for probes). */
export async function tryGit(args: string[]): Promise<string | null> {
  try {
    return await git(args);
  } catch (err) {
    if (err instanceof GitCommandError) return null;
    throw err;
  }
}

/** An ISO time (UTC) from git's output of a date, or null when it holds none. */
export function isoOrNull(output: string | null): string | null {
  const time = Date.parse((output ?? '').trim());
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** Whether a git probe like `rev-parse --verify` succeeds. */
export async function gitSucceeds(args: string[]): Promise<boolean> {
  return (await tryGit(args)) !== null;
}
