import { randomBytes } from 'node:crypto';
import type {
  EngineFrame,
  EngineEvent,
  EngineErrorCode,
  EngineWireError as WireError,
  ResponseFrame,
} from './protocol';
import {
  EngineErrorCode as ErrorCodeSchema,
  EngineWireError,
  encodeFrame,
  ENGINE_RELAY_WAIT_MS,
} from './protocol';
import { methodOf } from './methods';
import type { EngineMethod, MethodParams, MethodResult } from './methods';

export class EngineCallError extends Error {
  readonly code: string;
  readonly linkCode: EngineErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(error: WireError) {
    super(error.message);
    this.code = error.module?.code ?? error.code;
    this.linkCode = error.code;
    this.details = error.module?.details;
  }
}
export class EngineRpcError extends EngineCallError {
  constructor(code: EngineErrorCode, message: string) {
    super({ code, message });
  }
}
/** What a handler learns about the request besides its parameters. */
export interface HandlerContext {
  /** The request frame's id (the engine's audit log names a request by it). */
  id: string;
}
type Handler = (params: unknown, context: HandlerContext) => unknown | Promise<unknown>;
type Cached = { expiresAt: number; response: Promise<ResponseFrame> };
/** One state per authenticated engine; retained across replacement/reconnection. Never persisted. */
export interface RpcState {
  ackedSeq: number;
  results: Map<string, Cached>;
  eventQueue: Promise<void>;
}
export const createRpcState = (): RpcState => ({
  ackedSeq: 0,
  results: new Map(),
  eventQueue: Promise.resolve(),
});

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Gets the request's id before it is sent: `permission.cancel` names the `permission.decide` it ends by it. */
  onRequestId?: (id: string) => void;
}
export interface EngineRpc {
  call<M extends EngineMethod>(
    method: M,
    params: MethodParams<M>,
    options?: CallOptions,
  ): Promise<MethodResult<M>>;
  handle<M extends EngineMethod>(
    method: M,
    handler: (params: MethodParams<M>, context: HandlerContext) => MethodResult<M> | Promise<MethodResult<M>>,
  ): () => void;
  onEvent(handler: (event: EngineEvent) => void | Promise<void>): () => void;
  onTerminal(handler: (sessionId: string, data: string) => void): () => void;
  receive(frame: EngineFrame): Promise<void>;
  close(): void;
}

