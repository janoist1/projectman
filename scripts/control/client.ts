// The control command's logic (PM-219): talks to the server's control socket and prints the pause.
// scripts/control/cli.ts is the thin entrance; the tests drive `runControl` against a real socket.
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROL_SOCKET_NAME,
  ControlResponse,
  DEFAULT_PAUSE_FORCE_AFTER_MS,
  MAX_PAUSE_FORCE_AFTER_MS,
} from '@projectman/shared';
import type { ControlRequest, PausedSession, PauseStatus } from '@projectman/shared';

/** Nobody answers on the socket: the server does not run (or has no control socket). */
export class ControlUnreachable extends Error {}
/** The command line is wrong. */
export class ControlUsageError extends Error {}
/** The server understood the request and refused it. */
class ControlRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/** One request, one answer, over a fresh connection. */
export function sendControlRequest(
  target: string | net.NetConnectOpts,
  request: ControlRequest,
): Promise<ControlResponse> {
  const where = typeof target === 'string' ? target : JSON.stringify(target);
  return new Promise((resolve, reject) => {
    const connection = net.connect(typeof target === 'string' ? { path: target } : target);
    let buffer = '';
    const finish = (error?: Error, response?: ControlResponse) => {
      connection.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    connection.setEncoding('utf8');
    connection.setTimeout(REQUEST_TIMEOUT_MS, () => finish(new Error('the server did not answer in time')));
    connection.once('connect', () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(undefined, ControlResponse.parse(JSON.parse(buffer.slice(0, newline))));
      } catch {
        finish(new Error('the server answered with something that is not a control response'));
      }
    });
    connection.on('error', (err: NodeJS.ErrnoException) =>
      finish(
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? new ControlUnreachable(`nobody answers on ${where}: the server does not run`)
          : err,
      ),
    );
    connection.on('end', () => finish(new Error('the server closed the connection without an answer')));
  });
}

const workItemLabel = (item: PausedSession['workItem']): string => {
  switch (item.type) {
    case 'task':
      return item.taskKey;
    case 'meeting':
      return `meeting ${item.meetingId}`;
    case 'schedule':
      return `schedule run ${item.runId}`;
    case 'general':
      return 'general chat';
  }
};

/** The sessions that have not come to a stop yet. */
export const stragglers = (pause: PauseStatus): PausedSession[] =>
  pause.sessions.filter((s) => s.point === null);

export function describeStragglers(pause: PauseStatus): string[] {
  return stragglers(pause).map(
    (s) =>
      `  still working: ${s.member} (${s.projectKey}, ${workItemLabel(s.workItem)})` +
      (s.waitingFor ? `, waiting for ${s.waitingFor}` : ''),
  );
}

export function formatPause(pause: PauseStatus | null): string {
  if (!pause) return 'No pause is open.';
  const stopped = pause.sessions.length - stragglers(pause).length;
  return [
    `Pause ${pause.id}: ${pause.state} (${pause.kind}, requested ${pause.requestedAt}${
      pause.reason ? `, reason: ${pause.reason}` : ''
    })`,
    `  ${stopped} of ${pause.sessions.length} sessions stopped; the rest are cut at ${pause.forceAt}`,
    ...describeStragglers(pause),
  ].join('\n');
}

interface Options {
  command: 'pause' | 'resume' | 'force' | 'status';
  wait: boolean;
  json: boolean;
  forceAfterMs?: number;
  reason?: string;
  timeoutMs?: number;
  home?: string;
}

const BOOLEAN_FLAGS = new Set(['wait', 'json']);
const COMMANDS = ['pause', 'resume', 'force', 'status'] as const;

function seconds(name: string, value: string, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max)
    throw new ControlUsageError(`--${name} must be 0-${max} seconds`);
  return Math.round(n * 1000);
}

