import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EngineId } from '@projectman/shared';
import { routes } from '@projectman/shared';
import { clientAddress, createAttemptLimiter } from '../auth';
import { DomainError } from '../domain';
import type { EngineRegistry } from '../domain';
import { createEngineRpc, createRpcState } from './rpc';
import type { EngineRpc, RpcState } from './rpc';
import {
  decodeFrame,
  encodeFrame,
  ENGINE_DEAD_AFTER_MS,
  ENGINE_HEARTBEAT_MS,
  ENGINE_OFFLINE_AFTER_MS,
  ENGINE_PROTOCOL_VERSION,
} from './protocol';
import type { Hello } from './protocol';

export * from './protocol';
export * from './methods';
export * from './rpc';
export { createEngineEventBuffer } from './event-buffer';
export { resolveAppVersion } from './version';
export { EngineStartSpec } from './session-schemas';

export interface EngineLink extends Omit<EngineRpc, 'receive' | 'close'> {
  readonly resumed: boolean;
  hello(): Hello;
  close(code?: number): void;
}
export interface EngineLinks {
  get(engineId: EngineId): EngineLink | null;
  onChange(listener: (engineId: EngineId, online: boolean) => void): () => void;
  register(app: FastifyInstance): void;
  close(): void;
}

/** Authenticated outgoing engine sockets. Human cookies and integrator tokens grant no access. */
export function createEngineLinks(options: {
  registry: EngineRegistry;
  clientIpHeader?: string;
  now?: () => number;
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
          let lastPong = now();
          let deadTimer: ReturnType<typeof setTimeout> | undefined;
          const refuse = (
            code: 'engine_revoked' | 'engine_replaced' | 'protocol_mismatch',
            closeCode: number,
          ) => {
            if (socket.readyState === 1) socket.send(encodeFrame({ t: 'refuse', code, message: code }));
            stop(closeCode);
          };
          const stop = (code = 1000) => {
            if (ended) return;
            ended = true;
            clearTimeout(helloTimer);
            clearTimeout(deadTimer);
            pulses.delete(pulse);
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
          const helloTimer = setTimeout(() => stop(4400), 10_000);
          helloTimer.unref();
          const pulse = () => {
            if (now() - lastPong >= ENGINE_DEAD_AFTER_MS) {
              stop(4400);
              socket.terminate();
              return;
            }
            if (socket.readyState === 1) socket.ping();
          };
          const resetDeadTimer = () => {
            clearTimeout(deadTimer);
            deadTimer = setTimeout(() => {
              stop(4400);
              socket.terminate();
            }, ENGINE_DEAD_AFTER_MS);
            deadTimer.unref();
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
              stop(4400);
              return;
            }
            if (!rpc) {
              if (frame.t !== 'hello') {
                stop(4400);
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
              rpc = createEngineRpc({ side: 'cloud', state, send: (data) => socket.send(data), now });
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
              lastPong = now();
              resetDeadTimer();
              socket.send(
                encodeFrame({
                  t: 'welcome',
                  engineId: id,
                  ackedSeq: state.ackedSeq,
                  serverTime: new Date(now()).toISOString(),
                }),
              );
              // A restarted cloud may have lost its memory of events already acknowledged by the engine.
              // PM-315 reconciles the hello snapshot when resumed is false; replay starts at nextSeq.
              state.ackedSeq = Math.max(state.ackedSeq, hello.nextSeq - 1);
              notify(id, true);
              return;
            }
            void rpc.receive(frame).catch(() => stop(4400));
          });
          socket.on('pong', () => {
            if (!ended && link && active.get(id) === link) {
              lastPong = now();
              resetDeadTimer();
              registry.seen(id, ip);
            }
          });
          socket.on('error', () => stop(4400));
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
