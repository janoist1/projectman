import type { FastifyBaseLogger } from 'fastify';
import { linkUrl, readLinkHeaders, readSecretFile } from './engine-config';
import type { ResolvedEngineConfig } from './engine-config';
import type { EngineStatusWriter } from './engine-status';
import type { createEngineEventBuffer } from './event-buffer';
import type { EngineMethod, MethodParams, MethodResult } from './methods';
import {
  decodeFrame,
  encodeFrame,
  ENGINE_DEAD_AFTER_MS,
  ENGINE_HEARTBEAT_MS,
  ENGINE_PROTOCOL_VERSION,
  ENGINE_RELAY_WAIT_MS,
} from './protocol';
import type { EngineEvent, Hello } from './protocol';
import { createEngineRpc, EngineRpcError } from './rpc';
import type { CallOptions, EngineRpc } from './rpc';

/** The cloud's close codes (`protocol.ts`) that mean the engine must not come back on its own. */
const CLOSE_REVOKED = 4403;
const CLOSE_REPLACED = 4410;
export const ENGINE_BACKOFF_MIN_MS = 1000;
export const ENGINE_BACKOFF_MAX_MS = 30_000;

type EventBuffer = ReturnType<typeof createEngineEventBuffer>;

/** The slice of the global `WebSocket` the client uses; tests pass their own. */
export interface LinkSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
}
export type LinkSocketFactory = (url: string, headers: Record<string, string>) => LinkSocket;

export interface EngineClientOptions {
  config: ResolvedEngineConfig;
  /** The facts the cloud learns at every connection; the client adds the protocol and `nextSeq`. */
  hello: () => Promise<Omit<Hello, 't' | 'protocol' | 'nextSeq'>>;
  /** Registers the engine's handlers on the connection's own RPC (a fresh one per connection). */
  register: (rpc: EngineRpc) => void;
  /** Called for a request refused before any handler (unknown method, invalid parameters). */
  onRefused: (request: { id: string; method: string; code: 'unknown_method' | 'invalid_params' }) => void;
  buffer: EventBuffer;
  status: EngineStatusWriter;
  logger: FastifyBaseLogger;
  createSocket?: LinkSocketFactory;
  /** Backoff jitter in [0, 1); tests fix it. */
  random?: () => number;
  now?: () => number;
}

export interface EngineClient {
  start(): void;
  /** Calls the cloud, waiting for the link to come back for `ENGINE_RELAY_WAIT_MS` at most (`link_down` after). */
  call<M extends EngineMethod>(
    method: M,
    params: MethodParams<M>,
    options?: CallOptions,
  ): Promise<MethodResult<M>>;
  emit(event: EngineEvent): void;
  /** Terminal output of an attached session: lost, not buffered, while the link is down. */
  terminal(sessionId: string, data: string): void;
  connected(): boolean;
  /** Resolves when the pending events are acknowledged, or after `ms`. */
  flush(ms: number): Promise<void>;
  /** Sends nothing more, closes the link ("going away", 1000 with reason `engine_shutdown` on Node's WebSocket) and does not reconnect. */
  close(): Promise<void>;
}

const OPEN = 1;

/**
 * Node's global `WebSocket` only sends 1000 and 3000–4999 (the browser rule); 1001 and the protocol
 * errors are refused with an exception. The reason text carries what the code would have said.
 */
function closeSocket(ws: LinkSocket, code: number, reason: string): void {
  const allowed = code === 1000 || (code >= 3000 && code <= 4999);
  try {
    ws.close(allowed ? code : 1000, reason);
  } catch {
    // already closing
  }
}

