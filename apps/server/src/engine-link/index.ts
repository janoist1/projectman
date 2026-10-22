import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { EngineId } from '@projectman/shared';
import { routes } from '@projectman/shared';
import { clientAddress, createAttemptLimiter, isLocalRequest, requestProtocol } from '../kernel';
import { DomainError } from '../kernel';
import { createEngineRpc, createRpcState } from './rpc';
import type { EngineRpc, RpcState } from './rpc';
import {
  decodeFrame,
  encodeFrame,
  ENGINE_DEAD_AFTER_MS,
  ENGINE_DEAD_AFTER_PINGS,
  ENGINE_HEARTBEAT_MS,
  ENGINE_OFFLINE_AFTER_MS,
  ENGINE_PROTOCOL_VERSION,
} from './protocol';
import type { Hello } from './protocol';

export * from './protocol';
export * from './methods';
export * from './rpc';
export { createEngineEventBuffer } from './event-buffer';
export { createCloudRemote } from './remote';
export { createAppTagReader, resolveAppVersion } from './version';
export { createEngineAudit } from './engine-audit';
export { createEngineClient } from './engine-client';
export type { LinkSocketFactory } from './engine-client';
export {
  EngineConfigError,
  engineFiles,
  loadEngineConfig,
  readLinkHeaders,
  readSecretFile,
  resolveEngineConfig,
} from './engine-config';
export { createEngineHandlers } from './engine-handlers';
export { createEngineLimit } from './engine-limit';
export { createEngineStatusWriter } from './engine-status';
export { createEngineTransfers } from './engine-transfer';

export interface EngineLink extends Omit<EngineRpc, 'receive' | 'close'> {
  readonly resumed: boolean;
  hello(): Hello;
  close(code?: number): void;
}
export interface EngineLinks {
  get(engineId: EngineId): EngineLink | null;
  onChange(listener: (engineId: EngineId, online: boolean) => void): () => void;
  register(app: FastifyInstance): void;
  /**
   * The engine a request's machine key belongs to (the file endpoints, PM-315); refuses with the same
   * attempt limit and HTTPS rule as the link. Throws a 401 `DomainError`.
   */
  authenticate(request: FastifyRequest): EngineId;
  close(): void;
}

/** Why the cloud ended an engine link; logged with the close code. */
type LinkStopCause = 'heartbeat' | 'closed' | 'socket_error' | 'invalid_frame' | 'hello_timeout' | 'refused';

/** What the link needs from the engine registry; the assembly passes `EngineRegistry`. */
interface EngineLinkRegistry {
  resolve(key: string): EngineId | null;
  onRevoke(listener: (id: EngineId) => void): () => void;
  seen(id: EngineId, ip: string, hello?: Hello): void;
  setOnline(id: EngineId, online: boolean): void;
}

