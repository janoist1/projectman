import type { FastifyBaseLogger } from 'fastify';
import type { EngineId } from '@projectman/shared';
import type { PermissionBroker } from '../../contracts';
import { EngineRpcError } from '../rpc';
import type { RemoteHub } from './hub';
import type { RemoteRunner } from './runner';

/**
 * The calls an engine makes on the cloud (PM-315): permission questions of its sessions, the NanoGPT key
 * of a session that is starting, and the team tools of a session (`mcp.relay`). Each is bound to the
 * engine's own sessions: an engine can ask about, and be given something for, only a session it runs.
 */

export interface CloudHandlerOptions {
  hub: RemoteHub;
  runner: RemoteRunner;
  broker: PermissionBroker;
  /** The projectman-managed NanoGPT key; null when there is none. */
  nanogptKey: () => Promise<string | null>;
  /**
   * Runs one team-tool request. Bound once the domain exists (it needs the session's token). Resolves the
   * session the token belongs to and refuses (`null`) a token that is not valid or not that engine's.
   */
  relayMcp: (
    engineId: EngineId,
    request: { token: string; contentType: string; accept: string; body: string },
  ) => Promise<{ status: number; contentType: string; body: string }>;
  logger: FastifyBaseLogger;
}

interface Pending {
  engineId: EngineId;
  sessionId: string;
  controller: AbortController;
}

export function registerCloudHandlers(options: CloudHandlerOptions): void {
  const { hub, runner, broker, logger } = options;
  const pending = new Map<string, Pending>();
  const keyOf = (engineId: EngineId, requestId: string) => `${engineId}\u0000${requestId}`;

  const ownSession = (engineId: EngineId, sessionId: string) => {
    if (runner.engineOf(sessionId) !== engineId)
      throw new EngineRpcError('not_running', 'The session is not running on this engine');
  };
  const abortWhere = (matches: (entry: Pending) => boolean) => {
    for (const [key, entry] of pending) {
      if (!matches(entry)) continue;
      pending.delete(key);
      entry.controller.abort();
    }
  };

  // A decision nobody can use any more is cut: the session ended, or the engine came back without the
  // state of its old link (it restarted, so the call that waited is gone). A link that resumed keeps its
  // calls: the engine sends the waiting one again and gets the same answer.
  runner.onSessionEnded((sessionId) => abortWhere((entry) => entry.sessionId === sessionId));
  hub.onConnect(({ id, resumed }) => {
    if (!resumed) abortWhere((entry) => entry.engineId === id);
  });

  hub.handle('permission.decide', async (engineId, { request }, context) => {
    ownSession(engineId, request.sessionId);
    const controller = new AbortController();
    const key = keyOf(engineId, context.id);
    pending.set(key, { engineId, sessionId: request.sessionId, controller });
    try {
      return await broker.decide(request, controller.signal);
    } finally {
      pending.delete(key);
    }
  });
  hub.handle('permission.cancel', (engineId, { reqId }) => {
    const key = keyOf(engineId, reqId);
    pending.get(key)?.controller.abort();
    pending.delete(key);
    return null;
  });
  hub.handle('permission.forward_question', async (engineId, { info }) => {
    ownSession(engineId, info.sessionId);
    if (!broker.forwardQuestion) return false;
    try {
      return await broker.forwardQuestion(info);
    } catch (err) {
      logger.warn({ err, sessionId: info.sessionId }, 'forwarding an agent question failed');
      return false;
    }
  });
  hub.onEvent((engineId, event) => {
    if (event.kind !== 'refused') return;
    // A session of another engine is not recorded: it could not have asked.
    if (runner.engineOf(event.info.sessionId) !== engineId) return;
    try {
      broker.refused?.(event.info);
    } catch (err) {
      logger.warn({ err, sessionId: event.info.sessionId }, 'recording a refused tool call failed');
    }
  });

  hub.handle('secret.nanogpt_key', async (engineId, { sessionId }) => {
    // Only to the session that is starting a NanoGPT member on this engine, and only until its start
    // call returns; never cached on the cloud.
    if (!runner.takeKeyGrant(engineId, sessionId))
      throw new EngineRpcError('secret_not_allowed', 'This session is not starting');
    const key = await options.nanogptKey();
    if (!key) throw new EngineRpcError('secret_not_allowed', 'There is no NanoGPT key');
    return { key };
  });

  hub.handle('mcp.relay', (engineId, params) => options.relayMcp(engineId, params));
}
