import path from 'node:path';
import type { FastifyBaseLogger, FastifyInstance, InjectOptions } from 'fastify';
import { routes } from '@projectman/shared';
import type { EngineId } from '@projectman/shared';
import type {
  EngineAttachments,
  GithubService,
  PermissionBroker,
  RunnerModule,
  ToolContext,
} from '../../contracts';
import { conflict } from '../../domain/errors';
import type { EngineLinks } from '../index';
import { createAttachmentMaterializer } from './attachments';
import { createRemoteGithub } from './github';
import { registerCloudHandlers } from './handlers';
import { createRemoteEngineDirectory } from './host';
import type { RemoteEngineDirectory } from './host';
import { createRemoteHub } from './hub';
import type { RemoteHub } from './hub';
import { createRemoteMachineProbe } from './machine';
import type { RemoteMachineProbe } from './machine';
import { createRemoteRunner } from './runner';
import type { RemoteRunner } from './runner';
import { createRemotePlanUsage, createRemoteTranscripts } from './transcripts';
import { createFileTransfers } from './transfers';
import type { FileTransfers } from './transfers';

/**
 * The cloud's side of a hybrid installation (PM-315, `PROJECTMAN_MODE=cloud`): everything that runs on the
 * machine is asked of the connected engine over its link. The parts are built before the domain (it takes
 * them as its runner, engines, machine probe and GitHub service) and bound to it afterwards (`bind`):
 * the team tools relay, the reconciliation when an engine connects, and the key change.
 */

/** What the cloud's own domain gives to the remote parts once it exists. */
export interface CloudDomain {
  sessions: {
    resolveToken(token: string): ToolContext | null;
    engineOf(sessionId: string): EngineId;
    reconcileEngine(
      engineId: EngineId,
      reported: ReadonlySet<string>,
      starting: (sessionId: string) => boolean,
    ): Promise<void>;
  };
  providerKeys?: { onChange(listener: () => void): () => void } | null;
}

export interface CloudRemoteOptions {
  links: EngineLinks;
  registry: {
    isOnline(id: EngineId): boolean;
    defaultId(): EngineId | null;
    ids(): EngineId[];
    onOnlineChange(listener: (id: EngineId, online: boolean) => void): () => void;
  };
  /** The engine a session ran on according to the database (for one the engine does not report any more). */
  recordedEngine: (sessionId: string) => EngineId | null;
  /** Where the files an engine uploads wait for their use (emptied at start). */
  spoolDir: string;
  logger: FastifyBaseLogger;
  now?: () => number;
}

export interface CloudRemote {
  hub: RemoteHub;
  transfers: FileTransfers;
  directory: RemoteEngineDirectory;
  runner: RemoteRunner;
  machineProbe: RemoteMachineProbe;
  github: GithubService;
  attachments: EngineAttachments;
  /** The runner module the domain asks for: the permission handlers are bound to its `broker`. */
  createRunnerModule(
    broker: PermissionBroker,
    nanogptKey: (() => Promise<string | null>) | undefined,
  ): RunnerModule;
  /** Binds the parts that need the domain and the app (its `inject`, for the team tools relay). */
  bind(domain: CloudDomain, app: Pick<FastifyInstance, 'inject'>): void;
  /** The server is stopping: no call waits for an engine to come back (the team is paused over the live links only). */
  stopWaiting(): void;
  close(): void;
}

const NOT_FOUND = { status: 404, contentType: 'application/json', body: '{"error":"not_found"}' } as const;

export function createCloudRemote(options: CloudRemoteOptions): CloudRemote {
  const { logger } = options;
  const hub = createRemoteHub({ links: options.links, registry: options.registry, logger });
  const transfers = createFileTransfers({
    links: options.links,
    spoolDir: options.spoolDir,
    now: options.now,
  });
  const directory = createRemoteEngineDirectory({ hub, transfers, logger, now: options.now });
  const runner = createRemoteRunner({
    hub,
    recordedEngine: options.recordedEngine,
    logger,
    now: options.now,
  });
  const transcripts = createRemoteTranscripts({ hub, transfers, now: options.now });
  const { planUsage, planUsageFor } = createRemotePlanUsage({ hub, now: options.now });
  const machineProbe = createRemoteMachineProbe({ hub });
  const github = createRemoteGithub({ hub, logger });
  const materializer = createAttachmentMaterializer({ hub, transfers });
  const attachments: EngineAttachments = {
    async directory(projectKey, taskKey) {
      const engineId = hub.defaultId();
      const dir = engineId ? materializer.directory(engineId, projectKey, taskKey) : null;
      if (!dir) throw conflict('engine_offline', 'There is no connected engine to keep the attachments on');
      return dir;
    },
    async materialize(input) {
      const engineId = runner.engineOf(input.sessionId) ?? hub.defaultId();
      if (!engineId) throw conflict('engine_offline', 'There is no engine the session runs on');
      return materializer.materialize(engineId, {
        projectKey: input.projectKey,
        taskKey: input.taskKey,
        id: input.attachment.id,
        fileName: path.basename(input.attachment.fileName),
        storedPath: input.storedPath,
      });
    },
  };

  let bound: { domain: CloudDomain; app: Pick<FastifyInstance, 'inject'> } | null = null;

  // An engine that connects is reconciled with the database before anything waits for it again.
  hub.onConnect(async ({ id, hello }) => {
    if (!bound) return;
    await bound.domain.sessions.reconcileEngine(
      id,
      new Set(hello.running.map((info) => info.sessionId)),
      (sessionId) => runner.isStarting(sessionId),
    );
  });

  /** One team-tools request of an engine's session, run through the MCP routes of this very server. */
  const relayMcp: Parameters<typeof registerCloudHandlers>[0]['relayMcp'] = async (engineId, request) => {
    if (!bound) return { status: 503, contentType: 'application/json', body: '{"error":"starting"}' };
    const context = bound.domain.sessions.resolveToken(request.token);
    // A token works for the engine its session runs on and for no other.
    if (!context || bound.domain.sessions.engineOf(context.sessionId) !== engineId) return NOT_FOUND;
    const response = await bound.app.inject({
      method: 'POST',
      url: routes.mcp(request.token),
      headers: { 'content-type': request.contentType, accept: request.accept },
      payload: request.body,
    } satisfies InjectOptions);
    return {
      status: response.statusCode,
      contentType: String(response.headers['content-type'] ?? 'application/json'),
      body: response.body,
    };
  };

  return {
    hub,
    transfers,
    directory,
    runner,
    machineProbe,
    github,
    attachments,
    createRunnerModule(broker, nanogptKey) {
      registerCloudHandlers({
        hub,
        runner,
        broker,
        nanogptKey: nanogptKey ?? (async () => null),
        relayMcp,
        logger,
      });
      return {
        runner,
        transcripts,
        planUsage,
        planUsageFor,
        // The CLIs' hooks reach the engine's own loopback listener; the cloud has none.
        registerHookRoutes() {},
      };
    },
    bind(domain, app) {
      bound = { domain, app };
      // A new key is also what an engine's NanoGPT sessions read at their start: ask each for its login state.
      domain.providerKeys?.onChange(() => {
        void runner.refreshProviderStatus('nanogpt');
      });
    },
    stopWaiting() {
      hub.stopWaiting();
    },
    close() {
      hub.close();
      transfers.close();
    },
  };
}
