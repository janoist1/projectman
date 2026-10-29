import type { FastifyBaseLogger } from 'fastify';
import type { AgentProvider, EngineId } from '@projectman/shared';
import type {
  EngineDirectory,
  PauseOptions,
  PauseOutcome,
  PermissionBroker,
  ProviderStatus,
  RunnerEvent,
  RunningSessionInfo,
  SessionRunner,
  SessionCleanup,
  StartSessionSpec,
} from '../../contracts';
import { conflict } from '../../kernel';
import { EngineCallError, EngineRpcError } from '../rpc';
import type { EngineStartSpec } from '../session-schemas';
import type { RemoteHub } from './hub';

/**
 * The `SessionRunner` of the cloud mode (PM-315): every session runs on an engine, and this talks to
 * the engine the session belongs to. What the domain asks synchronously (`isRunning`, `list`,
 * `hasPendingInput`) is answered from the hub's mirror of each engine, which the engine's `hello` and its
 * runner events keep up to date. A call to an engine whose link is down waits for it (see `RemoteHub.call`).
 */

const PROVIDER_STATUS_TTL_MS = 60_000;
/** A start can take its time: the CLI's own checks, the workspace trust, the first screen. */
const START_TIMEOUT_MS = 120_000;
const PAUSE_TIMEOUT_MS = 10 * 60_000;
const SHUTDOWN_STOP_MS = 10_000;
const FIRE_AND_FORGET_MS = 10_000;

interface RemoteRunnerOptions {
  hub: RemoteHub;
  /** Which engine a project's start goes to when the spec names none, and the host's for a status asked of none. */
  directory: Pick<EngineDirectory, 'projectEngine' | 'hostEngine'>;
  /** Where the database says a session ran, for a session the engine does not report any more. */
  recordedEngine: (sessionId: string) => EngineId | null;
  logger: FastifyBaseLogger;
  /** Whether the cloud holds a NanoGPT key; only this fact enters an engine's NanoGPT status, never the key (PM-736). */
  nanogptKeySet?: () => Promise<boolean>;
  now?: () => number;
}

export interface RemoteRunner extends SessionRunner {
  /** Asks every connected engine for the provider's login state afresh (a key changed, PM-315). */
  refreshProviderStatus(provider: AgentProvider): Promise<void>;
  /**
   * The engine a session is on: the one that was asked to start it or reported it. Used by the
   * handlers of the calls an engine makes on the cloud, which act only for their own sessions.
   */
  engineOf(sessionId: string): EngineId | null;
  /** Its `session.start` has not been answered yet. */
  isStarting(sessionId: string): boolean;
  /** The NanoGPT key may be given to this session now (it is starting on this engine); once. */
  takeKeyGrant(engineId: EngineId, sessionId: string): boolean;
  /** Called by the module when a decision of the engine's session ended (to cut its pending decides). */
  onSessionEnded(listener: (sessionId: string) => void): void;
}

/** The last segment of `/mcp/<token>`: the engine builds its own address around it. */
function mcpTokenOf(mcpUrl: string): string {
  const segments = new URL(mcpUrl).pathname.split('/').filter((part) => part.length > 0);
  const token = segments[segments.length - 1];
  if (!token) throw new Error('The team tools address has no token');
  return token;
}

function toEngineSpec(spec: StartSessionSpec): EngineStartSpec {
  // `projectKey` only chooses the engine in the cloud; the engine's own start does not take it.
  const { mcpUrl, projectKey: _projectKey, ...rest } = spec;
  return { ...rest, mcpToken: mcpTokenOf(mcpUrl) };
}

/**
 * The NanoGPT key lives in the cloud's store, so the cloud decides whether the key is there: an engine
 * only checks its own machine (CLI version, `auth.json`). A CLI problem comes before a missing key, as it
 * does on one machine; every other provider and state stays as the engine reported it (PM-736).
 */
export function withNanogptKeyFact(status: ProviderStatus, keySet: boolean): ProviderStatus {
  if (status.provider !== 'nanogpt') return status;
  if (keySet && status.loggedIn === false && status.problem === 'no_key') {
    const { problem: _problem, ...ready } = status;
    return { ...ready, loggedIn: true };
  }
  if (!keySet && status.loggedIn === true) return { ...status, loggedIn: false, problem: 'no_key' };
  return status;
}

