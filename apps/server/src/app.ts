import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXECUTION_PROFILES } from '@projectman/shared';
import type { ExecutionProfile } from '@projectman/shared';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { registerApiRoutes, registerErrorHandling } from './api';
import { AuthService, loadOrCreateSecret, registerAuth } from './auth';
import { serializeRequest } from './auth/request-logging';
import { createConfigStore } from './config';
import type { GitConfigStore } from './config';
import { createContextPackBuilder, createMemberMemoryStore } from './context';
import type {
  AttachmentStorage,
  BoundaryOperationAdapter,
  ContextPackBuilder,
  GithubPublisher,
  GithubService,
  ManagedVmBoundary,
  McpModule,
  McpModuleOptions,
  MemberMemoryStore,
  MemberWorkspaceManager,
  RunnerModule,
  RunnerModuleOptions,
  WorktreeManager,
} from './contracts';
import { createRepositories, openDatabase } from './db';
import type { Repositories } from './db';
import { createAttachmentStorage, createDomain } from './domain';
import type { Domain, ScheduleTimer, TemplateRegistry } from './domain';
import { createGithubPublisher, createGithubService, createTokenFileReader } from './github';
import { assertHomeMayStart } from './instance';
import { createMcpModule } from './mcp';
import { createReadinessBoundary, createRunnerModule } from './runner';
import { createMemberWorkspaceManager, createWorktreeManager } from './worktree';
import { registerWebsocket } from './ws';

/** Loopback addresses the server may listen on; remote access goes through `tailscale serve`. */
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export function isLoopbackHost(host: string): host is LoopbackHost {
  return (LOOPBACK_HOSTS as readonly string[]).includes(host);
}

/**
 * How the local agent CLIs reach the hooks and MCP endpoints of a server listening on this
 * loopback host. "localhost" listens on every address it resolves to, IPv4 included.
 */
export function loopbackBaseUrl(host: LoopbackHost, port: number): string {
  return `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}`;
}

/** Module factories and instances; each can be replaced (tests inject fakes). */
export interface AppModules {
  boundaryAdapter?: BoundaryOperationAdapter;
  /** The proof of the managed VM boundary (default: the readiness report, `vmReadinessReport`). */
  managedVmBoundary?: ManagedVmBoundary;
  createRunnerModule?: (opts: RunnerModuleOptions) => RunnerModule;
  createMcpModule?: (opts: McpModuleOptions) => McpModule;
  github?: GithubService;
  /** The VM's GitHub publishing identity (default: built from `githubPublishTokenFile`, else none). */
  githubPublisher?: GithubPublisher;
  contextPackBuilder?: ContextPackBuilder;
  memberMemory?: MemberMemoryStore;
  worktrees?: WorktreeManager;
  /** Member workspaces, used when `memberWorkspaces` is on (default: the git-backed manager). */
  memberWorkspaces?: MemberWorkspaceManager;
  templates?: TemplateRegistry;
  /** The files of task attachments (default: PROJECTMAN_HOME/attachments). */
  attachmentStorage?: AttachmentStorage;
}

/** Defaults of the server's options, including those index.ts reads from the environment. */
export const APP_DEFAULTS = {
  port: 4700,
  host: '127.0.0.1' satisfies LoopbackHost,
  claudeBin: 'claude',
  codexBin: 'codex',
  ghBin: 'gh',
  ghHost: 'github.com',
  logLevel: 'info',
  permissionTimeoutMs: 10 * 60_000,
  githubPollIntervalMs: 60_000,
} as const;

