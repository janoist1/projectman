import type { FastifyBaseLogger } from 'fastify';
import type { EngineId } from '@projectman/shared';
import type { RunningSessionInfo } from '../../contracts';
import type { EngineLink, EngineLinks } from '../index';
import { ENGINE_RELAY_WAIT_MS } from '../protocol';
import type { EngineEvent, Hello } from '../protocol';
import { EngineRpcError } from '../rpc';
import type { CallOptions, HandlerContext } from '../rpc';
import type { EngineMethod, MethodParams, MethodResult } from '../methods';

/**
 * What the cloud knows about one engine's sessions and folders without asking (PM-315). The sync
 * parts of the runner and of the engine host (`isRunning`, `list`, `hasPendingInput`,
 * `processExists`, `sessionFolders.of`) answer from it. It is built from the engine's `hello` at every
 * connect and kept up to date by the runner events and by what the cloud itself asks the engine to do.
 */
export interface EngineMirror {
  /** A link is up now. */
  connected: boolean;
  /** A `hello` of this engine arrived since this process started: before it, the mirror knows nothing. */
  seen: boolean;
  hello: Hello | null;
  running: Map<string, RunningSessionInfo>;
  /** Sessions with a message on its way into the CLI (`pending_input` events). */
  pendingInput: Set<string>;
  /** The session folders the engine made, by session id (`folders.make` / `folders.remove`). */
  folders: Map<string, string>;
}

export interface ConnectContext {
  id: EngineId;
  link: EngineLink;
  hello: Hello;
  resumed: boolean;
}

type CloudHandler = (engineId: EngineId, params: never, context: HandlerContext) => unknown;

export interface RemoteHub {
  mirror(id: EngineId): EngineMirror;
  /** The live link, or null. */
  link(id: EngineId): EngineLink | null;
  /** Connected, or gone for less than `ENGINE_OFFLINE_AFTER_MS`. */
  available(id: EngineId): boolean;
  defaultId(): EngineId | null;
  ids(): EngineId[];
  /**
   * Calls the engine. A link that is down is waited for up to `ENGINE_RELAY_WAIT_MS` while the engine
   * counts as available; a request that was sent when the link dropped fails with `link_down` (the
   * engine may have done it) and is not repeated.
   */
  call<M extends EngineMethod>(
    id: EngineId,
    method: M,
    params: MethodParams<M>,
    options?: CallOptions,
  ): Promise<MethodResult<M>>;
  /** A method the engine calls on the cloud; registered on every link when it connects. */
  handle<M extends EngineMethod>(
    method: M,
    handler: (
      engineId: EngineId,
      params: MethodParams<M>,
      context: HandlerContext,
    ) => MethodResult<M> | Promise<MethodResult<M>>,
  ): void;
  /** Runs, in order, after the mirror is built and before the engine counts as connected for the domain. */
  onConnect(hook: (context: ConnectContext) => void | Promise<void>): void;
  onEvent(listener: (engineId: EngineId, event: EngineEvent) => void | Promise<void>): void;
  onTerminal(listener: (engineId: EngineId, sessionId: string, data: string) => void): void;
  /**
   * `online: true` once the connect hooks (reconciliation) are done; `false` when the engine stops
   * counting as available (`ENGINE_OFFLINE_AFTER_MS` after the link dropped, or revoked).
   */
  onChange(listener: (id: EngineId, online: boolean) => void): () => void;
  /** The server is stopping: a call that waits for a missing link fails at once instead of after a minute. */
  stopWaiting(): void;
  close(): void;
}

export interface RemoteHubOptions {
  links: EngineLinks;
  registry: {
    isOnline(id: EngineId): boolean;
    defaultId(): EngineId | null;
    ids(): EngineId[];
    onOnlineChange(listener: (id: EngineId, online: boolean) => void): () => void;
  };
  logger: FastifyBaseLogger;
}

