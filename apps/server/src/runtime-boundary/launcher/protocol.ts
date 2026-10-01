import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { WORKER_PROGRAMS } from '../../contracts';

/**
 * The launcher's wire protocol: newline-delimited JSON over its unix socket, one request per
 * connection. `ping` and `run` get one answer and the connection closes; `start` gets an answer
 * and the connection then carries the session's terminal until it exits (frames below). Closing
 * the connection stops the session. Every request is validated strictly; the launcher adds the
 * account, the program path, the environment and the sandbox itself.
 */

export const LAUNCHER_PROTOCOL_VERSION = 1;
/** A request line may carry a long system prompt in the CLI arguments. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** A terminal frame (input from the browser, output of the TUI). */
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_RUN_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;

const Handle = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const NoNul = z.string().refine((s) => !s.includes('\0'), { message: 'NUL character' });
const Args = z
  .array(NoNul.max(MAX_REQUEST_BYTES))
  .max(1024)
  .refine((args) => args.reduce((n, a) => n + a.length, 0) <= MAX_REQUEST_BYTES, {
    message: 'arguments too long',
  });
const Cwd = NoNul.min(1).max(1024).refine((p) => !/[\n\r]/.test(p), { message: 'line break' });

export const PingRequest = z.strictObject({ op: z.literal('ping') });
export const RunRequest = z.strictObject({
  op: z.literal('run'),
  member: Handle,
  program: z.enum(WORKER_PROGRAMS),
  args: Args,
  cwd: Cwd,
  timeoutMs: z.number().int().min(1000).max(MAX_RUN_TIMEOUT_MS).optional(),
});
export const StartRequest = z.strictObject({
  op: z.literal('start'),
  sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]{1,64}$/),
  member: Handle,
  provider: z.enum(['claude', 'codex']),
  args: Args,
  cwd: Cwd,
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(300),
  egressToken: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});
export const LauncherRequest = z.discriminatedUnion('op', [PingRequest, RunRequest, StartRequest]);
export type LauncherRequest = z.infer<typeof LauncherRequest>;
export type RunRequest = z.infer<typeof RunRequest>;
export type StartRequest = z.infer<typeof StartRequest>;

/** Stable refusal codes of the launcher (no detail that could carry caller input). */
export const LauncherErrorCode = z.enum([
  'invalid_request',
  'unknown_worker',
  'cwd_outside_home',
  'forbidden_argument',
  'too_many_sessions',
  'session_exists',
  'spawn_failed',
]);
export type LauncherErrorCode = z.infer<typeof LauncherErrorCode>;

export const LauncherError = z.strictObject({
  ok: z.literal(false),
  error: LauncherErrorCode,
  message: z.string().max(500),
});
export const PingAnswer = z.strictObject({ ok: z.literal(true), version: z.number().int() });
export const RunAnswer = z.strictObject({
  ok: z.literal(true),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
});
export const StartAnswer = z.strictObject({ ok: z.literal(true), pid: z.number().int() });

/** Service -> launcher, after a successful start. */
export const ClientFrame = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('input'), data: z.string().max(MAX_FRAME_BYTES) }),
  z.strictObject({ t: z.literal('resize'), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(300) }),
  z.strictObject({ t: z.literal('kill'), signal: z.enum(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']).optional() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** Launcher -> service, after a successful start. */
export const SessionFrame = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('data'), data: z.string() }),
  z.strictObject({ t: z.literal('exit'), exitCode: z.number().int(), signal: z.number().int().nullable() }),
]);
export type SessionFrame = z.infer<typeof SessionFrame>;

/**
 * Splits a byte stream into lines and hands each parsed JSON value to `onLine`. A line longer
 * than `maxBytes` or a value that is not JSON calls `onError` once and stops reading.
 */
export function lineReader(
  maxBytes: number,
  onLine: (value: unknown) => void,
  onError: (reason: string) => void,
): (chunk: Buffer | string) => void {
  let buffered = '';
  let failed = false;
  // A multi-byte character may be split between two chunks.
  const decoder = new StringDecoder('utf8');
  return (chunk) => {
    if (failed) return;
    buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          failed = true;
          onError('malformed line');
          return;
        }
        onLine(value);
        if (failed) return;
      }
      newline = buffered.indexOf('\n');
    }
    if (Buffer.byteLength(buffered) > maxBytes) {
      failed = true;
      onError('line too long');
    }
  };
}

export function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
