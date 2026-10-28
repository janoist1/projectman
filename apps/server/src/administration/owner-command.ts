import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import os from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { BILLING_ENV_VARS, OWNER_COMMAND_OUTPUT_BYTES } from '@projectman/shared';
import type { AdministrationCommand, AdministrationResult } from '../contracts';
import { redactLine } from './redact';

type Command = Extract<AdministrationCommand, { kind: 'owner_command' }>;
type Result = Extract<AdministrationResult, { kind: 'owner_command' }>;
export type OwnerCommandRunner = (command: Command, signal: AbortSignal) => Promise<Result>;

interface OwnerCommandOptions {
  spawn?: (
    shell: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  killGroup?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
}

/** Keep bounded raw bytes until completion: redacting separate chunks would leak a token split across them. */
function capture() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    append(chunk: Buffer | string) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = OWNER_COMMAND_OUTPUT_BYTES - bytes;
      if (data.length > remaining) truncated = true;
      if (remaining > 0) {
        const kept = Buffer.from(data.subarray(0, remaining));
        chunks.push(kept);
        bytes += kept.length;
      }
    },
    result() {
      const raw = Buffer.concat(chunks).toString('utf8');
      // Strip CSI/OSC and C0/DEL before redaction, so escapes cannot split a secret or affect a terminal.
      const safe = stripVTControlCharacters(raw).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      const redacted = redactLine(safe);
      const points: string[] = [];
      let encodedBytes = 2; // JSON's enclosing quotes.
      let cut = false;
      for (const point of redacted) {
        const size = Buffer.byteLength(JSON.stringify(point)) - 2;
        if (encodedBytes + size > OWNER_COMMAND_OUTPUT_BYTES) {
          cut = true;
          break;
        }
        points.push(point);
        encodedBytes += size;
      }
      return { text: points.join(''), truncated: truncated || cut };
    },
  };
}

/** The sole host-shell boundary (PM-887), installed only from the supervisor's protected opt-in config. */
export function createOwnerCommandRunner(
  shell: string,
  options: OwnerCommandOptions = {},
): OwnerCommandRunner {
  const start = options.spawn ?? spawn;
  const now = options.now ?? Date.now;
  const killGroup = options.killGroup ?? ((pid, signal) => process.kill(-pid, signal));
  return (command, signal) =>
    new Promise<Result>((resolve, reject) => {
      signal.throwIfAborted();
      const started = now();
      const env = { ...(options.env ?? process.env) };
      for (const name of BILLING_ENV_VARS) delete env[name];
      const child = start(shell, ['-c', command.command], {
        cwd: command.cwd ?? options.home ?? os.homedir(),
        env,
        detached: true,
        stdio: 'pipe',
      });
      const stdout = capture();
      const stderr = capture();
      child.stdout.on('data', stdout.append);
      child.stderr.on('data', stderr.append);
      child.stdin.on('error', () => undefined);
      child.stdin.end();
      let completed = false;
      let stopping = false;
      let exited = false;
      let killed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;

      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        signal.removeEventListener('abort', stop);
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const finish = () => {
        if (completed) return;
        completed = true;
        cleanup();
        const out = stdout.result();
        const err = stderr.result();
        resolve({
          kind: 'owner_command',
          exitCode,
          signal: exitSignal,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          durationMs: Math.max(0, now() - started),
        });
      };
      const fail = (error: unknown) => {
        if (completed) return;
        completed = true;
        cleanup();
        reject(error);
      };
      const send = (signal: 'SIGTERM' | 'SIGKILL') => {
        if (child.pid === undefined) return;
        try {
          killGroup(child.pid, signal);
        } catch (error) {
          // A vanished group is harmless; other OS errors must not silently disable the deadline.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') fail(error);
        }
      };
      const stop = () => {
        if (stopping || completed) return;
        stopping = true;
        send('SIGTERM');
        if (completed) return;
        // Keep the grace timer even if the shell exits: descendants can still occupy its process group.
        killTimer = setTimeout(() => {
          killed = true;
          send('SIGKILL');
          // The shell's exit event carries the actual exit status. Close pipes that descendants may hold.
          child.stdout.destroy();
          child.stderr.destroy();
          if (exited) finish();
        }, 10_000);
      };
      const timeout = setTimeout(stop, command.timeoutSeconds * 1000);
      signal.addEventListener('abort', stop, { once: true });
      child.once('exit', (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        if (killed) finish();
      });
      child.once('close', (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        if (!stopping || killed) finish();
      });
      child.once('error', fail);
    });
}
