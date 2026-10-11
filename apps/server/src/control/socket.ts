import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { ControlRequest } from '@projectman/shared';
import type { ControlResponse, PauseRequest, PauseStatus, Release, ReleaseReport } from '@projectman/shared';

/** The instance's pause, as the control socket drives it (the app composes this from the domain). */
export interface ControlPause {
  pause(request: PauseRequest): Promise<PauseStatus | null>;
  resume(): Promise<PauseStatus | null>;
  force(): Promise<PauseStatus | null>;
  status(): PauseStatus | null;
}

/**
 * The instance's releases, as the release watcher drives them (PM-491; the app composes this from the
 * domain). Every method refuses with `release_not_configured` when the instance is not set up to release.
 */
export interface ControlRelease {
  /** The commit the answering server runs. */
  appVersion(): string;
  /** The release the watcher has something to do with, if any. */
  next(): Release | null;
  claim(releaseId: string, previousCommit: string | null): Release;
  report(releaseId: string, report: ReleaseReport): Promise<Release>;
}

export interface ControlLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ControlSocket {
  close(): Promise<void>;
}

/** The longest request line taken; a longer one is a client that is not ours. */
const MAX_LINE_BYTES = 16 * 1024;
const IDLE_MS = 30_000;
const PROBE_MS = 1_000;

/** `sun_path` holds 104 bytes on macOS and 108 on Linux, with the terminating zero. */
const maxSocketPathBytes = (): number => (process.platform === 'darwin' ? 103 : 107);

/** Whether somebody answers on the socket file: a live server owns it, a leftover file is nobody's. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(path);
    const done = (result: boolean) => {
      probe.destroy();
      resolve(result);
    };
    probe.setTimeout(PROBE_MS, () => done(false));
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });
}

const failure = (code: string, message: string): ControlResponse => ({ ok: false, error: { code, message } });

async function respond(
  pause: ControlPause,
  release: ControlRelease | undefined,
  line: string,
): Promise<ControlResponse> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return failure('invalid_request', 'the request is not JSON');
  }
  const parsed = ControlRequest.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failure(
      'invalid_request',
      `${issue?.path.join('.') || 'request'}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const request = parsed.data;
  // The watcher tells a restarted server by the commit it runs: every answer carries it.
  const version = release ? { appVersion: release.appVersion() } : {};
  switch (request.op) {
    case 'pause':
      return {
        ok: true,
        pause: await pause.pause({ reason: request.reason, forceAfterMs: request.forceAfterMs }),
        ...version,
      };
    case 'resume':
      return { ok: true, pause: await pause.resume(), ...version };
    case 'force':
      return { ok: true, pause: await pause.force(), ...version };
    case 'status':
      return { ok: true, pause: pause.status(), ...version };
    case 'release_next':
    case 'release_claim':
    case 'release_report': {
      if (!release) return failure('release_not_configured', 'this instance does not release');
      const result =
        request.op === 'release_next'
          ? release.next()
          : request.op === 'release_claim'
            ? release.claim(request.releaseId, request.previousCommit)
            : await release.report(request.releaseId, request.report);
      return { ok: true, pause: pause.status(), release: result, ...version };
    }
  }
}

/** The protocol on one connection: a request per line in, a response per line out, in order. */
export function serveControlConnection(
  connection: net.Socket,
  pause: ControlPause,
  log: ControlLog,
  release?: ControlRelease,
): void {
  connection.on('error', () => connection.destroy());
  connection.setTimeout(IDLE_MS, () => connection.destroy());
  connection.setEncoding('utf8');
  let buffer = '';
  let chain: Promise<void> = Promise.resolve();
  const answer = (line: string) => {
    chain = chain.then(async () => {
      let response: ControlResponse;
      try {
        response = await respond(pause, release, line);
      } catch (err) {
        const code =
          typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : 'internal_error';
        if (code === 'internal_error') log.error({ err }, 'a control request failed');
        response = failure(code, err instanceof Error ? err.message : String(err));
      }
      if (!connection.destroyed) connection.write(`${JSON.stringify(response)}\n`);
    });
  };
  connection.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) answer(line);
      newline = buffer.indexOf('\n');
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      connection.end(`${JSON.stringify(failure('invalid_request', 'the request line is too long'))}\n`);
      buffer = '';
    }
  });
}

/**
 * The deploy script's way to pause the whole instance (PM-219): a local socket in the home, mode 0600,
 * JSON lines (`ControlRequest` in, `ControlResponse` out). It has no login: whoever may open the file
 * is the owner of the machine, and the requests it makes are the instance's, with no person behind them.
 *
 * A file nobody answers on is a leftover and is replaced. When somebody does answer (a second server
 * over the same home), or the path is too long for a socket, nothing opens and the reason is logged.
 */
export async function startControlSocket(options: {
  path: string;
  pause: ControlPause;
  log: ControlLog;
  /** The release watcher's operations (PM-491); absent: the socket only pauses. */
  release?: ControlRelease;
}): Promise<ControlSocket> {
  const { path, pause, log, release } = options;
  const none: ControlSocket = { close: async () => undefined };
  if (Buffer.byteLength(path) > maxSocketPathBytes()) {
    log.error({ path }, 'the control socket path is too long for a socket; it is not opened');
    return none;
  }
  if (existsSync(path)) {
    if (await answers(path)) {
      log.error({ path }, 'another server answers on the control socket; it is not opened');
      return none;
    }
    unlinkSync(path);
  }

  const connections = new Set<net.Socket>();
  const server = net.createServer((connection) => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    serveControlConnection(connection, pause, log, release);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(path, 0o600);
  } catch (err) {
    log.error({ err, path }, 'the control socket could not be opened');
    server.close();
    return none;
  }
  server.on('error', (err) => log.error({ err }, 'the control socket failed'));
  log.info({ path }, 'the control socket is open');

  return {
    close: async () => {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
}
