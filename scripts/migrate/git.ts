import { devNull } from 'node:os';
import { execCommand, ExecCommandError } from '../../apps/server/src/exec';

/**
 * git for the move tool (PM-143). It only reads the owner's repositories, except where a command
 * says it writes (the new machine's repositories, the copy of the customization repository). Hooks
 * never run, nothing prompts, and the output is in the C locale so it can be parsed.
 */
export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function gitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...extra };
}

/** Runs git without a shell; a non-zero exit rejects unless `okCodes` lists it. */
export async function git(
  cwd: string,
  args: string[],
  opts: { okCodes?: number[]; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr, exitCode } = await execCommand(
      'git',
      ['-c', `core.hooksPath=${devNull}`, '-c', 'commit.gpgSign=false', ...args],
      {
        cwd,
        env: gitEnv(opts.env ?? {}),
        maxOutputBytes: 256 * 1024 * 1024,
        timeoutMs: opts.timeoutMs ?? 300_000,
        okExitCodes: [0, ...(opts.okCodes ?? [])],
      },
    );
    return { stdout, stderr, code: exitCode };
  } catch (error) {
    if (!(error instanceof ExecCommandError)) throw error;
    const code = error.reason === 'exit_code' ? error.exitCode : 1;
    throw new Error(
      `git ${args[0] ?? ''} failed (${code}) in ${cwd}: ${error.stderr.trim() || error.message}`,
    );
  }
}

/** Whether `dir` is inside a git work tree (or is a repository). */
export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    const { stdout } = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** A remote URL without the user information a URL may carry (`https://user:token@host/...`). */
export function redactRemoteUrl(url: string): { url: string; hadCredentials: boolean } {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]+)@(.*)$/i.exec(url);
  if (!match) return { url, hadCredentials: false };
  // ssh://git@host/... carries only a user name, no secret; anything with a password or a token does.
  const userinfo = match[2]!;
  const isPlainUser = !userinfo.includes(':') && match[1]!.toLowerCase().startsWith('ssh');
  return isPlainUser
    ? { url, hadCredentials: false }
    : { url: `${match[1]}${match[3]}`, hadCredentials: true };
}
