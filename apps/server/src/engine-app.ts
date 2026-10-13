import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import { AgentProvider, routes } from '@projectman/shared';
import { APP_DEFAULTS, loopbackBaseUrl } from './app';
import { serializeRequest } from './auth/request-logging';
import type {
  FullTestExecutor,
  GithubService,
  MachineProbe,
  PermissionBroker,
  RunnerModule,
  RunnerModuleOptions,
  ScreenshotExecutor,
} from './contracts';
import { createLocalEngine } from './domain/engines';
import { createEngineAudit } from './engine-link/engine-audit';
import { createEngineClient } from './engine-link/engine-client';
import type { LinkSocketFactory } from './engine-link/engine-client';
import {
  EngineConfigError,
  engineFiles,
  loadEngineConfig,
  readLinkHeaders,
  readSecretFile,
  resolveEngineConfig,
} from './engine-link/engine-config';
import { createEngineHandlers } from './engine-link/engine-handlers';
import { createEngineLimit } from './engine-link/engine-limit';
import { createEngineStatusWriter } from './engine-link/engine-status';
import { createEngineTransfers } from './engine-link/engine-transfer';
import { createEngineEventBuffer } from './engine-link/event-buffer';
import { ENGINE_RELAY_WAIT_MS } from './engine-link/protocol';
import { EngineCallError } from './engine-link/rpc';
import type { EngineEvent, Hello } from './engine-link/protocol';
import { createFullTestExecutor, createScreenshotExecutor, defaultHeavyLockDir } from './full-test';
import { freeBytesOf } from './engine-host';
import { nonLocalReason } from './http/local-guard';
import { assertHomeMayStart } from './instance';
import { createMachineProbe } from './machine';
import { createRunnerModule } from './runner';
import { createGithubService } from './github';
import { createMemberWorkspaceManager, createWorktreeManager } from './worktree';

/**
 * The engine process (PM-314): the runner, the worktrees and the local tools on the machine the work
 * happens on, joined to the cloud by one outbound link. It has no database, no web app and no `/api`: its
 * only HTTP surface is a loopback listener for the CLIs' hooks and the team tools (`POST /mcp/:token`),
 * which it relays to the cloud over the link. Everything the cloud asks for passes `engine-limit.ts`
 * and is written to the audit log (`engine-handlers.ts`). The environment is read by `index.ts` only.
 */

export const ENGINE_DEFAULT_PORT = 4801;
const MAX_BODY_BYTES = 1024 * 1024;
const HELLO_PROVIDER_WAIT_MS = 10_000;
const PENDING_INPUT_POLL_MS = 1000;
const SHUTDOWN_PAUSE_CAP_MS = 20_000;
const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;
const LOOPBACK = '127.0.0.1';

/** A hybrid engine runs the `legacy` profile on the owner's machine; the managed VM is a different installation. */
export function assertEngineProfile(settings: { executionProfile?: string; boundaryConfig?: string }): void {
  if (settings.executionProfile === 'managed_vm' || settings.boundaryConfig)
    throw new EngineConfigError(
      'managed_vm_unsupported',
      'The engine runs the legacy execution profile only: PROJECTMAN_EXECUTION_PROFILE=managed_vm and PROJECTMAN_BOUNDARY_CONFIG belong to the managed VM, not to an engine.',
    );
}

export interface EngineAppModules {
  createRunnerModule?: (opts: RunnerModuleOptions) => RunnerModule;
  github?: GithubService;
  createFullTestExecutor?: (deps: { heavyLockDir: string }) => FullTestExecutor;
  createScreenshotExecutor?: (deps: { heavyLockDir: string }) => ScreenshotExecutor;
  createMachineProbe?: (deps: { runningPids: () => number[]; instanceTag: string }) => MachineProbe;
  createSocket?: LinkSocketFactory;
  fetch?: typeof fetch;
  random?: () => number;
  auditMaxBytes?: number;
  statusDelayMs?: number;
}

