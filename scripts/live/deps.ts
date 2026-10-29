import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CONTROL_SOCKET_NAME } from '@projectman/shared';
import type { ControlRequest, ControlResponse } from '@projectman/shared';
import { sendControlRequest } from '../control/client';

/**
 * The outside world of the live commands (PM-493): processes, the control socket, the network, the clock.
 * The commands take it as an argument, so their tests run with fakes (no launchd, no GitHub, no sockets).
 * The file system is the real one; the tests use a temporary directory.
 */

export interface RunOptions {
  /** The absolute working directory of the command. */
  cwd: string;
  /** Added to the process environment. */
  env?: NodeJS.ProcessEnv;
  /** Names removed from the environment the command inherits. */
  unsetEnv?: readonly string[];
  timeoutMs?: number;
}

export interface RunResult {
  /** The exit status; 124 after the time limit, 127 when the command does not exist. */
  status: number;
  stdout: string;
  stderr: string;
}

export interface LiveDeps {
  run(command: string, args: string[], options: RunOptions): Promise<RunResult>;
  /** One request on the live server's control socket; rejects with `ControlUnreachable` when nobody answers. */
  control(request: ControlRequest): Promise<ControlResponse>;
  /** The HTTP status of a GET, or null when nobody answers. */
  httpStatus(url: string): Promise<number | null>;
  portListening(port: number): Promise<boolean>;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  now(): Date;
  sleep(ms: number): Promise<void>;
  out(text: string): void;
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly pid: number;
  /** The absolute path of `node` (`process.execPath`). */
  readonly nodePath: string;
  /** The environment of the process: the install copies names from it into the plist. */
  readonly env: NodeJS.ProcessEnv;
  /** The user's home directory (`~/Library/LaunchAgents` is under it). */
  readonly homeDir: string;
}

/** The output of a command is kept up to this size; the end is what a failure message shows. */
const OUTPUT_LIMIT = 1_000_000;
const KILL_GRACE_MS = 5_000;

function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const keep = (current: string, chunk: string) => {
      const next = current + chunk;
      return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next;
    };
    const env = { ...process.env, ...options.env };
    for (const name of options.unsetEnv ?? []) delete env[name];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so that the time limit ends npm's children too.
      detached: true,
    });
    const stop = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), KILL_GRACE_MS).unref();
    }, options.timeoutMs ?? 2_147_483_647);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout = keep(stdout, chunk)));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = keep(stderr, chunk)));
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({
        status: error.code === 'ENOENT' ? 127 : 126,
        stdout,
        stderr: `${stderr}${error.message}\n`,
      }),
    );
    child.on('close', (code, signal) =>
      finish({
        status: timedOut ? 124 : (code ?? (signal ? 128 : 1)),
        stdout,
        stderr: timedOut ? `${stderr}\nthe command did not finish in time and was stopped\n` : stderr,
      }),
    );
  });
}

function canConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(2_000, () => socket.destroy());
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('close', () => resolve(false));
  });
}

export function realDeps(home: string): LiveDeps {
  return {
    run,
    control: (request) => sendControlRequest(path.join(home, CONTROL_SOCKET_NAME), request),
    httpStatus: async (url) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        return response.status;
      } catch {
        return null;
      }
    },
    portListening: async (port) => (await canConnect(port, '127.0.0.1')) || (await canConnect(port, '::1')),
    kill: (pid, signal) => process.kill(pid, signal),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    out: (text) => process.stdout.write(text),
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    pid: process.pid,
    nodePath: process.execPath,
    env: process.env,
    homeDir: os.homedir(),
  };
}