export interface BuildAppOptions {
  /** PROJECTMAN_HOME: database, customization repository, memory, worktrees, attachments, cookie secret. */
  home: string;
  /** How the agent CLIs reach this server (hooks, MCP); default: the default host and port. */
  publicBaseUrl?: string;
  /** Claude Code CLI (default "claude"). */
  claudeBin?: string;
  /** OpenAI Codex CLI (default "codex"). */
  codexBin?: string;
  /** Codex's home, where it keeps transcripts (default: the runner's, ~/.codex). */
  codexHome?: string;
  /** Claude Code's global config file, where workspace trust is recorded (default: ~/.claude.json). */
  claudeConfigPath?: string;
  /**
   * The environment the agent CLIs start with (the runner removes billing and host-session
   * variables); index.ts passes the server's. Default: the runner's own default.
   */
  agentEnv?: NodeJS.ProcessEnv;
  /** GitHub CLI (default "gh"). */
  ghBin?: string;
  /** Host whose `gh` login is checked (default "github.com"). */
  ghHost?: string;
  /** Pino options, or false; default: level "info". */
  logger?: FastifyServerOptions['logger'];
  /** Built web app served with an SPA fallback; null = API only. */
  webDistDir?: string | null;
  /** How long a permission request waits for a human (default 10 minutes). */
  permissionTimeoutMs?: number;
  /** How often linked pull requests are polled (default 1 minute). */
  githubPollIntervalMs?: number;
  /** Default `${home}/db.sqlite`; ":memory:" works too. */
  dbPath?: string;
  now?: () => Date;
  modules?: AppModules;
  planUsageTtlMs?: number;
  scheduleTimer?: ScheduleTimer;
  doneCleanupDelayMs?: number;
  wsHeartbeatMs?: number;
  /**
   * Durable member workspaces (PM-138, `${home}/workspaces/<PROJECT>/<handle>/<repo>`) in place of a
   * worktree per task. Off by default: switching the live instance over is its own decision (PM-143).
   */
  memberWorkspaces?: boolean;
  /**
   * The installation's execution profile (PM-141): `legacy` (default, the Mac as it always was) or
   * `managed_vm`, the owner's choice for the verified managed VM (docs/VM.md). It starts every
   * session question-free, but only while a verified boundary proves itself at that start; the
   * setting alone proves nothing. It needs member workspaces and a way to verify
   * (`vmReadinessReport`, or an injected boundary): otherwise the server does not start.
   */
  executionProfile?: ExecutionProfile;
  /** The readiness report of `deploy/vm/verify.sh` (a root-owned file) that proves the boundary. */
  vmReadinessReport?: string;
  /** How old that report may be (default one day). */
  vmReadinessMaxAgeMs?: number;
  /**
   * The file holding the VM's separate GitHub identity for publishing task branches (PM-142). Only
   * the managed VM profile accepts it, and only the service reads it: the token never reaches a
   * session. Without it (and without `modules.githubPublisher`) nothing is published.
   */
  githubPublishTokenFile?: string;
}

/** What `app.projectman` exposes (tests and tooling reach the services through it). */
export interface AppContext {
  home: string;
  repos: Repositories;
  configStore: GitConfigStore;
  domain: Domain;
  auth: AuthService;
  runnerModule: RunnerModule;
}

declare module 'fastify' {
  interface FastifyInstance {
    projectman: AppContext;
  }
}