export interface EngineAppOptions {
  home: string;
  userHome?: string;
  port: number;
  /** `resolveAppVersion(installDir, PROJECTMAN_VERSION)`: what the cloud compares with its own. */
  version: string;
  installDir: string;
  /** Checked at start: a managed VM setting stops the engine. */
  executionProfile?: string;
  boundaryConfig?: string;
  agentEnv?: NodeJS.ProcessEnv;
  claudeBin?: string;
  codexBin?: string;
  geminiBin?: string;
  codexHome?: string;
  claudeConfigPath?: string;
  terminal?: RunnerModuleOptions['terminal'];
  ghBin?: string;
  ghHost?: string;
  sessionFoldersDir?: string;
  sessionTmpDir?: string;
  claudeTmpBase?: string;
  browsersDir?: string;
  heavyLockDir?: string;
  cloneDependencies?: boolean;
  permissionTimeoutMs?: number;
  /** How long a team-tool call waits for the link to come back before it answers 503; tests shorten it. */
  relayWaitMs?: number;
  shutdownPauseMs?: number;
  /** The temporary directory sessions may use (`os.tmpdir()`); tests name another one, since their home lies in it. */
  tmpdir?: string;
  logger?: FastifyServerOptions['logger'];
  modules?: EngineAppModules;
}

export interface EngineApp {
  app: FastifyInstance;
  /** Listens on the loopback port and starts connecting to the cloud. */
  start(): Promise<void>;
  /** Pauses the running sessions at a safe point (the first step of the shutdown). */
  pauseForShutdown(): Promise<void>;
  /** Stops the sessions, sends the pending events, closes the link ("engine_shutdown") and the listener. */
  close(): Promise<void>;
  /** The files of this engine (config, status, audit, key). */
  files: ReturnType<typeof engineFiles>;
}