export function createRemoteHub(options: RemoteHubOptions): RemoteHub {
  const { links, registry, logger } = options;
  const mirrors = new Map<EngineId, EngineMirror>();
  const handlers = new Map<string, CloudHandler>();
  const connectHooks: Array<(context: ConnectContext) => void | Promise<void>> = [];
  const eventListeners: Array<(id: EngineId, event: EngineEvent) => void | Promise<void>> = [];
  const terminalListeners: Array<(id: EngineId, sessionId: string, data: string) => void> = [];
  const changeListeners = new Set<(id: EngineId, online: boolean) => void>();

  const mirror = (id: EngineId): EngineMirror => {
    let found = mirrors.get(id);
    if (!found) {
      found = {
        connected: false,
        seen: false,
        hello: null,
        running: new Map(),
        pendingInput: new Set(),
        folders: new Map(),
      };
      mirrors.set(id, found);
    }
    return found;
  };
  const notify = (id: EngineId, online: boolean) => {
    for (const listener of [...changeListeners]) {
      try {
        listener(id, online);
      } catch (err) {
        logger.warn({ err, engineId: id }, 'an engine change listener failed');
      }
    }
  };
  /** The mirror follows what the engine reports, before any listener reads it. */
  const follow = (id: EngineId, event: EngineEvent) => {
    const m = mirror(id);
    if (event.kind === 'pending_input') {
      if (event.pending) m.pendingInput.add(event.sessionId);
      else m.pendingInput.delete(event.sessionId);
      return;
    }
    if (event.kind !== 'runner') return;
    const runner = event.event;
    if (runner.type === 'state') {
      const known = m.running.get(runner.sessionId);
      if (known) m.running.set(runner.sessionId, { ...known, state: runner.state });
    } else if (runner.type === 'exit') {
      m.running.delete(runner.sessionId);
      m.pendingInput.delete(runner.sessionId);
    }
  };

  const connect = (id: EngineId) => {
    const link = links.get(id);
    if (!link) return;
    const hello = link.hello();
    const m = mirror(id);
    m.connected = true;
    m.seen = true;
    m.hello = hello;
    m.running = new Map(hello.running.map((info) => [info.sessionId, info]));
    // Events are replayed from the engine's next sequence number: after a boot the cloud has not seen, the
    // pending inputs of before are not known any more (the engine's sessions would tell again).
    if (!link.resumed) m.pendingInput.clear();
    // Everything the link needs is registered before the first frame is handled: this runs
    // synchronously inside the link's own change notification.
    for (const [method, handler] of handlers)
      link.handle(
        method as EngineMethod,
        ((params: never, context: HandlerContext) => handler(id, params, context)) as never,
      );
    link.onEvent(async (event) => {
      follow(id, event);
      for (const listener of eventListeners) await listener(id, event);
    });
    link.onTerminal((sessionId, data) => {
      for (const listener of terminalListeners) listener(id, sessionId, data);
    });
    void (async () => {
      for (const hook of connectHooks) {
        try {
          await hook({ id, link, hello, resumed: link.resumed });
        } catch (err) {
          logger.warn({ err, engineId: id }, 'a connect step of the engine failed');
        }
      }
      if (links.get(id) === link) notify(id, true);
    })();
  };

  const offChange = links.onChange((id, online) => {
    if (online) connect(id);
    else mirror(id).connected = false;
  });
  const offRegistry = registry.onOnlineChange((id, online) => {
    if (!online) notify(id, false);
  });

  let stoppedWaiting = false;
  const waiting = new Set<() => void>();
  const waitLink = (id: EngineId, signal?: AbortSignal): Promise<EngineLink> => {
    const now = links.get(id);
    if (now) return Promise.resolve(now);
    if (stoppedWaiting || !registry.isOnline(id))
      return Promise.reject(new EngineRpcError('link_down', 'The engine is not connected'));
    return new Promise<EngineLink>((resolve, reject) => {
      let off: () => void = () => {};
      let offOnline: () => void = () => {};
      const finish = (link: EngineLink | null, error?: Error) => {
        clearTimeout(timer);
        off();
        offOnline();
        waiting.delete(giveUp);
        signal?.removeEventListener('abort', onAbort);
        if (link) resolve(link);
        else reject(error ?? new EngineRpcError('link_down', 'The engine did not reconnect in time'));
      };
      const giveUp = () => finish(null, new EngineRpcError('link_down', 'The server is stopping'));
      waiting.add(giveUp);
      const onAbort = () => finish(null, new EngineRpcError('timeout', 'Engine call aborted'));
      const timer = setTimeout(() => finish(null), ENGINE_RELAY_WAIT_MS);
      timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      off = links.onChange((changed, online) => {
        if (changed !== id || !online) return;
        const link = links.get(id);
        if (link) finish(link);
      });
      // An engine that stops counting as available (or was revoked) is not waited for any longer: what
      // waits on it would hold up the starts and reads of the engines that are there.
      offOnline = registry.onOnlineChange((changed, online) => {
        if (changed === id && !online)
          finish(null, new EngineRpcError('link_down', 'The engine is not connected'));
      });
    });
  };

  return {
    mirror,
    link: (id) => links.get(id),
    available: (id) => registry.isOnline(id),
    defaultId: () => registry.defaultId(),
    ids: () => registry.ids(),
    async call(id, method, params, callOptions) {
      const link = await waitLink(id, callOptions?.signal);
      return link.call(method, params, callOptions);
    },
    handle(method, handler) {
      handlers.set(method, handler as unknown as CloudHandler);
    },
    onConnect(hook) {
      connectHooks.push(hook);
    },
    onEvent(listener) {
      eventListeners.push(listener);
    },
    onTerminal(listener) {
      terminalListeners.push(listener);
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    stopWaiting() {
      stoppedWaiting = true;
      for (const giveUp of [...waiting]) giveUp();
    },
    close() {
      offChange();
      offRegistry();
      changeListeners.clear();
    },
  };
}
