import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Starting an agent CLI (Claude Code, Codex, or a fake CLI in tests). */

const SCRIPT_RE = /\.(?:mjs|cjs|js)$/;

/**
 * How to spawn the CLI: a JavaScript file (the fake CLI in tests) runs with the current
 * Node binary, so neither the executable bit nor PATH matters.
 */
export function resolveCommand(bin: string, args: string[]): { file: string; args: string[] } {
  if (SCRIPT_RE.test(bin)) return { file: process.execPath, args: [bin, ...args] };
  return { file: bin, args };
}

/**
 * Whether the CLI can be started: a script file must exist, a path must be an executable
 * file, and a bare name must be found on `pathEnv`.
 */
export async function cliExists(bin: string, pathEnv: string | undefined): Promise<boolean> {
  return (await resolveCliPath(bin, pathEnv)) !== null;
}

/** Resolve the first usable CLI on the session PATH, including symbolic link chains. */
export async function resolveCliPath(bin: string, pathEnv: string | undefined): Promise<string | null> {
  const usable = async (file: string, mode: number) => {
    try {
      await access(file, mode);
      return (await stat(file)).isFile() ? await realpath(file) : null;
    } catch {
      return null;
    }
  };
  if (SCRIPT_RE.test(bin)) return usable(bin, constants.R_OK);
  if (bin.includes('/')) return usable(path.resolve(bin), constants.X_OK);
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (dir) {
      const resolved = await usable(path.join(dir, bin), constants.X_OK);
      if (resolved) return resolved;
    }
  }
  return null;
}

export interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawning failed or the command timed out. */
  error: string | null;
}

const MAX_OUTPUT = 64 * 1024;

/** Runs a short CLI command (stdin closed) and collects its output. Never rejects. */
export function runQuietly(
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    const { file, args: argv } = resolveCommand(bin, args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error });
    };
    let child;
    try {
      child = spawn(file, argv, { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout, stderr, error: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, `timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code, null));
  });
}
