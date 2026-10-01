import net from 'node:net';
import type { Duplex } from 'node:stream';
import type {
  LaunchSessionRequest,
  LaunchedSession,
  SessionLauncher,
  WorkerRunRequest,
  WorkerRunResult,
} from '../../contracts';
import {
  LauncherError,
  MAX_FRAME_BYTES,
  PingAnswer,
  RunAnswer,
  SessionFrame,
  StartAnswer,
  frame,
  lineReader,
} from './protocol';

/** A refusal or failure of the launcher, with its code (`LauncherErrorCode` or `unreachable`). */
export class LauncherClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LauncherClientError';
    this.code = code;
  }
}

/** Exit code reported when the launcher connection ends without the session's own exit. */
export const LOST_EXIT_CODE = 255;
const SIGNALS: Record<string, 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP'> = {
  SIGTERM: 'SIGTERM',
  SIGKILL: 'SIGKILL',
  SIGINT: 'SIGINT',
  SIGHUP: 'SIGHUP',
};

export interface LauncherClientOptions {
  /** The launcher's socket (the boundary configuration's `launcher.socket`). */
  socketPath: string;
  /** Opens a connection (tests pass an in-memory pair). Default: the unix socket. */
  connect?: () => Duplex;
  /** How long a request waits for its answer (default 15 s; `run` adds its own timeout). */
  answerTimeoutMs?: number;
}

/** The session's terminal over the launcher connection. */
class RemoteSession implements LaunchedSession {
  readonly pid: number;
  private readonly conn: Duplex;
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  private readonly pendingData: string[] = [];
  private exitEvent: { exitCode: number; signal?: number } | null = null;
  private exitDelivered = false;

  constructor(conn: Duplex, pid: number) {
    this.conn = conn;
    this.pid = pid;
  }

  receive(value: unknown): void {
    const parsed = SessionFrame.safeParse(value);
    if (!parsed.success) return;
    if (parsed.data.t === 'data') {
      if (this.dataListeners.length === 0) this.pendingData.push(parsed.data.data);
      else for (const listener of this.dataListeners) listener(parsed.data.data);
    } else {
      this.exited({ exitCode: parsed.data.exitCode, ...(parsed.data.signal === null ? {} : { signal: parsed.data.signal }) });
    }
  }

  exited(event: { exitCode: number; signal?: number }): void {
    if (this.exitEvent) return;
    this.exitEvent = event;
    this.deliverExit();
  }

  private deliverExit(): void {
    if (!this.exitEvent || this.exitDelivered || this.exitListeners.length === 0) return;
    this.exitDelivered = true;
    for (const listener of this.exitListeners) listener(this.exitEvent);
  }

  write(data: string): void {
    for (let i = 0; i < data.length; i += MAX_FRAME_BYTES / 4) {
      this.send({ t: 'input', data: data.slice(i, i + MAX_FRAME_BYTES / 4) });
    }
  }

  resize(cols: number, rows: number): void {
    this.send({ t: 'resize', cols, rows });
  }

  kill(signal?: string): void {
    this.send({ t: 'kill', signal: SIGNALS[signal ?? 'SIGTERM'] ?? 'SIGTERM' });
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
    for (const data of this.pendingData.splice(0)) listener(data);
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitListeners.push(listener);
    this.deliverExit();
  }

  private send(value: unknown): void {
    if (!this.conn.destroyed && this.conn.writable) this.conn.write(frame(value));
  }
}

/** The service's side of the launcher protocol (`SessionLauncher`). */
export function createLauncherClient(opts: LauncherClientOptions): SessionLauncher {
  const connect = opts.connect ?? (() => net.createConnection(opts.socketPath));
  const answerTimeoutMs = opts.answerTimeoutMs ?? 15_000;

  /** Sends one request; resolves with its first answer and the connection, still open. */
  function request(
    body: unknown,
    timeoutMs: number,
    onFrame?: (value: unknown) => void,
  ): Promise<{ answer: unknown; conn: Duplex }> {
    return new Promise((resolve, reject) => {
      let conn: Duplex;
      try {
        conn = connect();
      } catch (err) {
        reject(new LauncherClientError('unreachable', `the launcher is unreachable: ${(err as Error).message}`));
        return;
      }
      let answered = false;
      const timer = setTimeout(() => {
        if (answered) return;
        answered = true;
        conn.destroy();
        reject(new LauncherClientError('unreachable', 'the launcher did not answer'));
      }, timeoutMs);
      const read = lineReader(
        64 * 1024 * 1024,
        (value) => {
          if (!answered) {
            answered = true;
            clearTimeout(timer);
            resolve({ answer: value, conn });
          } else onFrame?.(value);
        },
        () => conn.destroy(),
      );
      conn.on('data', read);
      conn.on('error', (err) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        reject(new LauncherClientError('unreachable', `the launcher is unreachable: ${err.message}`));
      });
      conn.on('close', () => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        reject(new LauncherClientError('unreachable', 'the launcher closed the connection'));
      });
      conn.write(frame(body));
    });
  }

  function refusal(answer: unknown): LauncherClientError {
    const error = LauncherError.safeParse(answer);
    return error.success
      ? new LauncherClientError(error.data.error, `the launcher refused: ${error.data.message}`)
      : new LauncherClientError('invalid_answer', 'the launcher gave an unexpected answer');
  }

  return {
    async ping() {
      try {
        const { answer, conn } = await request({ op: 'ping' }, 3000);
        conn.destroy();
        return PingAnswer.safeParse(answer).success;
      } catch {
        return false;
      }
    },

    async run(req: WorkerRunRequest): Promise<WorkerRunResult> {
      const { answer, conn } = await request(
        { op: 'run', ...req },
        (req.timeoutMs ?? 120_000) + answerTimeoutMs,
      );
      conn.destroy();
      const parsed = RunAnswer.safeParse(answer);
      if (!parsed.success) throw refusal(answer);
      const { exitCode, stdout, stderr, timedOut } = parsed.data;
      return { exitCode, stdout, stderr, timedOut };
    },

    async start(req: LaunchSessionRequest): Promise<LaunchedSession> {
      let session: RemoteSession | null = null;
      const early: unknown[] = [];
      const { answer, conn } = await request({ op: 'start', ...req }, answerTimeoutMs, (value) =>
        session ? session.receive(value) : early.push(value),
      );
      const parsed = StartAnswer.safeParse(answer);
      if (!parsed.success) {
        conn.destroy();
        throw refusal(answer);
      }
      const remote = new RemoteSession(conn, parsed.data.pid);
      session = remote;
      for (const value of early.splice(0)) remote.receive(value);
      conn.on('close', () => remote.exited({ exitCode: LOST_EXIT_CODE }));
      if (conn.destroyed) remote.exited({ exitCode: LOST_EXIT_CODE });
      return remote;
    },
  };
}