export function createEngineClient(options: EngineClientOptions): EngineClient {
  const { config, buffer, status, logger } = options;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const createSocket: LinkSocketFactory =
    options.createSocket ??
    // Node's WebSocket (undici) takes `headers` in its options, which the type declarations leave out.
    ((url, headers) =>
      new (
        WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => LinkSocket
      )(url, { headers }));
  const url = linkUrl(config.cloudUrl, '/engine/link');

  let socket: LinkSocket | null = null;
  let rpc: EngineRpc | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let failures = 0;
  let attempts = 0;
  let lastFrameAt = now();
  let watchdog: NodeJS.Timeout | null = null;
  const waiters = new Set<() => void>();
  const flushers = new Set<() => void>();

  const fail = (code: string, message: string) =>
    status.set({ lastError: { at: new Date(now()).toISOString(), code, message } });
  const publish = () => status.set({ pendingEvents: buffer.pending(), droppedEvents: buffer.dropped() });
  const settleFlushers = () => {
    if (buffer.pending() === 0) for (const done of [...flushers]) done();
  };

  const schedule = () => {
    if (stopped) return;
    const base = Math.min(ENGINE_BACKOFF_MAX_MS, ENGINE_BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));
    // Half to full of the base: a restart of the cloud does not bring every engine back at once.
    const delay = Math.round(base * (0.5 + random() * 0.5));
    timer = setTimeout(connect, delay);
    timer.unref?.();
  };

  const headers = (): Record<string, string> => ({
    ...(config.linkHeadersFile ? readLinkHeaders(config.linkHeadersFile) : {}),
    authorization: `Bearer ${readSecretFile(config.keyFile, 'The engine key')}`,
  });

  const connect = () => {
    timer = null;
    if (stopped) return;
    attempts += 1;
    status.set({ connection: 'connecting', attempts });
    let ws: LinkSocket;
    try {
      ws = createSocket(url, headers());
    } catch (error) {
      // A key or headers file that is missing or has the wrong mode: the owner has to fix it.
      failures += 1;
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'connect_failed';
      fail(code, error instanceof Error ? error.message : 'The link could not be opened');
      logger.warn({ code }, 'engine link: cannot open the connection');
      schedule();
      return;
    }
    socket = ws;
    let welcomed = false;
    let connection: EngineRpc | null = null;
    const send = (data: string) => {
      if (ws.readyState === OPEN) ws.send(data);
    };
    const drop = (code: number, reason: string) => closeSocket(ws, code, reason);

    ws.addEventListener('open', () => {
      void options
        .hello()
        .then((facts) => {
          if (stopped || socket !== ws) return;
          send(
            encodeFrame({
              t: 'hello',
              protocol: ENGINE_PROTOCOL_VERSION,
              ...facts,
              nextSeq: buffer.nextSeq(),
            }),
          );
        })
        .catch(() => drop(1011, 'hello_failed'));
    });

    ws.addEventListener('message', (event) => {
      lastFrameAt = now();
      let frame;
      try {
        if (typeof event.data !== 'string') throw new Error('binary frame');
        frame = decodeFrame(event.data);
      } catch {
        drop(1002, 'bad_frame');
        return;
      }
      if (!welcomed) {
        if (frame.t === 'refuse') {
          fail(frame.code, frame.message);
          logger.warn({ code: frame.code }, 'engine link: the cloud refused the connection');
          return;
        }
        if (frame.t !== 'welcome') {
          drop(1002, 'unexpected_frame');
          return;
        }
        connection = createEngineRpc({ side: 'engine', send, onRefused: options.onRefused });
        options.register(connection);
        try {
          // Replay everything the cloud has not acknowledged, in order.
          buffer.connect(send, frame.ackedSeq);
        } catch {
          connection.close();
          fail('ack_invalid', 'The cloud acknowledged events this engine never sent');
          drop(1002, 'ack_invalid');
          return;
        }
        welcomed = true;
        rpc = connection;
        failures = 0;
        status.set({
          connection: 'connected',
          connectedSince: new Date(now()).toISOString(),
        });
        publish();
        for (const wake of [...waiters]) wake();
        settleFlushers();
        return;
      }
      if (frame.t === 'ack') {
        try {
          buffer.acknowledge(frame.seq);
        } catch {
          // An acknowledgement of events this engine has not sent, or one that goes back: ignored.
        }
        publish();
        settleFlushers();
        return;
      }
      connection!.receive(frame).catch((error: unknown) => {
        logger.warn({ code: error instanceof Error ? error.name : 'error' }, 'engine link: frame rejected');
      });
    });

    ws.addEventListener('error', () => {
      // The reason is in the close event; an error message can carry the URL.
      fail('connection_error', 'The connection to the cloud failed');
    });

    ws.addEventListener('close', (event) => {
      if (socket === ws) socket = null;
      if (rpc === connection) rpc = null;
      connection?.close();
      buffer.disconnect();
      if (stopped) return;
      if (event.code === CLOSE_REVOKED || event.code === CLOSE_REPLACED) {
        // The cloud will not take this engine again: reconnecting would only fight it.
        stopped = true;
        status.set({ connection: 'stopped' });
        fail(
          event.code === CLOSE_REVOKED ? 'engine_revoked' : 'engine_replaced',
          event.code === CLOSE_REVOKED
            ? 'The cloud revoked this engine; create a new one and run init again'
            : 'Another process connected with this engine key; this one stopped',
        );
        logger.error({ code: event.code }, 'engine link: closed by the cloud for good');
        for (const wake of [...waiters]) wake();
        return;
      }
      failures += 1;
      status.set({ connection: 'disconnected' });
      if (!welcomed) fail('connect_failed', 'The cloud did not accept the connection');
      publish();
      schedule();
    });
  };

  return {
    start() {
      if (watchdog) return;
      // The global WebSocket shows no ping or pong, so a link that went silent is noticed by the events
      // it never acknowledges: if some are waiting and nothing came for `ENGINE_DEAD_AFTER_MS`, reconnect.
      watchdog = setInterval(() => {
        if (socket && rpc && buffer.pending() > 0 && now() - lastFrameAt > ENGINE_DEAD_AFTER_MS) {
          fail('link_silent', 'The cloud did not answer; reconnecting');
          closeSocket(socket, 4000, 'silent');
        }
      }, ENGINE_HEARTBEAT_MS);
      watchdog.unref();
      connect();
    },
    async call(method, params, callOptions) {
      if (!rpc) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(wait);
            waiters.delete(finish);
            resolve();
          };
          const wait = setTimeout(finish, callOptions?.timeoutMs ?? ENGINE_RELAY_WAIT_MS);
          wait.unref();
          waiters.add(finish);
        });
      }
      if (!rpc) throw new EngineRpcError('link_down', 'The engine is not connected to the cloud');
      return rpc.call(method, params, callOptions);
    },
    emit(event) {
      buffer.emit(event);
      publish();
    },
    terminal(sessionId, data) {
      if (rpc) buffer.terminal(sessionId, data);
    },
    connected: () => rpc !== null,
    flush(ms) {
      if (buffer.pending() === 0 || !rpc) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(wait);
          flushers.delete(finish);
          resolve();
        };
        const wait = setTimeout(finish, ms);
        wait.unref();
        flushers.add(finish);
      });
    },
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
      timer = null;
      watchdog = null;
      status.set({ connection: 'stopped' });
      for (const wake of [...waiters]) wake();
      for (const done of [...flushers]) done();
      const closing = socket;
      socket = null;
      rpc?.close();
      rpc = null;
      buffer.disconnect();
      if (closing) closeSocket(closing, 1001, 'engine_shutdown');
    },
  };
}
