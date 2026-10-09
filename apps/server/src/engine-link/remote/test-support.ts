import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { vi } from 'vitest';
import type { EngineId } from '@projectman/shared';
import { DomainError } from '../../domain/errors';
import type { EngineLink, EngineLinks } from '../index';
import { decodeFrame } from '../protocol';
import type { EngineEvent, Hello } from '../protocol';
import { createEngineRpc } from '../rpc';
import type { EngineRpc } from '../rpc';
import type { EngineMethod, MethodParams, MethodResult } from '../methods';

/**
 * A cloud and its engines in one process for the unit tests of the remote parts (PM-315): each fake
 * engine is the engine end of a real in-memory rpc, so parameters and results are validated like on the
 * wire. Nothing here opens a socket.
 */

export const silentLogger = (): FastifyBaseLogger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child() {
      return this;
    },
  }) as unknown as FastifyBaseLogger;

export function helloOf(overrides: Partial<Hello> = {}): Hello {
  return {
    t: 'hello',
    protocol: 1,
    version: 'test',
    hostname: 'fake-engine',
    platform: 'darwin',
    paths: {
      userHome: '/fictional/user',
      home: '/fictional/engine',
      worktreesRoot: '/fictional/engine/worktrees',
      workspacesRoot: null,
      installDir: null,
      sessionFoldersRoot: '/fictional/folders',
      sessionTmpRoot: null,
      claudeTmpRoots: [],
      browsersDir: null,
      heavyLockDir: null,
      gitExcludesFile: null,
    },
    projects: [],
    repos: [],
    providers: [],
    running: [],
    nextSeq: 1,
    instanceTag: '0123456789abcdef',
    pid: 4242,
    uid: 501,
    bootId: 'aaaaaaaaaaaaaaaa',
    ...overrides,
  };
}

export interface FakeEngine {
  readonly id: EngineId;
  /** The engine's end of the link: answer the cloud's calls with `answer`, call the cloud with `call`. */
  call<M extends EngineMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  answer<M extends EngineMethod>(
    method: M,
    handler: (params: MethodParams<M>) => MethodResult<M> | Promise<MethodResult<M>>,
  ): void;
  /** Every request the cloud made, in order. */
  readonly requests: Array<{ method: string; params: unknown }>;
  /** The id of every call the engine made to the cloud, in order (`permission.cancel` names one). */
  readonly callIds: string[];
  emit(event: EngineEvent): Promise<void>;
  terminal(sessionId: string, data: string): Promise<void>;
  disconnect(): void;
}

export interface FakeCloud {
  links: EngineLinks;
  registry: {
    isOnline(id: EngineId): boolean;
    defaultId(): EngineId | null;
    ids(): EngineId[];
    onOnlineChange(listener: (id: EngineId, online: boolean) => void): () => void;
    setOnline(id: EngineId, online: boolean): void;
    setDefault(id: EngineId | null): void;
    add(id: EngineId): void;
  };
  /** Connects an engine; its `hello` is what the cloud mirrors. */
  connect(id: EngineId, options?: { hello?: Partial<Hello>; resumed?: boolean }): FakeEngine;
}

/** `x-engine: <id>` stands for the machine key of the file endpoints. */
export function createFakeCloud(): FakeCloud {
  const active = new Map<EngineId, EngineLink>();
  const changeListeners = new Set<(id: EngineId, online: boolean) => void>();
  const onlineListeners = new Set<(id: EngineId, online: boolean) => void>();
  const online = new Set<EngineId>();
  const known: EngineId[] = [];
  let defaultId: EngineId | null = null;

  const registry: FakeCloud['registry'] = {
    isOnline: (id) => online.has(id),
    defaultId: () => defaultId,
    ids: () => [...known],
    onOnlineChange(listener) {
      onlineListeners.add(listener);
      return () => onlineListeners.delete(listener);
    },
    setOnline(id, value) {
      if (value) online.add(id);
      else online.delete(id);
      for (const listener of [...onlineListeners]) listener(id, value);
    },
    setDefault(id) {
      defaultId = id;
    },
    add(id) {
      if (!known.includes(id)) known.push(id);
      defaultId ??= id;
    },
  };

  const links: EngineLinks = {
    get: (id) => active.get(id) ?? null,
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    register() {},
    authenticate(request: FastifyRequest) {
      const header = request.headers['x-engine'];
      const id = Array.isArray(header) ? header[0] : header;
      if (!id) throw new DomainError('unauthorized', 'no machine key', { status: 401 });
      return id as EngineId;
    },
    close() {},
  };

  return {
    links,
    registry,
    connect(id, options = {}) {
      registry.add(id);
      online.add(id);
      const hello = helloOf(options.hello);
      const requests: FakeEngine['requests'] = [];
      let engineRpc: EngineRpc;
      const cloudRpc: EngineRpc = createEngineRpc({
        side: 'cloud',
        send: (data) => void engineRpc.receive(decodeFrame(data)),
      });
      const callIds: string[] = [];
      engineRpc = createEngineRpc({
        side: 'engine',
        send: (data) => {
          const frame = decodeFrame(data);
          if (frame.t === 'req') callIds.push(frame.id);
          void cloudRpc.receive(frame);
        },
      });
      const link: EngineLink = {
        call: (method, params, callOptions) => cloudRpc.call(method, params, callOptions),
        handle: (method, handler) => cloudRpc.handle(method, handler),
        onEvent: (handler) => cloudRpc.onEvent(handler),
        onTerminal: (handler) => cloudRpc.onTerminal(handler),
        hello: () => hello,
        resumed: options.resumed ?? false,
        close() {},
      };
      let seq = hello.nextSeq;
      active.set(id, link);
      for (const listener of [...changeListeners]) listener(id, true);
      return {
        id,
        requests,
        callIds,
        call: (method, params) => engineRpc.call(method, params),
        answer(method, handler) {
          engineRpc.handle(method, ((params: never) => {
            requests.push({ method, params });
            return handler(params);
          }) as never);
        },
        async emit(event) {
          await cloudRpc.receive({ t: 'evt', seq: seq++, event });
        },
        async terminal(sessionId, data) {
          await cloudRpc.receive({ t: 'term', sessionId, data });
        },
        disconnect() {
          if (active.get(id) !== link) return;
          active.delete(id);
          cloudRpc.close();
          engineRpc.close();
          for (const listener of [...changeListeners]) listener(id, false);
        },
      };
    },
  };
}