/** Authenticated outgoing engine sockets. Human cookies and integrator tokens grant no access. */
export function createEngineLinks(options: {
  registry: EngineLinkRegistry;
  clientIpHeader?: string;
  now?: () => number;
  logger?: FastifyBaseLogger;
}): EngineLinks {
  const { registry } = options;
  const now = options.now ?? Date.now;
  const active = new Map<EngineId, EngineLink>();
  const states = new Map<EngineId, RpcState>();
  const boots = new Map<EngineId, string>();
  const offlineTimers = new Map<EngineId, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(id: EngineId, online: boolean) => void>();
  const pendingSockets = new Map<EngineId, Set<() => void>>();
  const notify = (id: EngineId, online: boolean) => {
    for (const listener of listeners) listener(id, online);
  };
  const attempts = createAttemptLimiter({
    max: 10,
    windowMs: 60_000,
    message: 'Too many invalid engine keys',
    now,
  });
  const authenticate = (request: FastifyRequest): EngineId => {
    if (!(isLocalRequest(request) || requestProtocol(request) === 'https'))
      throw new DomainError('unauthorized', 'Engine connections require HTTPS', { status: 401 });
    const ip = clientAddress(request, options.clientIpHeader);
    const release = attempts.reserve(ip);
    const key = request.headers.authorization?.match(/^Bearer (pme_[A-Za-z0-9_-]{43})$/)?.[1];
    const id = key ? registry.resolve(key) : null;
    if (!id) throw new DomainError('unauthorized', 'Invalid engine key', { status: 401 });
    release();
    return id;
  };
  const revoke = registry.onRevoke((id) => {
    for (const close of pendingSockets.get(id) ?? []) close();
    const link = active.get(id);
    link?.close(4403);
    clearTimeout(offlineTimers.get(id));
    offlineTimers.delete(id);
    states.delete(id);
    boots.delete(id);
  });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const pulses = new Set<() => void>();
  const directory: EngineLinks = {
    authenticate,
    get(id) {
      return active.get(id) ?? null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(app) {
      const authenticatedIds = new WeakMap<FastifyRequest, EngineId>();
      app.get(
        routes.engineLink(),
        {
          websocket: true,
          preValidation: async (request) => {
            authenticatedIds.set(request, authenticate(request));
          },
        },
        (socket, request) => {
          const id = authenticatedIds.get(request)!;
          const ip = clientAddress(request, options.clientIpHeader);
          let link: EngineLink | undefined;
          let rpc: EngineRpc | undefined;
          let ended = false;
          // Any decoded frame or pong shows the engine lives; `unanswered` counts the pings sent since.
          let lastHeard = now();
          let unanswered = 0;
          let connectedAt = 0;
          const refuse = (
            code: 'engine_revoked' | 'engine_replaced' | 'protocol_mismatch',
            closeCode: number,
          ) => {
            if (socket.readyState === 1) socket.send(encodeFrame({ t: 'refuse', code, message: code }));
            stop(closeCode, 'refused');
          };
          const stop = (code = 1000, cause: LinkStopCause = 'closed') => {
            if (ended) return;
            ended = true;
            clearTimeout(helloTimer);
            pulses.delete(pulse);
            if (link) {
              options.logger?.info(
                {
                  engineId: id,
                  code,
                  cause,
                  sinceHeardMs: now() - lastHeard,
                  connectedForMs: now() - connectedAt,
                },
                'engine link: disconnected',
              );
            }
            pendingSockets.get(id)?.delete(pendingRevoke);
            rpc?.close();
            if (link && active.get(id) === link) {
              active.delete(id);
              notify(id, false);
              if (code === 4403) registry.setOnline(id, false);
              else {
                const timer = setTimeout(() => {
                  offlineTimers.delete(id);
                  registry.setOnline(id, false);
                }, ENGINE_OFFLINE_AFTER_MS);
                timer.unref();
                offlineTimers.set(id, timer);
              }
            }
            if (socket.readyState === 1) socket.close(code);
          };
          const pendingRevoke = () => refuse('engine_revoked', 4403);
          const pending = pendingSockets.get(id) ?? new Set<() => void>();
          pending.add(pendingRevoke);
          pendingSockets.set(id, pending);
          const helloTimer = setTimeout(() => stop(4400, 'hello_timeout'), 10_000);
          helloTimer.unref();
          // The only place that judges a link dead. A stalled event loop sends no pings, so it cannot
          // pile up unanswered ones: the cloud does not drop a live engine because it was itself paused.
          const pulse = () => {
            if (now() - lastHeard >= ENGINE_DEAD_AFTER_MS && unanswered >= ENGINE_DEAD_AFTER_PINGS) {
              stop(4400, 'heartbeat');
              socket.terminate();
              return;
            }
            if (socket.readyState === 1) {
              socket.ping();
              unanswered += 1;
            }
          };
          // Register listeners synchronously: frames can arrive as soon as the upgrade succeeds.
          socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
            if (ended) return;
            let frame;
            try {
              if (binary) throw new Error('Binary engine frame');
              const bytes = Buffer.isBuffer(data)
                ? data
                : data instanceof ArrayBuffer
                  ? Buffer.from(data)
                  : Buffer.concat(data);
              frame = decodeFrame(bytes);
            } catch {
              stop(4400, 'invalid_frame');
              return;
            }
            lastHeard = now();
            unanswered = 0;
            if (!rpc) {
              if (frame.t !== 'hello') {
                stop(4400, 'invalid_frame');
                return;
              }
              if (frame.protocol !== ENGINE_PROTOCOL_VERSION) {
                refuse('protocol_mismatch', 4409);
                return;
              }
              // Recheck revocation after upgrade and before accepting the hello.
              const key = request.headers.authorization!.slice('Bearer '.length);
              if (registry.resolve(key) !== id) {
                refuse('engine_revoked', 4403);
                return;
              }
              clearTimeout(helloTimer);
              pending.delete(pendingRevoke);
              const previous = active.get(id);
              // Replacement notifies offline first, then online after the new welcome (PM-315).
              previous?.close(4410);
              clearTimeout(offlineTimers.get(id));
              offlineTimers.delete(id);
              const previousBoot = boots.get(id);
              const previousState = states.get(id);
              const sameBoot = previousBoot === frame.bootId;
              const resumed = sameBoot && !!previousState && frame.nextSeq <= previousState.ackedSeq + 1;
              // Result idempotency is engine-scoped; only the event stream changes with the boot.
              const state =
                sameBoot && previousState
                  ? previousState
                  : { ...createRpcState(), results: previousState?.results ?? new Map() };
              boots.set(id, frame.bootId);
              states.set(id, state);
              const hello = frame;
              rpc = createEngineRpc({
                side: 'cloud',
                state,
                send: (data) => socket.send(data),
                now,
                onFailed: (failure) => options.logger?.warn(failure, 'engine link: a request failed'),
              });
              link = {
                resumed,
                call: rpc.call,
                handle: rpc.handle,
                onEvent: rpc.onEvent,
                onTerminal: rpc.onTerminal,
                hello: () => hello,
                close: (code = 1000) => {
                  if (code === 4403) refuse('engine_revoked', code);
                  else if (code === 4410) refuse('engine_replaced', code);
                  else stop(code);
                },
              };
              active.set(id, link);
              registry.seen(id, ip, hello);
              registry.setOnline(id, true);
              pulses.add(pulse);
              connectedAt = now();
              socket.send(
                encodeFrame({
                  t: 'welcome',
                  engineId: id,
                  ackedSeq: state.ackedSeq,
                  serverTime: new Date(now()).toISOString(),
                }),
              );
              options.logger?.info(
                { engineId: id, resumed, version: hello.version },
                'engine link: connected',
              );
              // A restarted cloud may have lost its memory of events already acknowledged by the engine.
              // PM-315 reconciles the hello snapshot when resumed is false; replay starts at nextSeq.
              state.ackedSeq = Math.max(state.ackedSeq, hello.nextSeq - 1);
              notify(id, true);
              return;
            }
            void rpc.receive(frame).catch(() => stop(4400, 'invalid_frame'));
          });
          socket.on('pong', () => {
            if (!ended && link && active.get(id) === link) {
              lastHeard = now();
              unanswered = 0;
              registry.seen(id, ip);
            }
          });
          socket.on('error', () => stop(4400, 'socket_error'));
          socket.on('close', () => stop());
        },
      );
      heartbeat = setInterval(() => {
        for (const pulse of pulses) pulse();
      }, ENGINE_HEARTBEAT_MS);
      heartbeat.unref();
      app.addHook('preClose', async () => directory.close());
    },
    close() {
      clearInterval(heartbeat);
      revoke();
      for (const callbacks of pendingSockets.values()) for (const close of callbacks) close();
      for (const link of active.values()) link.close();
      for (const timer of offlineTimers.values()) clearTimeout(timer);
      active.clear();
      states.clear();
      boots.clear();
      offlineTimers.clear();
      pendingSockets.clear();
      pulses.clear();
      listeners.clear();
    },
  };
  return directory;
}
