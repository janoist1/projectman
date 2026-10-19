import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import { AgentProvider, routes } from '@projectman/shared';
import { APP_DEFAULTS, loopbackBaseUrl } from './app';
import { serializeRequest } from './http';
import type {
  AdministrationCapability,
  AdministrationPort,
  AdministrationTarget,
  FullTestExecutor,
  GithubService,
  MachineProbe,
  PermissionBroker,
  RunnerModule,
  RunnerModuleOptions,
  ScreenshotExecutor,
  WorkspaceDependencyInstaller,
} from './contracts';
import { SESSION_CONFIG_DIR } from './contracts';
import { createSocketClient } from './administration';
import { createLocalEngine, resolveWorkRoots } from './engine-host';
import {
  createEngineAudit,
  createEngineClient,
  createEngineHandlers,
  createEngineLimit,
  createEngineStatusWriter,
  createEngineTransfers,
  createEngineEventBuffer,
  ENGINE_RELAY_WAIT_MS,
  EngineCallError,
  EngineConfigError,
  engineFiles,
  loadEngineConfig,
  readLinkHeaders,
  readSecretFile,
  resolveEngineConfig,
} from './engine-link';
import type { EngineEvent, Hello, LinkSocketFactory } from './engine-link';
import {
  createFullTestExecutor,
  createScreenshotExecutor,
  createWorkspaceDependencyInstaller,
  defaultHeavyLockDir,
  readHeavyRunSessions,
} from './full-test';
import { freeBytesOf } from './engine-host';
import { nonLocalReason } from './kernel';
import { assertHomeMayStart } from './instance';
import { createMachineProbe } from './machine';
import { createRunnerModule, DEPENDENCY_GATE_WAIT_S } from './runner';
import { createGithubService } from './services/github';
import {
  createDependencyGate,
  createMemberWorkspaceManager,
  createMemberWorkspaceRegistry,
  createWorktreeManager,
} from './worktree';

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
const ADMINISTRATION_HELLO_WAIT_MS = 3_000;
const PENDING_INPUT_POLL_MS = 1000;
const SHUTDOWN_PAUSE_CAP_MS = 20_000;
const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;
const LOOPBACK = '127.0.0.1';

