import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { vi } from 'vitest';
import type { EngineId } from '@projectman/shared';
import { DomainError } from '../../kernel';
import type { EngineLink, EngineLinks } from '../index';
import { decodeFrame } from '../protocol';
import type { EngineEvent, Hello } from '../protocol';
import { createEngineRpc } from '../rpc';
import type { EngineRpc } from '../rpc';
import type { EngineMethod, MethodParams, MethodResult } from '../methods';
import type { HubRegistry } from './hub';

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
  registry: HubRegistry & {
    setOnline(id: EngineId, online: boolean): void;
    setDefault(id: EngineId | null): void;
    add(id: EngineId): void;
    /** Sets the project's engine (null: none) and tells the listeners; without it a project uses the default. */
    bindProject(projectKey: string, id: EngineId | null): void;
    /** Makes the engine one of another owner's (PM-1061): not the host's, and without the host's secrets. */
    setForeign(id: EngineId): void;
    /** Binds the project to one more engine, which stays no base engine. */
    bindAlso(projectKey: string, id: EngineId): void;
  };
  /** Connects an engine; its `hello` is what the cloud mirrors. */
  connect(
    id: EngineId,
    options?: { hello?: Partial<Hello>; resumed?: boolean; prepare?: (engine: FakeEngine) => void },
  ): FakeEngine;
}

/** `x-engine: <id>` stands for the machine key of the file endpoints. */
export function createFakeCloud(): FakeCloud {
  const active = new Map<EngineId, EngineLink>();
  const changeListeners = new Set<(id: EngineId, online: boolean) => void>();
  const onlineListeners = new Set<(id: EngineId, online: boolean) => void>();
  const online = new Set<EngineId>();
  const known: EngineId[] = [];
  let defaultId: EngineId | null = null;
  const foreign = new Set<EngineId>();
  /** Bindings of a project that are not its base engine. */
  const alsoBound = new Map<string, Set<EngineId>>();
  const projectEngines = new Map<string, EngineId | null>();
  const projectListeners = new Set<(projectKey: string) => void>();

  const registry: FakeCloud['registry'] = {
    isOnline: (id) => online.has(id),
    defaultId: () => defaultId,
    hostEngine: () => (defaultId && !foreign.has(defaultId) ? defaultId : null),
    ownedByHost: (id) => !foreign.has(id),
    isBound: (id, projectKey) =>
      registry.projectEngine(projectKey) === id || (alsoBound.get(projectKey)?.has(id) ?? false),
    bindAlso(projectKey, id) {
      alsoBound.set(projectKey, (alsoBound.get(projectKey) ?? new Set()).add(id));
    },
    setForeign: (id) => void foreign.add(id),
    projectEngine: (projectKey) =>
      projectEngines.has(projectKey) ? projectEngines.get(projectKey)! : defaultId,
    onProjectEngineChange(listener) {
      projectListeners.add(listener);
      return () => projectListeners.delete(listener);
    },
    bindProject(projectKey, id) {
      projectEngines.set(projectKey, id);
      for (const listener of [...projectListeners]) listener(projectKey);
    },
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
      const engine: FakeEngine = {
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
      // What the cloud asks as soon as it sees the link (the connect steps) needs an answer before it.
      options.prepare?.(engine);
      for (const listener of [...changeListeners]) listener(id, true);
      return engine;
    },
  };
}
