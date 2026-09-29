import { spawn } from 'node:child_process';
import os from 'node:os';
import type { AgentProvider } from '@projectman/shared';
import type { ProviderStatus } from '../../contracts';
import { resolveCommand } from '../claude-args';

/**
 * Login checks. Both CLIs report their login without a model request, so a check spends no
 * usage: `claude auth status` (JSON on stdout) and `codex login status` (a line on stderr).
 * They run with the same billing-safe environment as member sessions. Only a subscription
 * login counts as logged in: an API-key login would bill the API.
 */

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

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  );
}

function unknown(provider: AgentProvider, now: Date, why: string): ProviderStatus {
  return { provider, loggedIn: null, method: null, checkedAt: now.toISOString(), detail: why };
}

const API_KEY_METHOD = /api[\s_-]?key/i;

/** `claude auth status`: `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}`. */
export function parseClaudeAuthStatus(out: CommandOutput, now: Date = new Date()): ProviderStatus {
  const start = out.stdout.indexOf('{');
  const end = out.stdout.lastIndexOf('}');
  let json: Record<string, unknown> | null = null;
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(out.stdout.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        json = parsed as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  if (!json || typeof json.loggedIn !== 'boolean') {
    const why = out.error ?? (firstLine(out.stderr) || firstLine(out.stdout) || `exit code ${out.code}`);
    return unknown('claude', now, `could not read \`claude auth status\`: ${why}`);
  }
  const method = typeof json.authMethod === 'string' ? json.authMethod : null;
  const apiProvider = typeof json.apiProvider === 'string' ? json.apiProvider : null;
  const status: ProviderStatus = {
    provider: 'claude',
    loggedIn: json.loggedIn,
    method,
    checkedAt: now.toISOString(),
  };
  if (!json.loggedIn) {
    status.detail = 'Claude Code is not logged in: run `claude` in a terminal and log in with /login';
  } else if ((method && API_KEY_METHOD.test(method)) || (apiProvider && apiProvider !== 'firstParty')) {
    status.loggedIn = false;
    status.detail = `Claude Code is logged in with ${method ?? apiProvider}, which bills the API; members run on a Claude subscription only`;
  }
  return status;
}

/** `codex login status`: "Logged in using ChatGPT", "Not logged in", ... (on stderr). */
export function parseCodexLoginStatus(out: CommandOutput, now: Date = new Date()): ProviderStatus {
  const text = `${out.stdout}\n${out.stderr}`;
  const at = now.toISOString();
  if (/Logged in using ChatGPT/i.test(text)) {
    return { provider: 'codex', loggedIn: true, method: 'chatgpt', checkedAt: at };
  }
  if (/Not logged in/i.test(text)) {
    return {
      provider: 'codex',
      loggedIn: false,
      method: 'none',
      checkedAt: at,
      detail: 'Codex is not logged in: run `codex login` in a terminal and sign in with ChatGPT',
    };
  }
  const other = /Logged in using (?:an? )?([^\n-]+?)(?:\s+-\s+.*)?$/im.exec(text);
  if (other) {
    const what = other[1]!.trim();
    const method = API_KEY_METHOD.test(what) ? 'api_key' : what.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return {
      provider: 'codex',
      loggedIn: false,
      method,
      checkedAt: at,
      detail: `Codex is logged in with ${what}, not a ChatGPT subscription; members run on a subscription only`,
    };
  }
  const why = out.error ?? (firstLine(out.stderr) || firstLine(out.stdout) || `exit code ${out.code}`);
  return unknown('codex', now, `could not read \`codex login status\`: ${why}`);
}
