import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The outside world of the cloud commands (PM-534): processes, the network, DNS, the clock. The commands take it
 * as an argument, so their tests run with fakes (no AWS, no Cloudflare). The file system is the real one; the
 * tests use a temporary HOME.
 */

export interface RunResult {
  /** The exit status; 124 after the time limit, 127 when the command does not exist. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Written to the command's standard input (never put a secret in `args`). */
  input?: string;
  /** Added to the process environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** `inherit` hands the terminal to the command (an interactive ssh); the result's output is then empty. */
  stdio?: 'pipe' | 'inherit';
  /** Stops the command when it aborts (the result's code is then 130). */
  signal?: AbortSignal;
}

/** One side of `pipe`: a command with its environment additions. */
export interface PipeEnd {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Interrupts both processes, including SSH's SSM proxy descendants. */
  signal?: AbortSignal;
}

type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV' | 'CAA';

export interface CloudDeps {
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
  /** `from | to`: the standard output of the first is the standard input of the second. */
  pipe(from: PipeEnd, to: PipeEnd): Promise<RunResult>;
  fetch: typeof fetch;
  /** The records of a name (an empty list when there are none); `servers` are resolver IP addresses. */
  resolve(name: string, type: DnsRecordType, servers?: string[]): Promise<string[]>;
  out(line: string): void;
  err(line: string): void;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /**
   * Calls the handler on SIGINT, SIGTERM or SIGHUP (instead of the process dying at once, so a command can undo
   * what it opened); the result removes the handler.
   */
  onInterrupt(handler: () => void): () => void;
  /** The standard input, for the commands that take a request on it (`release-control`); absent in most fakes. */
  stdin?: AsyncIterable<Uint8Array>;
  /** The user's home directory (the secrets store is under it). */
  homeDir: string;
  /** The checkout the command runs from. */
  repoRoot: string;
}

/** The output of a command is kept up to this size; the end is what a failure message shows. */
const OUTPUT_LIMIT = 4_000_000;
const KILL_GRACE_MS = 5_000;

function keep(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next;
}

/** Cloud tools run on a POSIX owner machine. Each child owns its proxy/plugin process group. */
function stopGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  if (options.signal?.aborted) return Promise.resolve({ code: 130, stdout: '', stderr: '' });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const inherit = options.stdio === 'inherit';
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      // Even inherited stdio must not leave an AWS CLI/plugin behind when SSH exits.
      stopGroup(child, 'SIGKILL');
      options.signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      stdio: [
        options.input !== undefined ? 'pipe' : inherit ? 'inherit' : 'ignore',
        inherit ? 'inherit' : 'pipe',
        inherit ? 'inherit' : 'pipe',
      ],
      detached: true,
    });
    const stop = (signal: NodeJS.Signals) => {
      stopGroup(child, signal);
      if (!killTimer) killTimer = setTimeout(() => stopGroup(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
    }, options.timeoutMs ?? 2_147_483_647);
    function abort() {
      aborted = true;
      stop('SIGTERM');
    }
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout = keep(stdout, chunk)));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr = keep(stderr, chunk)));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({
        code: error.code === 'ENOENT' ? 127 : 126,
        stdout,
        stderr: `${stderr}${error.message}\n`,
      }),
    );
    // A proxy can still hold stderr open after SSH exits, preventing `close` indefinitely.
    child.on('exit', () => stopGroup(child, 'SIGKILL'));
    child.on('close', (code, signal) =>
      finish({
        code: aborted ? 130 : timedOut ? 124 : (code ?? (signal ? 128 : 1)),
        stdout,
        stderr: timedOut ? `${stderr}\nthe command did not finish in time and was stopped\n` : stderr,
      }),
    );
  });
}