export function createRemoteRunner(options: RemoteRunnerOptions): RemoteRunner {
  const { hub, logger } = options;
  const keySet = async (): Promise<boolean> => {
    try {
      return (await options.nanogptKeySet?.()) ?? false;
    } catch {
      return false;
    }
  };
  const now = options.now ?? Date.now;
  const owners = new Map<string, EngineId>();
  const listeners = new Set<(event: RunnerEvent) => void>();
  const endListeners = new Set<(sessionId: string) => void>();
  /** Sessions a NanoGPT start is running for, per engine; `true`: the key was given already. */
  const keyGrants = new Map<EngineId, Map<string, boolean>>();
  /** Sessions whose `session.start` is on its way: the connect of their engine must not end them. */
  const startingSessions = new Set<string>();
  const statuses = new Map<string, { at: number; status: ProviderStatus }>();
  let closing = false;

  const emit = (event: RunnerEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (err) {
        logger.warn({ err }, 'a runner event listener failed');
      }
    }
  };
  const engineOf = (sessionId: string): EngineId | null =>
    owners.get(sessionId) ?? options.recordedEngine(sessionId);
  const needEngine = (sessionId: string): EngineId => {
    const id = engineOf(sessionId);
    if (!id) throw new EngineRpcError('not_running', `Session ${sessionId} is not running`);
    return id;
  };
  /** The engine a start goes to: the spec's own, else the project's choice. */
  const startEngine = (spec: Pick<StartSessionSpec, 'engineId' | 'projectKey'>): EngineId => {
    const id = spec.engineId ?? (spec.projectKey ? options.directory.projectEngine(spec.projectKey) : null);
    if (!id) throw conflict('engine_offline', 'there is no engine to run the session on');
    return id;
  };
  /**
   * The sessions whose terminal a viewer has attached. An engine forgets its attachments at every welcome (a
   * restarted cloud has no viewers any more), so the ones still viewed are attached again when it connects.
   */
  const attached = new Set<string>();
  const sessionEnded = (sessionId: string) => {
    owners.delete(sessionId);
    attached.delete(sessionId);
    for (const listener of endListeners) listener(sessionId);
  };

  hub.onConnect(({ id, hello }) => {
    const reported = new Set(hello.running.map((info) => info.sessionId));
    for (const info of hello.running) {
      // An engine's `hello` is its own word: it takes over no session that belongs to another engine.
      const owner = owners.get(info.sessionId) ?? options.recordedEngine(info.sessionId);
      if (owner && owner !== id) {
        logger.warn({ engineId: id, ownerId: owner }, 'an engine reported a session of another engine');
        // Not in this engine's mirror either (`list`, `processExists`, the folder sweep), and stopped on the
        // engine that reported it: `stop` goes to the recorded owner, which is the real one.
        hub.mirror(id).running.delete(info.sessionId);
        void hub
          .call(id, 'session.stop', { sessionId: info.sessionId, force: true })
          .catch((err: unknown) =>
            logger.warn({ err, engineId: id }, 'the session of another engine was not stopped'),
          );
        continue;
      }
      owners.set(info.sessionId, id);
    }
    // What the cloud believed was running on this engine but the engine does not report is over; the
    // reconciliation of the domain ends it (no `exit` event comes for it).
    for (const [sessionId, engineId] of [...owners])
      if (engineId === id && !reported.has(sessionId) && !startingSessions.has(sessionId))
        sessionEnded(sessionId);
    for (const sessionId of attached)
      if (owners.get(sessionId) === id) fire(sessionId, () => hub.call(id, 'terminal.attach', { sessionId }));
  });
  hub.onEvent((id, event) => {
    if (event.kind !== 'runner') return;
    const runnerEvent = event.event;
    const sessionId = runnerEvent.sessionId;
    // An engine speaks only for the sessions it runs; a forged event is dropped, not applied.
    if (engineOf(sessionId) !== id) {
      logger.warn({ engineId: id, type: runnerEvent.type }, 'dropped a runner event of a foreign session');
      return;
    }
    emit(runnerEvent);
    if (runnerEvent.type === 'exit') sessionEnded(sessionId);
  });
  hub.onTerminal((id, sessionId, data) => {
    if (owners.get(sessionId) !== id) return;
    emit({ type: 'terminal_data', sessionId, data });
  });

  const fire = (sessionId: string, send: (id: EngineId) => Promise<unknown>) => {
    const id = owners.get(sessionId);
    if (!id || !hub.link(id)) return;
    send(id).catch((err: unknown) => {
      if (!(err instanceof EngineCallError) || err.linkCode !== 'link_down')
        logger.debug({ err, sessionId }, 'a fire-and-forget engine call failed');
    });
  };

  const statusKey = (engineId: EngineId, provider: AgentProvider, member?: string) =>
    `${engineId}\0${provider}\0${member ?? ''}`;

  const runner: RemoteRunner = {
    engineOf,
    isStarting: (sessionId) => startingSessions.has(sessionId),
    onSessionEnded(listener) {
      endListeners.add(listener);
    },
    takeKeyGrant(engineId, sessionId) {
      const grants = keyGrants.get(engineId);
      if (!grants || grants.get(sessionId) !== false) return false;
      grants.set(sessionId, true);
      return true;
    },
    async assertWorkspaceConfig({ provider, cwd, engineId }) {
      // The launch names the engine it checks the workspace on; no path says which machine it is on.
      if (!engineId) throw conflict('engine_offline', 'there is no engine to check the workspace on');
      await hub.call(engineId, 'session.assert_workspace_config', { provider, cwd });
    },
    async start(spec) {
      const engineId = startEngine(spec);
      // A session of a project goes only to an engine bound to it, whoever named the engine (PM-1061).
      if (spec.projectKey) hub.assertBound(engineId, spec.projectKey);
      if (!hub.available(engineId))
        throw conflict('engine_offline', `engine ${engineId} is not connected`, { engine: engineId });
      // PM-1068: an engine with its own key file never asks the cloud for one. Without it only the host's
      // engine may be given the cloud's key; any other engine's NanoGPT start waits until it has a key.
      const ownKey = spec.provider === 'nanogpt' && hub.ownNanogptKey(engineId);
      if (spec.provider === 'nanogpt' && !ownKey && !hub.ownedByHost(engineId))
        throw conflict('nanogpt_key_missing', `engine ${engineId} has no NanoGPT key`, {
          provider: 'nanogpt',
        });
      owners.set(spec.sessionId, engineId);
      startingSessions.add(spec.sessionId);
      // Only a NanoGPT start without an own key may fetch the cloud's, and only until the engine answers the start.
      const grants = keyGrants.get(engineId) ?? new Map<string, boolean>();
      keyGrants.set(engineId, grants);
      if (spec.provider === 'nanogpt' && !ownKey) grants.set(spec.sessionId, false);
      try {
        const info = await hub.call(engineId, 'session.start', toEngineSpec(spec), {
          timeoutMs: START_TIMEOUT_MS,
        });
        hub.mirror(engineId).running.set(info.sessionId, info);
        return info;
      } catch (err) {
        // The engine may have started it anyway (a lost answer); the next connect stops what the cloud
        // does not know. Until then it is not ours.
        if (!hub.mirror(engineId).running.has(spec.sessionId)) owners.delete(spec.sessionId);
        throw err;
      } finally {
        grants.delete(spec.sessionId);
        startingSessions.delete(spec.sessionId);
      }
    },
    async sendUserMessage(sessionId, text) {
      await hub.call(needEngine(sessionId), 'session.send', { sessionId, message: text });
    },
    async compact(sessionId, instruction) {
      return hub.call(needEngine(sessionId), 'session.compact', { sessionId, instruction });
    },
    hasPendingInput(sessionId) {
      const id = owners.get(sessionId);
      return id ? hub.mirror(id).pendingInput.has(sessionId) : false;
    },
    writeTerminal(sessionId, data) {
      fire(sessionId, (id) =>
        hub.call(id, 'terminal.input', { sessionId, data }, { timeoutMs: FIRE_AND_FORGET_MS }),
      );
    },
    resize(sessionId, cols, rows) {
      fire(sessionId, (id) =>
        hub.call(
          id,
          'terminal.resize',
          { sessionId, cols: Math.max(1, Math.floor(cols)), rows: Math.max(1, Math.floor(rows)) },
          { timeoutMs: FIRE_AND_FORGET_MS },
        ),
      );
    },
    // The screen of a remote session is not in the cloud's memory: viewers use `attachTerminal`.
    snapshot: () => null,
    async attachTerminal(sessionId) {
      const id = owners.get(sessionId);
      if (!id || !hub.available(id)) return null;
      try {
        const snapshot = await hub.call(id, 'terminal.attach', { sessionId });
        attached.add(sessionId);
        return snapshot;
      } catch (err) {
        logger.debug({ err, sessionId }, 'the terminal could not be attached');
        return null;
      }
    },
    detachTerminal(sessionId) {
      attached.delete(sessionId);
      fire(sessionId, (id) =>
        hub.call(id, 'terminal.detach', { sessionId }, { timeoutMs: FIRE_AND_FORGET_MS }),
      );
    },
    async stop(sessionId, opts) {
      const id = owners.get(sessionId);
      // Nothing reports it running: there is nothing to stop.
      if (!id) return;
      await hub.call(id, 'session.stop', {
        sessionId,
        ...(opts?.force === undefined ? {} : { force: opts.force }),
      });
    },
    async closeScopes(scopes) {
      const groups = new Map<EngineId, typeof scopes>();
      for (const scope of scopes) {
        const engineId = needEngine(scope.sessionId);
        const group = groups.get(engineId) ?? [];
        group.push(scope);
        groups.set(engineId, group);
      }
      const results: Array<{ sessionId: string; cleanup: SessionCleanup }> = [];
      await Promise.all(
        [...groups].map(async ([id, group]) => {
          for (let offset = 0; offset < group.length; offset += 50)
            results.push(
              ...(await hub.call(id, 'session.close_scopes', { scopes: group.slice(offset, offset + 50) })),
            );
        }),
      );
      return results;
    },
    isRunning(sessionId) {
      const id = owners.get(sessionId);
      return id ? hub.mirror(id).running.has(sessionId) : false;
    },
    list() {
      const all: RunningSessionInfo[] = [];
      for (const id of hub.ids())
        for (const info of hub.mirror(id).running.values())
          if (owners.get(info.sessionId) === id) all.push(info);
      return all;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async shutdown() {
      closing = true;
      // The team tools' tokens are in this process's memory, so no session can outlive it: they are
      // stopped, as in the single mode.
      await Promise.all(
        [...owners].map(async ([sessionId, id]) => {
          if (!hub.link(id)) return;
          try {
            await hub.call(id, 'session.stop', { sessionId }, { timeoutMs: SHUTDOWN_STOP_MS });
          } catch (err) {
            logger.warn({ err, sessionId, engineId: id }, 'a session could not be stopped at shutdown');
          }
        }),
      );
    },
    async pause(sessionId, opts?: PauseOptions): Promise<PauseOutcome | null> {
      const id = owners.get(sessionId);
      // As for a local session that is not running.
      if (!id || !hub.mirror(id).running.has(sessionId)) return { point: 'exited', tool: null };
      return hub.call(
        id,
        'session.pause',
        {
          sessionId,
          ...(opts?.forceAfterMs === undefined ? {} : { forceAfterMs: opts.forceAfterMs }),
        },
        { timeoutMs: closing ? SHUTDOWN_STOP_MS : PAUSE_TIMEOUT_MS },
      );
    },
    async forcePause(sessionId) {
      const id = owners.get(sessionId);
      if (!id || !hub.mirror(id).running.has(sessionId)) return { point: 'exited', tool: null };
      return hub.call(id, 'session.force_pause', { sessionId });
    },
    release(sessionId, opts) {
      const id = owners.get(sessionId);
      if (!id || !hub.link(id) || !hub.mirror(id).running.has(sessionId)) return false;
      // The answer is synchronous in the contract; the engine's own answer is only logged.
      hub
        .call(id, 'session.release', {
          sessionId,
          ...(opts?.nudge === undefined ? {} : { nudge: opts.nudge }),
        })
        .then((released) => {
          if (!released) logger.debug({ sessionId }, 'the engine had no pause to release');
        })
        .catch((err: unknown) => logger.warn({ err, sessionId }, 'a pause could not be released'));
      return true;
    },
    async providerStatus(provider, opts) {
      // Asked of no engine, it is the instance-level question of the host's machine.
      const engineId = opts?.engineId ?? options.directory.hostEngine();
      if (!engineId || !hub.available(engineId))
        return {
          provider,
          loggedIn: null,
          method: null,
          checkedAt: new Date(now()).toISOString(),
          detail: 'The engine is not connected',
        };
      const key = statusKey(engineId, provider, opts?.member);
      const cached = statuses.get(key);
      // The cache keeps the engine's own answer: the key fact is added on every read, so saving or
      // deleting the key shows at the next read.
      // An engine with its own key file reports its own state (PM-1068). Otherwise the key is the host's: an
      // engine of another owner has none, so a NanoGPT start there waits (PM-1061).
      const answer = async (status: ProviderStatus) =>
        provider === 'nanogpt' && !hub.ownNanogptKey(engineId)
          ? withNanogptKeyFact(status, hub.ownedByHost(engineId) && (await keySet()))
          : status;
      if (cached && !opts?.refresh && now() - cached.at < PROVIDER_STATUS_TTL_MS)
        return answer(cached.status);
      const status = await hub.call(engineId, 'provider.status', {
        provider,
        ...(opts?.refresh ? { refresh: true } : {}),
        ...(opts?.member ? { member: opts.member } : {}),
      });
      statuses.set(key, { at: now(), status });
      return answer(status);
    },
    async refreshProviderStatus(provider) {
      for (const id of hub.ids()) {
        if (!hub.link(id)) continue;
        try {
          const status = await hub.call(id, 'provider.status', { provider, refresh: true });
          statuses.set(statusKey(id, provider), { at: now(), status });
        } catch (err) {
          logger.warn({ err, engineId: id, provider }, 'the provider status could not be refreshed');
        }
      }
    },
  };
  return runner;
}