function jsonRpcError(reply: FastifyReply, status: number, message: string) {
  return reply
    .code(status)
    .type('application/json')
    .send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

const headerText = (value: string | string[] | undefined, fallback: string): string => {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.length > 0 && first.length <= 256 ? first : fallback;
};

export async function buildEngineApp(options: EngineAppOptions): Promise<EngineApp> {
  assertEngineProfile(options);
  if (os.platform() !== 'darwin' && os.platform() !== 'linux')
    throw new EngineConfigError('platform_unsupported', 'The engine runs on macOS or Linux.');
  const modules = options.modules ?? {};
  const home = path.resolve(options.home);
  const userHome = options.userHome ?? os.homedir();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const resolved = resolveEngineConfig(loadEngineConfig(home), home, {
    ...(options.tmpdir ? { tmpdir: options.tmpdir } : {}),
  });
  assertHomeMayStart(home, 'engine'); // a damaged or retired marker stops the engine too (PM-318)
  // The key and the extra headers are read here once so a wrong mode stops the start, not a later reconnect.
  readSecretFile(resolved.keyFile, 'The engine key');
  if (resolved.linkHeadersFile) readLinkHeaders(resolved.linkHeadersFile);
  const files = engineFiles(home, resolved);
  const instanceTag = createHash('sha256').update(realpathSync(home)).digest('hex').slice(0, 16);
  const bootId = randomBytes(8).toString('hex');
  const uid = process.getuid?.() ?? null;
  const baseUrl = loopbackBaseUrl(LOOPBACK, options.port);
  const heavyLockDir = options.heavyLockDir ?? defaultHeavyLockDir();
  const agentEnv = options.agentEnv ?? process.env;

  const logger = options.logger ?? { level: APP_DEFAULTS.logLevel };
  const app = Fastify({
    logger:
      logger === false
        ? false
        : {
            ...(typeof logger === 'object' ? logger : {}),
            serializers: { ...(typeof logger === 'object' ? logger.serializers : {}), req: serializeRequest },
          },
    bodyLimit: MAX_BODY_BYTES,
  });
  const log = app.log;

  const status = createEngineStatusWriter(
    files.status,
    { pid: process.pid, bootId },
    { delayMs: modules.statusDelayMs },
  );
  const audit = createEngineAudit(files.audit, {
    ...(modules.auditMaxBytes === undefined ? {} : { maxBytes: modules.auditMaxBytes }),
    onError: () => log.warn('engine audit log: a record could not be written'),
  });
  const buffer = createEngineEventBuffer();
  const headers = (): Record<string, string> => ({
    ...(resolved.linkHeadersFile ? readLinkHeaders(resolved.linkHeadersFile) : {}),
    authorization: `Bearer ${readSecretFile(resolved.keyFile, 'The engine key')}`,
  });
  const transfers = createEngineTransfers({
    cloudUrl: resolved.cloudUrl,
    headers,
    ...(modules.fetch ? { fetch: modules.fetch } : {}),
  });

  // Built in this order because they refer to each other: the client runs the handlers, the handlers need
  // the runner, the runner needs the broker, the broker calls the cloud through the client.
  let handlers!: ReturnType<typeof createEngineHandlers>;
  let runnerModule!: RunnerModule;
  const client = createEngineClient({
    config: resolved,
    hello: () => hello(),
    register: (rpc) => handlers.register(rpc),
    onRefused: (request) => handlers.refusedBeforeHandler(request),
    buffer,
    status,
    logger: log.child({ module: 'engine-link' }),
    ...(modules.createSocket ? { createSocket: modules.createSocket } : {}),
    ...(modules.random ? { random: modules.random } : {}),
  });
  const terminals = new Set<string>();
  const emit = (event: EngineEvent) => client.emit(event);

  const broker: PermissionBroker = {
    async decide(request, signal) {
      let reqId: string | undefined;
      try {
        return await client.call(
          'permission.decide',
          { request },
          {
            signal,
            timeoutMs: options.permissionTimeoutMs ?? APP_DEFAULTS.permissionTimeoutMs,
            onRequestId: (id) => {
              reqId = id;
            },
          },
        );
      } catch {
        // Aborted (timeout, session exit), the link lost, or the cloud refused: the agent is told no.
        if (reqId !== undefined && client.connected())
          void client.call('permission.cancel', { reqId }, { timeoutMs: 5000 }).catch(() => undefined);
        return { behavior: 'deny', message: 'The decision could not be obtained from the cloud.' };
      }
    },
    refused(info) {
      emit({ kind: 'refused', info });
    },
    async forwardQuestion(info) {
      try {
        return await client.call('permission.forward_question', { info }, { timeoutMs: 30_000 });
      } catch {
        return false;
      }
    },
  };

  // The NanoGPT key is fetched per session start and kept in memory only: nothing writes it to a file, the
  // log or the status. Outside such a start (plan usage, the login check) there is no key to give.
  const nanogptScope = new AsyncLocalStorage<{
    sessionId: string;
    active: boolean;
    key?: Promise<string | null>;
  }>();
  const nanogptKey = async (): Promise<string | null> => {
    const scope = nanogptScope.getStore();
    if (!scope?.active) return null;
    // Logged with the method, the session and the outcome only; never the key.
    const sessionId = scope.sessionId;
    let reqId = '';
    scope.key ??= client
      .call('secret.nanogpt_key', { sessionId }, { onRequestId: (id) => (reqId = id) })
      .then((result) => {
        audit.record({
          reqId,
          method: 'secret.nanogpt_key',
          sessionId,
          outcome: result.key ? 'ok' : 'error',
          ...(result.key ? {} : { code: 'no_key' }),
        });
        return result.key;
      })
      .catch((error: unknown) => {
        audit.record({
          reqId,
          method: 'secret.nanogpt_key',
          sessionId,
          outcome: 'error',
          code: error instanceof EngineCallError ? error.linkCode : 'internal',
        });
        return null;
      });
    return scope.key;
  };
  const nanogptStart = async <T>(sessionId: string, start: () => Promise<T>): Promise<T> => {
    const scope = { sessionId, active: true } as {
      sessionId: string;
      active: boolean;
      key?: Promise<string | null>;
    };
    try {
      return await nanogptScope.run(scope, start);
    } finally {
      scope.active = false;
      delete scope.key;
    }
  };

  const github =
    modules.github ??
    createGithubService({
      ghBin: options.ghBin ?? APP_DEFAULTS.ghBin,
      ghHost: options.ghHost ?? APP_DEFAULTS.ghHost,
      pollIntervalMs: APP_DEFAULTS.githubPollIntervalMs,
      logger: log.child({ module: 'github' }),
    });
  const worktrees = createWorktreeManager({
    rootDir: path.join(home, 'worktrees'),
    logger: log.child({ module: 'worktree' }),
    cloneDependencies: options.cloneDependencies ?? false,
  });
  const workspacesDir = path.join(home, 'workspaces');
  const memberWorkspaces = createMemberWorkspaceManager({
    rootDir: workspacesDir,
    logger: log.child({ module: 'workspace' }),
  });
  const nanogptCodexHome = path.join(home, 'providers', 'nanogpt', 'codex-home');
  const geminiConfigDir = path.join(home, 'providers', 'gemini');
  runnerModule = (modules.createRunnerModule ?? createRunnerModule)({
    claudeBin: options.claudeBin ?? APP_DEFAULTS.claudeBin,
    codexBin: options.codexBin ?? APP_DEFAULTS.codexBin,
    codexHome: options.codexHome,
    nanogptCodexHome,
    nanogptKey,
    geminiBin: options.geminiBin,
    geminiConfigDir,
    claudeConfigPath: options.claudeConfigPath,
    env: agentEnv,
    terminal: options.terminal,
    publicBaseUrl: baseUrl,
    instanceTag,
    broker,
    refreshDependencies: (cwd) => worktrees.refreshDependencies(cwd).then(() => undefined),
    permissionTimeoutMs: options.permissionTimeoutMs ?? APP_DEFAULTS.permissionTimeoutMs,
    logger: log.child({ module: 'runner' }),
  });
  const runner = runnerModule.runner;

  const engine = createLocalEngine(
    {
      worktrees,
      memberWorkspaces,
      fullTestExecutor:
        modules.createFullTestExecutor?.({ heavyLockDir }) ??
        createFullTestExecutor({ logger: log.child({ module: 'full-test' }), env: agentEnv, heavyLockDir }),
      screenshotExecutor:
        modules.createScreenshotExecutor?.({ heavyLockDir }) ??
        createScreenshotExecutor({
          logger: log.child({ module: 'screenshots' }),
          env: agentEnv,
          heavyLockDir,
        }),
      freeDiskBytes: () => freeBytesOf(home),
      workspacePath: (projectKey) =>
        resolved.projects.find((entry) => entry.project === projectKey)?.workspacePath ?? null,
      // The engine's own binding (`engine.json`), never the cloud's paths (PM-451).
      repoPath: (projectKey, repo) =>
        resolved.repos.find((entry) => entry.project === projectKey && entry.repo === repo)?.path ?? null,
      appHome: home,
      userHome,
      worktreesRootDir: path.join(home, 'worktrees'),
      workspacesRootDir: workspacesDir,
      installDir: options.installDir,
      sessionFoldersDir: options.sessionFoldersDir,
      sessionTmpDir: options.sessionTmpDir,
      claudeTmpBase: options.claudeTmpBase,
      browsersDir: options.browsersDir,
      heavyLockDir,
    },
    log.child({ module: 'engine' }),
  );
  const runningPids = () => runner.list().map((info) => info.pid);
  const probe = modules.createMachineProbe?.({ runningPids, instanceTag }) ?? createMachineProbe();
  const codexHome = options.codexHome ?? path.join(userHome, '.codex');
  const limit = createEngineLimit({
    config: resolved,
    home,
    userHome,
    paths: engine.paths(),
    instanceTag,
    // Only the CLIs' own transcript folders, not their whole homes (which hold credentials).
    transcriptRoots: [
      path.join(userHome, '.claude', 'projects'),
      path.join(codexHome, 'sessions'),
      path.join(nanogptCodexHome, 'sessions'),
      geminiConfigDir,
    ],
    probe,
    sessionPids: runningPids,
    selfUid: uid,
    ...(options.tmpdir ? { tmpdir: options.tmpdir } : {}),
  });
  const exportDir = path.join(home, 'export-tmp');
  mkdirSync(exportDir, { recursive: true, mode: 0o700 });
  handlers = createEngineHandlers({
    limit,
    audit,
    runner,
    transcripts: runnerModule.transcripts,
    planUsageFor: (provider) => runnerModule.planUsageFor?.(provider) ?? runnerModule.planUsage,
    engine,
    github,
    probe,
    transfers,
    fullTest: engine.fullTestExecutor,
    screenshots: engine.screenshotExecutor,
    mcpBase: baseUrl,
    emit,
    terminals,
    exportDir,
    nanogptStart,
  });

  async function hello(): Promise<Omit<Hello, 't' | 'protocol' | 'nextSeq'>> {
    const paths = engine.paths();
    const providers = await Promise.all(
      AgentProvider.options.map(async (provider) => {
        try {
          const result = await Promise.race([
            runner.providerStatus?.(provider) ?? Promise.resolve(null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), HELLO_PROVIDER_WAIT_MS).unref()),
          ]);
          return {
            provider,
            available: result !== null && (result.cliVersion !== undefined || result.loggedIn === true),
            version: result?.cliVersion ?? null,
          };
        } catch {
          return { provider, available: false, version: null };
        }
      }),
    );
    return {
      version: options.version,
      hostname: os.hostname(),
      platform: os.platform() === 'darwin' ? 'darwin' : 'linux',
      paths: {
        userHome: paths.userHome,
        home: paths.home,
        worktreesRoot: paths.worktreesRoot,
        workspacesRoot: paths.workspacesRoot,
        installDir: paths.installDir,
        sessionFoldersRoot: paths.sessionFoldersRoot,
        sessionTmpRoot: paths.sessionTmpRoot,
        claudeTmpRoots: [...paths.claudeTmpRoots],
        browsersDir: paths.browsersDir,
        heavyLockDir: paths.heavyLockDir,
        gitExcludesFile: paths.gitExcludesFile,
      },
      projects: resolved.projects.map(({ project, workspacePath }) => ({ project, workspacePath })),
      repos: resolved.repos.map((entry) => ({
        project: entry.project,
        repo: entry.repo,
        fullTest: entry.fullTestCommand !== undefined,
      })),
      providers,
      running: runner.list(),
      instanceTag,
      pid: process.pid,
      uid,
      bootId,
    };
  }

  // The runner's events go to the cloud in order; the terminal's raw output only for attached sessions.
  const pendingInput = new Map<string, boolean>();
  const syncPendingInput = (sessionId: string) => {
    const pending = runner.hasPendingInput?.(sessionId) ?? false;
    if ((pendingInput.get(sessionId) ?? false) === pending) return;
    pendingInput.set(sessionId, pending);
    emit({ kind: 'pending_input', sessionId, pending });
  };
  const unsubscribe = runner.onEvent((event) => {
    if (event.type === 'terminal_data') {
      if (terminals.has(event.sessionId)) client.terminal(event.sessionId, event.data);
      return;
    }
    emit({ kind: 'runner', event });
    if (event.type === 'exit') {
      terminals.delete(event.sessionId);
      syncPendingInput(event.sessionId);
      pendingInput.delete(event.sessionId);
    } else syncPendingInput(event.sessionId);
  });
  const runningState = () => runner.list().map(({ sessionId, state }) => ({ sessionId, state }));
  const poll = setInterval(() => {
    for (const info of runner.list()) syncPendingInput(info.sessionId);
    status.set({ running: runningState() });
  }, PENDING_INPUT_POLL_MS);
  poll.unref();

  // The CLIs' hooks (`/hooks/:token`) and the team tools (`/mcp/:token`), on the loopback listener only.
  runnerModule.registerHookRoutes(app);
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: MAX_BODY_BYTES },
      (_request, body, done) => done(null, body),
    );
    scope.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const reason = nonLocalReason({
        remoteAddress: request.socket.remoteAddress,
        headers: request.headers,
      });
      if (reason) {
        log.warn({ reason }, 'rejected a non-local MCP request');
        return jsonRpcError(reply, 403, 'Forbidden: the team MCP endpoint only accepts local connections.');
      }
      const { token } = request.params as { token: string };
      // 404 rather than 401: a 401 makes MCP clients (Claude Code included) start an OAuth flow.
      if (!TOKEN.test(token)) return jsonRpcError(reply, 404, 'Unknown or expired team session.');
    });
    // The token is part of the URL: keep the request out of the info log.
    const route = { url: routes.mcp(':token'), logLevel: 'warn', bodyLimit: MAX_BODY_BYTES } as const;
    scope.route({
      ...route,
      method: 'POST',
      async handler(request, reply) {
        const { token } = request.params as { token: string };
        const body = typeof request.body === 'string' ? request.body : '';
        try {
          const result = await client.call(
            'mcp.relay',
            {
              token,
              contentType: headerText(request.headers['content-type'], 'application/json'),
              accept: headerText(request.headers.accept, ''),
              body,
            },
            { timeoutMs: options.relayWaitMs ?? ENGINE_RELAY_WAIT_MS },
          );
          if (result.status < 200 || result.status > 599)
            return jsonRpcError(reply, 502, 'The cloud answered badly.');
          reply.code(result.status);
          if (result.contentType) reply.type(result.contentType);
          return reply.send(result.body.length > 0 ? result.body : undefined);
        } catch (error) {
          const code = error instanceof Error && 'linkCode' in error ? String(error.linkCode) : 'internal';
          if (code === 'link_down')
            return jsonRpcError(reply, 503, 'The engine is not connected to the cloud.');
          if (code === 'timeout') return jsonRpcError(reply, 504, 'The cloud did not answer in time.');
          return jsonRpcError(reply, 502, 'The team tools are not available.');
        }
      },
    });
    scope.route({
      ...route,
      method: ['GET', 'DELETE'],
      async handler(_request, reply) {
        reply.header('allow', 'POST');
        return jsonRpcError(
          reply,
          405,
          'Method not allowed: this MCP endpoint is stateless and only accepts POST.',
        );
      },
    });
  });

  let closed = false;
  return {
    app,
    files,
    async start() {
      status.set({ running: runningState() });
      await app.listen({ port: options.port, host: LOOPBACK });
      client.start();
      log.info({ home, engineId: resolved.engineId, port: options.port }, 'projectman engine ready');
    },
    async pauseForShutdown() {
      const waitMs = options.shutdownPauseMs ?? APP_DEFAULTS.shutdownPauseMs;
      if (waitMs <= 0) return;
      const running = runner.list();
      if (running.length === 0) return;
      log.info({ sessions: running.length }, 'pausing the running sessions before shutdown');
      const cap = new Promise<void>((resolve) => setTimeout(resolve, waitMs + SHUTDOWN_PAUSE_CAP_MS).unref());
      await Promise.race([
        Promise.all(
          running.map((info) =>
            runner.pause(info.sessionId, { forceAfterMs: waitMs }).catch((error: unknown) => {
              log.warn({ err: error }, 'a session could not be paused');
              return null;
            }),
          ),
        ).then(() => undefined),
        cap,
      ]);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      handlers.dispose();
      // The sessions stop first so that their last events (exit, paused) are in what is sent.
      await runner
        .shutdown()
        .catch((error: unknown) => log.warn({ err: error }, 'the runner did not shut down'));
      unsubscribe();
      await client.flush(5000);
      await client.close();
      await engine.sessionFolders?.releaseTmpRoot().catch(() => undefined);
      status.flush();
      await app.close();
    },
  };
}