/**
 * Composition root: Fastify (pino logger), cookie + websocket plugins, database, the
 * customization repository, every module (via its factory unless replaced in
 * `options.modules`), auth, REST routes, /ws, the runner's /hooks, the MCP /mcp routes and
 * optionally the built web app.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const modules = options.modules ?? {};
  // An installation that names a profile it cannot run is a start-up error, never a quiet fallback
  // to something else (PM-141): the managed VM needs member workspaces and a way to verify itself.
  const executionProfile = options.executionProfile ?? 'legacy';
  if (!(EXECUTION_PROFILES as readonly string[]).includes(executionProfile))
    throw new Error(`unknown execution profile: ${String(executionProfile)}`);
  let managedVm: ManagedVmBoundary | undefined;
  if (executionProfile === 'managed_vm') {
    if (!options.memberWorkspaces)
      throw new Error('execution profile managed_vm needs member workspaces (PROJECTMAN_WORKSPACES=member)');
    if (!modules.managedVmBoundary && !options.vmReadinessReport)
      throw new Error('execution profile managed_vm needs a readiness report to verify the boundary');
    managedVm =
      modules.managedVmBoundary ??
      createReadinessBoundary({
        reportPath: options.vmReadinessReport!,
        maxAgeMs: options.vmReadinessMaxAgeMs,
      });
  } else if (modules.managedVmBoundary || options.vmReadinessReport) {
    throw new Error('a VM readiness report is set, but the execution profile is not managed_vm');
  }
  // The publishing identity belongs to the managed VM alone (decision 26): elsewhere agents do not push.
  if (options.githubPublishTokenFile && executionProfile !== 'managed_vm')
    throw new Error('a GitHub publishing token is set, but the execution profile is not managed_vm');
  const home = resolve(options.home);
  // A retired copy never starts, a standby copy only shows its data (PM-143): checked before anything
  // in the home is created or opened.
  const standby = assertHomeMayStart(home) === 'standby';
  const attachmentsDir = join(home, 'attachments');
  for (const dir of [home, join(home, 'memory'), join(home, 'worktrees'), attachmentsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(home, 0o700);
  const publicBaseUrl = (
    options.publicBaseUrl ?? loopbackBaseUrl(APP_DEFAULTS.host, APP_DEFAULTS.port)
  ).replace(/\/+$/, '');

  const logger = options.logger ?? { level: APP_DEFAULTS.logLevel };
  const app = Fastify({
    logger:
      logger === false
        ? false
        : {
            ...(typeof logger === 'object' ? logger : {}),
            serializers: { ...(typeof logger === 'object' ? logger.serializers : {}), req: serializeRequest },
          },
    bodyLimit: 5 * 1024 * 1024,
  });
  let repos: Repositories | null = null;
  try {
    await app.register(fastifyCookie, { secret: loadOrCreateSecret(home) });
    await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

    repos = createRepositories(openDatabase(options.dbPath ?? join(home, 'db.sqlite')));
    const configStore = createConfigStore({
      rootDir: join(home, 'customization'),
      logger: app.log.child({ module: 'config' }),
    });
    await configStore.init();

    const log = app.log;
    const github =
      modules.github ??
      createGithubService({
        ghBin: options.ghBin ?? APP_DEFAULTS.ghBin,
        ghHost: options.ghHost ?? APP_DEFAULTS.ghHost,
        pollIntervalMs: options.githubPollIntervalMs ?? APP_DEFAULTS.githubPollIntervalMs,
        logger: log.child({ module: 'github' }),
      });
    // A second identity, with its own token and home: the poller above only reads and never holds it.
    const githubPublisher =
      modules.githubPublisher ??
      (options.githubPublishTokenFile
        ? createGithubPublisher({
            ghBin: options.ghBin ?? APP_DEFAULTS.ghBin,
            host: options.ghHost ?? APP_DEFAULTS.ghHost,
            stateDir: join(home, 'github-publish'),
            token: createTokenFileReader(resolve(options.githubPublishTokenFile)),
            logger: log.child({ module: 'github-publish' }),
          })
        : undefined);
    const contextBuilder = modules.contextPackBuilder ?? createContextPackBuilder();
    const memory = modules.memberMemory ?? createMemberMemoryStore({ rootDir: join(home, 'memory') });
    const worktrees =
      modules.worktrees ??
      createWorktreeManager({ rootDir: join(home, 'worktrees'), logger: log.child({ module: 'worktree' }) });
    const workspacesDir = join(home, 'workspaces');
    const memberWorkspaces = options.memberWorkspaces
      ? (modules.memberWorkspaces ??
        createMemberWorkspaceManager({ rootDir: workspacesDir, logger: log.child({ module: 'workspace' }) }))
      : undefined;
    const makeRunner = modules.createRunnerModule ?? createRunnerModule;
    const auth = new AuthService({ repos, now: options.now });

    const domain = createDomain({
      boundaryAdapter: modules.boundaryAdapter,
      repos,
      configStore,
      logger: log.child({ module: 'domain' }),
      publicBaseUrl,
      createRunner: (broker) =>
        makeRunner({
          claudeBin: options.claudeBin ?? APP_DEFAULTS.claudeBin,
          codexBin: options.codexBin ?? APP_DEFAULTS.codexBin,
          codexHome: options.codexHome,
          claudeConfigPath: options.claudeConfigPath,
          env: options.agentEnv,
          managedVm,
          publicBaseUrl,
          broker,
          permissionTimeoutMs: options.permissionTimeoutMs ?? APP_DEFAULTS.permissionTimeoutMs,
          logger: log.child({ module: 'runner' }),
        }),
      github,
      githubPublisher,
      contextBuilder,
      memory,
      worktrees,
      attachmentStorage: modules.attachmentStorage ?? createAttachmentStorage(attachmentsDir),
      accounts: auth,
      worktreesRootDir: join(home, 'worktrees'),
      memberWorkspaces,
      workspacesRootDir: workspacesDir,
      executionProfile,
      managedVm,
      standby,
      templates: modules.templates,
      now: options.now,
      scheduleTimer: options.scheduleTimer,
      planUsageTtlMs: options.planUsageTtlMs,
      doneCleanupDelayMs: options.doneCleanupDelayMs,
    });
    const mcpModule = (modules.createMcpModule ?? createMcpModule)({
      handler: domain.teamTools,
      // O(1) in-memory lookup: runs on every MCP request.
      resolveContext: (token) => domain.sessions.resolveToken(token),
      logger: log,
    });

    const webDistDir =
      options.webDistDir && existsSync(join(options.webDistDir, 'index.html'))
        ? resolve(options.webDistDir)
        : null;
    registerErrorHandling(app, { spaIndex: webDistDir !== null });
    registerAuth(app, { auth, domain });
    registerApiRoutes(app, { domain, auth });
    registerWebsocket(app, { domain, auth, heartbeatMs: options.wsHeartbeatMs });
    domain.runnerModule.registerHookRoutes(app);
    mcpModule.registerRoutes(app);
    if (webDistDir) await app.register(fastifyStatic, { root: webDistDir, index: ['index.html'] });

    app.decorate('projectman', {
      home,
      repos,
      configStore,
      domain,
      auth,
      runnerModule: domain.runnerModule,
    });

    app.addHook('onReady', async () => {
      await domain.start();
    });
    const db = repos.db;
    app.addHook('onClose', async () => {
      await domain.stop();
      try {
        await domain.runnerModule.runner.shutdown();
      } catch (err) {
        log.error({ err }, 'runner shutdown failed');
      }
      db.close();
    });
    return app;
  } catch (err) {
    repos?.db.close();
    await app.close().catch(() => undefined);
    throw err;
  }
}