function pipe(from: PipeEnd, to: PipeEnd): Promise<RunResult> {
  if (from.signal?.aborted || to.signal?.aborted)
    return Promise.resolve({ code: 130, stdout: '', stderr: '' });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const results: { first: number | null; second: number | null } = { first: null, second: null };
    const signals = [...new Set([from.signal, to.signal].filter((signal) => signal !== undefined))];
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (results.first === null || results.second === null) return;
      clearTimeout(killTimer);
      for (const signal of signals) signal.removeEventListener('abort', abort);
      stopGroup(first, 'SIGKILL');
      stopGroup(second, 'SIGKILL');
      resolve({ code: aborted ? 130 : results.first !== 0 ? results.first : results.second, stdout, stderr });
    };
    const first: ChildProcess = spawn(from.command, from.args, {
      env: { ...process.env, ...from.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const second: ChildProcess = spawn(to.command, to.args, {
      env: { ...process.env, ...to.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const stop = () => {
      stopGroup(first, 'SIGTERM');
      stopGroup(second, 'SIGTERM');
      if (!killTimer)
        killTimer = setTimeout(() => {
          stopGroup(first, 'SIGKILL');
          stopGroup(second, 'SIGKILL');
        }, KILL_GRACE_MS);
    };
    function abort() {
      aborted = true;
      stop();
    }
    for (const signal of signals) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    first.stdout?.pipe(second.stdin!);
    second.stdin?.on('error', () => undefined);
    first.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr = keep(stderr, chunk)));
    second.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr = keep(stderr, chunk)));
    second.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout = keep(stdout, chunk)));
    const failed = (which: 'first' | 'second') => (error: NodeJS.ErrnoException) => {
      stderr = `${stderr}${error.message}\n`;
      results[which] = error.code === 'ENOENT' ? 127 : 126;
      if (which === 'first') second.stdin?.end();
      // Wait for both close events before a host session removes its credentials.
      stop();
    };
    first.on('error', failed('first'));
    second.on('error', failed('second'));
    first.on('exit', () => stopGroup(first, 'SIGKILL'));
    second.on('exit', () => stopGroup(second, 'SIGKILL'));
    first.on('close', (code) => {
      results.first = code ?? results.first ?? 1;
      if (results.first !== 0) stop();
      finish();
    });
    second.on('close', (code) => {
      results.second = code ?? results.second ?? 1;
      if (results.second !== 0) stop();
      finish();
    });
  });
}

const EMPTY_ANSWER = new Set(['ENODATA', 'ENOTFOUND', 'NODATA', 'NXDOMAIN']);

async function resolve(name: string, type: DnsRecordType, servers?: string[]): Promise<string[]> {
  const resolver = new Resolver();
  if (servers && servers.length > 0) resolver.setServers(servers);
  try {
    switch (type) {
      case 'A':
        return await resolver.resolve4(name);
      case 'AAAA':
        return await resolver.resolve6(name);
      case 'CNAME':
        return await resolver.resolveCname(name);
      case 'NS':
        return await resolver.resolveNs(name);
      case 'MX':
        return (await resolver.resolveMx(name)).map((record) => `${record.priority} ${record.exchange}`);
      case 'TXT':
        return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
      case 'SRV':
        return (await resolver.resolveSrv(name)).map(
          (record) => `${record.priority} ${record.weight} ${record.port} ${record.name}`,
        );
      case 'CAA':
        return (await resolver.resolveCaa(name)).map((record) => {
          const tag = ['issue', 'issuewild', 'iodef'].find((key) => key in record) ?? 'issue';
          const value = (record as unknown as Record<string, unknown>)[tag];
          return `${record.critical} ${tag} "${String(value)}"`;
        });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && EMPTY_ANSWER.has(code)) return [];
    throw error;
  }
}

export function realDeps(): CloudDeps {
  return {
    run,
    pipe,
    fetch: (input, init) => fetch(input, init),
    resolve,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    onInterrupt: (handler) => {
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      for (const signal of signals) process.on(signal, handler);
      return () => {
        for (const signal of signals) process.off(signal, handler);
      };
    },
    stdin: process.stdin,
    homeDir: os.homedir(),
    repoRoot: path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
  };
}