export interface EngineAppModules {
  createRunnerModule?: (opts: RunnerModuleOptions) => RunnerModule;
  github?: GithubService;
  createFullTestExecutor?: (deps: {
    heavyLockDir: string;
    worktreesRoot?: string;
    tmpDir?: string;
  }) => FullTestExecutor;
  createScreenshotExecutor?: (deps: { heavyLockDir: string }) => ScreenshotExecutor;
  createMachineProbe?: (deps: { runningPids: () => number[]; instanceTag: string }) => MachineProbe;
  createSocket?: LinkSocketFactory;
  /** The client of this machine's administration supervisor (PM-763); tests supply a fake one. */
  createAdministrationClient?: (socketPath: string) => AdministrationPort;
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
  /** The Unix socket of this machine's administration supervisor (PM-763); absent: no administration here. */
  administrationSocket?: string;
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
  // PM-846: an unmounted or misplaced work volume stops the start; it never falls back to the home quietly.
  const roots = resolveWorkRoots(home, resolved.workRoot);
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
    rootDir: roots.worktrees,
    logger: log.child({ module: 'worktree' }),
    cloneDependencies: options.cloneDependencies ?? false,
  });
  const workspacesDir = roots.workspaces;
  let workspaceDependencies: WorkspaceDependencyInstaller | undefined;
  const memberClones = createMemberWorkspaceRegistry();
  const memberWorkspaces = createMemberWorkspaceManager({
    rootDir: workspacesDir,
    logger: log.child({ module: 'workspace' }),
    onEnsured: memberClones.register,
    // The limit needs the engine's paths; install the port before the link can accept any call.
    get dependencies() {
      return workspaceDependencies;
    },
  });
  // A running session's command tools wait for its clone's dependencies (PM-743).
  const dependencyGate = createDependencyGate({
    prepare: (key, opts) => memberWorkspaces.prepareDependencies(key, opts),
    waitMs: DEPENDENCY_GATE_WAIT_S * 1000,
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
    sessionConfigRoot: path.join(home, SESSION_CONFIG_DIR),
    instanceTag,
    broker,
    scopeProcesses: {
      processes: () => probe.processes(),
      envValues: (pids, names) => probe.envValues(pids, names),
    },
    refreshDependencies: async (cwd) => {
      const key = await memberClones.keyOf(cwd);
      if (!key) {
        await worktrees.refreshDependencies(cwd);
        return;
      }
      return dependencyGate(key);
    },
    permissionTimeoutMs: options.permissionTimeoutMs ?? APP_DEFAULTS.permissionTimeoutMs,
    logger: log.child({ module: 'runner' }),
  });
  const runner = runnerModule.runner;

  const engine = createLocalEngine(
    {
      worktrees,
      memberWorkspaces,
      fullTestExecutor:
        modules.createFullTestExecutor?.({
          heavyLockDir,
          worktreesRoot: roots.worktrees,
          ...(roots.fullTestTmp ? { tmpDir: roots.fullTestTmp } : {}),
        }) ??
        createFullTestExecutor({
          logger: log.child({ module: 'full-test' }),
          env: agentEnv,
          heavyLockDir,
          worktreesRoot: roots.worktrees,
          ...(roots.fullTestTmp ? { tmpDir: roots.fullTestTmp } : {}),
        }),
      screenshotExecutor:
        modules.createScreenshotExecutor?.({ heavyLockDir }) ??
        createScreenshotExecutor({
          logger: log.child({ module: 'screenshots' }),
          env: agentEnv,
          heavyLockDir,
        }),
      // The work volume fills up apart from the home (PM-846): the smaller of the two guards admission.
      freeDiskBytes: async () =>
        roots.workRoot
          ? Math.min(await freeBytesOf(home), await freeBytesOf(roots.worktrees))
          : freeBytesOf(home),
      heavyRunSessions: () => readHeavyRunSessions(heavyLockDir),
      workspacePath: (projectKey) =>
        resolved.projects.find((entry) => entry.project === projectKey)?.workspacePath ?? null,
      // The engine's own binding (`engine.json`), never the cloud's paths (PM-451).
      repoPath: (projectKey, repo) =>
        resolved.repos.find((entry) => entry.project === projectKey && entry.repo === repo)?.path ?? null,
      appHome: home,
      userHome,
      worktreesRootDir: roots.worktrees,
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
  const dependencyPaths = engine.paths();
  workspaceDependencies = createWorkspaceDependencyInstaller({
    home,
    heavyLockDir,
    worktreesRoot: roots.worktrees,
    denyRead: [
      // Match the merge installer's home-wide denials; lifecycle scripts get only their clone.
      userHome,
      home,
      ...limit.sensitiveRead(),
      ...dependencyPaths.claudeTmpRoots,
      ...(dependencyPaths.sessionTmpRoot ? [path.dirname(dependencyPaths.sessionTmpRoot)] : []),
      ...(dependencyPaths.sessionFoldersRoot ? [path.dirname(dependencyPaths.sessionFoldersRoot)] : []),
      workspacesDir,
      roots.worktrees,
      path.join(home, 'workspace-deps'),
    ],
    setupOf: (project, repo) =>
      resolved.repos.find((entry) => entry.project === project && entry.repo === repo)?.workspaceSetup ??
      null,
    logger: log.child({ module: 'workspace-dependencies' }),
  });
  mkdirSync(exportDir, { recursive: true, mode: 0o700 });
  const administration: { port: AdministrationPort; target: AdministrationTarget } | undefined =
    options.administrationSocket
      ? {
          port: (modules.createAdministrationClient ?? ((socketPath) => createSocketClient({ socketPath })))(
            options.administrationSocket,
          ),
          target: { kind: 'engine', id: resolved.engineId },
        }
      : undefined;
  /** What this machine's supervisor says it can do now; none when it is absent, down or answers wrongly. */
  async function administrationCapabilities(): Promise<AdministrationCapability[] | undefined> {
    if (!administration) return undefined;
    try {
      const status = await Promise.race([
        administration.port.status(administration.target),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ADMINISTRATION_HELLO_WAIT_MS).unref()),
      ]);
      return status && status.online ? status.capabilities : undefined;
    } catch {
      return undefined;
    }
  }
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
    logger: log,
    mcpBase: baseUrl,
    emit,
    terminals,
    exportDir,
    nanogptStart,
    administration,
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
    const administrationAdvertised = await administrationCapabilities();
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
      processScope: 'process_group',
      instanceTag,
      pid: process.pid,
      uid,
      bootId,
      ...(administrationAdvertised ? { administration: administrationAdvertised } : {}),
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
      await workspaceDependencies?.close();
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