export function parseControlArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) flags.set(name, 'true');
    else if (['force-after', 'reason', 'timeout', 'home'].includes(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new ControlUsageError(`--${name} needs a value`);
      flags.set(name, value);
      i += 1;
    } else throw new ControlUsageError(`unknown option --${name}`);
  }
  const command = COMMANDS.find((c) => c === positional[0]);
  if (!command || positional.length !== 1)
    throw new ControlUsageError('commands: pause, resume, force, status');
  if (command !== 'pause') {
    for (const name of ['wait', 'force-after', 'reason', 'timeout'])
      if (flags.has(name)) throw new ControlUsageError(`--${name} is for pause only`);
  }
  if (!flags.has('wait') && flags.has('timeout')) throw new ControlUsageError('--timeout needs --wait');
  return {
    command,
    wait: flags.has('wait'),
    json: flags.has('json'),
    forceAfterMs: flags.has('force-after')
      ? seconds('force-after', flags.get('force-after')!, MAX_PAUSE_FORCE_AFTER_MS / 1000)
      : undefined,
    reason: flags.get('reason'),
    timeoutMs: flags.has('timeout') ? seconds('timeout', flags.get('timeout')!, 24 * 3600) : undefined,
    home: flags.get('home'),
  };
}

export interface ControlDeps {
  env?: Record<string, string | undefined>;
  /** Where to connect instead of the home's socket file (tests serve the protocol on a loopback port). */
  target?: net.NetConnectOpts;
  out?: (line: string) => void;
  err?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}

/** How long `--wait` lasts when `--timeout` is not given: the sessions are cut at the deadline, plus some time to stop. */
const WAIT_BEYOND_DEADLINE_MS = 30_000;

/** Exit status: 0 done, 1 refused, failed or timed out, 2 the server does not run. */
export async function runControl(argv: string[], deps: ControlDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 1000;
  try {
    const options = parseControlArgs(argv);
    const env = deps.env ?? process.env;
    const home = options.home ?? env.PROJECTMAN_HOME ?? join(homedir(), '.projectman');
    const target = deps.target ?? join(home, CONTROL_SOCKET_NAME);
    const send = async (request: ControlRequest): Promise<PauseStatus | null> => {
      const response = await sendControlRequest(target, request);
      if (!response.ok) throw new ControlRefused(response.error.code, response.error.message);
      return response.pause;
    };

    const request: ControlRequest =
      options.command === 'pause'
        ? { op: 'pause', reason: options.reason, forceAfterMs: options.forceAfterMs }
        : { op: options.command };
    let pause = await send(request);
    // With --json only the last answer goes to stdout, so a script can parse it; the progress goes to stderr.
    const progress = options.json ? err : out;
    if (!options.json || !options.wait) out(options.json ? JSON.stringify(pause) : formatPause(pause));
    if (!options.wait) return 0;

    const timeoutMs =
      options.timeoutMs ?? (options.forceAfterMs ?? DEFAULT_PAUSE_FORCE_AFTER_MS) + WAIT_BEYOND_DEADLINE_MS;
    const deadline = now() + timeoutMs;
    let shown = '';
    for (;;) {
      if (!pause) {
        err('the pause was resumed while waiting for it');
        return 1;
      }
      if (pause.state === 'paused') {
        if (options.json) out(JSON.stringify(pause));
        else progress(`All ${pause.sessions.length} sessions have stopped.`);
        return 0;
      }
      const waiting = describeStragglers(pause).join('\n');
      if (waiting !== shown) {
        progress(waiting);
        shown = waiting;
      }
      if (now() >= deadline) {
        err(`timed out after ${Math.round(timeoutMs / 1000)} s; the sessions above have not stopped`);
        if (options.json) out(JSON.stringify(pause));
        return 1;
      }
      await sleep(pollMs);
      pause = await send({ op: 'status' });
    }
  } catch (error) {
    if (error instanceof ControlUsageError) {
      err(`usage error: ${error.message}`);
      err(
        'usage: npm run control -- pause [--wait] [--force-after <s>] [--reason <text>] [--timeout <s>] | resume | force | status [--home <dir>] [--json]',
      );
      return 1;
    }
    if (error instanceof ControlUnreachable) {
      err(error.message);
      return 2;
    }
    if (error instanceof ControlRefused) {
      err(`refused: ${error.code}: ${error.message}`);
      return 1;
    }
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