/** No request/response logging: MCP tokens, prompts and NanoGPT secrets must never reach logs. */
export function createEngineRpc(options: {
  side: 'cloud' | 'engine';
  send: (data: string) => void;
  state?: RpcState;
  now?: () => number;
  /** Called for a request answered before any handler ran: an unknown method or invalid parameters. */
  onRefused?: (request: { id: string; method: string; code: 'unknown_method' | 'invalid_params' }) => void;
}): EngineRpc {
  const state = options.state ?? createRpcState();
  const now = options.now ?? Date.now;
  const handlers = new Map<string, Handler>();
  const events = new Set<(event: EngineEvent) => void | Promise<void>>();
  const terminals = new Set<(sessionId: string, data: string) => void>();
  const pending = new Map<string, { finish: (frame?: ResponseFrame, error?: Error) => void }>();
  let closed = false;
  const send = (frame: EngineFrame) => {
    if (!closed) options.send(encodeFrame(frame));
  };
  const request = async (frame: Extract<EngineFrame, { t: 'req' }>): Promise<void> => {
    const schema = methodOf(frame.method);
    const failure = (code: EngineErrorCode, message: string): ResponseFrame => ({
      t: 'res',
      id: frame.id,
      ok: false,
      error: { code, message },
    });
    if (!schema || schema.direction !== options.side) {
      options.onRefused?.({ id: frame.id, method: frame.method, code: 'unknown_method' });
      send(failure('unknown_method', 'Unknown method'));
      return;
    }
    const params = schema.params.safeParse(frame.params);
    if (!params.success) {
      options.onRefused?.({ id: frame.id, method: frame.method, code: 'invalid_params' });
      send(failure('invalid_params', 'Invalid method parameters'));
      return;
    }
    const secret = frame.method === 'secret.nanogpt_key';
    // Only the cloud caches incoming engine requests. In-flight duplicates share the same promise.
    const cache = options.side === 'cloud' && !secret;
    if (cache) {
      for (const [id, item] of state.results) if (item.expiresAt <= now()) state.results.delete(id);
      const previous = state.results.get(frame.id);
      if (previous) {
        send(await previous.response);
        return;
      }
      if (state.results.size >= 10_000) {
        send(failure('internal', 'Request capacity exceeded'));
        return;
      }
    }
    const execute = async (): Promise<ResponseFrame> => {
      const handler = handlers.get(frame.method);
      if (!handler) return failure(secret ? 'secret_not_allowed' : 'unknown_method', 'Method unavailable');
      try {
        const value = await handler(params.data, { id: frame.id });
        const result = schema.result.safeParse(value);
        if (!result.success) return failure('internal', 'Invalid method result');
        return { t: 'res', id: frame.id, ok: true, result: result.data };
      } catch (error) {
        // Unrecognised exceptions are never reflected, since they can contain credentials or paths.
        if (error instanceof EngineCallError) {
          return {
            t: 'res',
            id: frame.id,
            ok: false,
            error: EngineWireError.parse({
              code: error.linkCode,
              message: error.message.slice(0, 2000),
              ...(error.linkCode === 'module_error'
                ? { module: { code: error.code, details: error.details } }
                : {}),
            }),
          };
        }
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
        if (error instanceof Error && typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)) {
          const linkCode = ErrorCodeSchema.safeParse(code);
          if (linkCode.success && linkCode.data !== 'module_error')
            return failure(linkCode.data, error.message.slice(0, 2000));
          const details =
            'details' in error &&
            typeof error.details === 'object' &&
            error.details !== null &&
            !Array.isArray(error.details)
              ? error.details
              : undefined;
          const wire = EngineWireError.safeParse({
            code: 'module_error',
            message: error.message.slice(0, 2000),
            module: { code, details },
          });
          if (wire.success) return { t: 'res', id: frame.id, ok: false, error: wire.data };
        }
        return failure('internal', 'Engine request failed');
      }
    };
    const response = execute().then((response) => {
      try {
        encodeFrame(response);
        return response;
      } catch {
        return failure('result_too_large', 'Engine result exceeds the frame limit');
      }
    });
    if (cache) {
      const item: Cached = { expiresAt: Infinity, response };
      state.results.set(frame.id, item);
      void response.then(() => {
        item.expiresAt = now() + 5 * 60_000;
      });
    }
    send(await response);
  };
  return {
    call(method, params, callOptions = {}) {
      const schema = methodOf(method)!;
      if (closed) return Promise.reject(new EngineRpcError('link_down', 'Engine link is down'));
      if (schema.direction === options.side)
        return Promise.reject(new EngineRpcError('unknown_method', 'Wrong method direction'));
      const parsed = schema.params.safeParse(params);
      if (!parsed.success)
        return Promise.reject(new EngineRpcError('invalid_params', 'Invalid method parameters'));
      if (callOptions.signal?.aborted)
        return Promise.reject(new EngineRpcError('timeout', 'Engine call aborted'));
      const id = randomBytes(16).toString('hex');
      callOptions.onRequestId?.(id);
      return new Promise((resolve, reject) => {
        const abort = () => finish(undefined, new EngineRpcError('timeout', 'Engine call aborted'));
        const timer = setTimeout(
          () => finish(undefined, new EngineRpcError('timeout', 'Engine call timed out')),
          callOptions.timeoutMs ?? ENGINE_RELAY_WAIT_MS,
        );
        timer.unref();
        const finish = (frame?: ResponseFrame, error?: Error) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          callOptions.signal?.removeEventListener('abort', abort);
          if (error) {
            reject(error);
            return;
          }
          if (!frame?.ok) {
            reject(
              frame ? new EngineCallError(frame.error) : new EngineRpcError('internal', 'Engine call failed'),
            );
            return;
          }
          const result = schema.result.safeParse(frame.result);
          if (!result.success) reject(new EngineRpcError('internal', 'Invalid method result'));
          else resolve(result.data as MethodResult<typeof method>);
        };
        pending.set(id, { finish });
        callOptions.signal?.addEventListener('abort', abort, { once: true });
        try {
          send({ t: 'req', id, method, params: parsed.data });
        } catch {
          finish(undefined, new EngineRpcError('link_down', 'Engine link is down'));
        }
      });
    },
    handle(method, handler) {
      if (methodOf(method)?.direction !== options.side)
        throw new EngineRpcError('unknown_method', 'Wrong method direction');
      const wrapped: Handler = (params, context) => handler(params as MethodParams<typeof method>, context);
      handlers.set(method, wrapped);
      return () => {
        if (handlers.get(method) === wrapped) handlers.delete(method);
      };
    },
    onEvent(handler) {
      events.add(handler);
      return () => {
        events.delete(handler);
      };
    },
    onTerminal(handler) {
      terminals.add(handler);
      return () => {
        terminals.delete(handler);
      };
    },
    async receive(frame) {
      if (closed) return;
      if (frame.t === 'req') return request(frame);
      if (frame.t === 'res') {
        pending.get(frame.id)?.finish(frame);
        return;
      }
      if (frame.t === 'term' && options.side === 'cloud') {
        for (const handler of terminals) handler(frame.sessionId, frame.data);
        return;
      }
      if (frame.t === 'evt' && options.side === 'cloud') {
        const work = state.eventQueue.then(async () => {
          if (closed) return;
          if (frame.seq <= state.ackedSeq) {
            send({ t: 'ack', seq: state.ackedSeq });
            return;
          }
          if (frame.seq !== state.ackedSeq + 1)
            throw new EngineRpcError('invalid_params', 'Event sequence gap');
          if (!events.size) throw new EngineRpcError('unknown_method', 'No event handler');
          for (const handler of events) await handler(frame.event);
          // Commit successful handling even if this socket was replaced while awaiting the handler.
          state.ackedSeq = Math.max(state.ackedSeq, frame.seq);
          send({ t: 'ack', seq: state.ackedSeq });
        });
        state.eventQueue = work.catch(() => undefined);
        return work;
      }
      if (frame.t === 'ack' && options.side === 'engine') return;
      throw new EngineRpcError('invalid_params', 'Unexpected engine frame');
    },
    close() {
      if (closed) return;
      closed = true;
      for (const { finish } of [...pending.values()])
        finish(undefined, new EngineRpcError('link_down', 'Engine link is down'));
      handlers.clear();
      events.clear();
      terminals.clear();
    },
  };
}
