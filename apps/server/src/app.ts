import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { registerApiRoutes, registerErrorHandling } from './api';
import { AuthService, loadOrCreateSecret, registerAuth } from './auth';
import { createConfigStore } from './config';
import { createContextPackBuilder, createMemberMemoryStore } from './context';
import type {
  ConfigStore,
  ContextPackBuilder,
  GithubService,
  McpModule,
  McpModuleOptions,
  MemberMemoryStore,
  RunnerModule,
  RunnerModuleOptions,
  WorktreeManager,
} from './contracts';
import { createRepositories, openDatabase } from './db';
import type { Repositories } from './db';
import { createDomain } from './domain';
import type { Domain, TemplateRegistry } from './domain';
import { createGithubService } from './github';
import { createMcpModule } from './mcp';
import { createRunnerModule } from './runner';
import { createWorktreeManager } from './worktree';
import { registerWebsocket } from './ws';
import type { WebsocketHub } from './ws';

/** Module factories and instances; each can be replaced (tests inject fakes). */
export interface AppModules {
  createRunnerModule?: (opts: RunnerModuleOptions) => RunnerModule;
  createMcpModule?: (opts: McpModuleOptions) => McpModule;
  github?: GithubService;
  contextPackBuilder?: ContextPackBuilder;
  memberMemory?: MemberMemoryStore;
  worktrees?: WorktreeManager;
  configStore?: ConfigStore;
  templates?: TemplateRegistry;
}

export interface BuildAppOptions {
  /** PROJECTMAN_HOME: database, customization repository, memory, worktrees, cookie secret. */
  home: string;
  /** How the claude CLI reaches this server (hooks, MCP). Default http://127.0.0.1:4700. */
  publicBaseUrl?: string;
  /** Claude Code CLI (default "claude"). */
  claudeBin?: string;
  /** GitHub CLI (default "gh"). */
  ghBin?: string;
  logger?: FastifyServerOptions['logger'];
  /** Built web app served with an SPA fallback; null = API only. */
  webDistDir?: string | null;
  /** How long a permission request waits for a human (default 10 minutes). */
  permissionTimeoutMs?: number;
  githubPollIntervalMs?: number;
  /** Default `${home}/db.sqlite`; ":memory:" works too. */
  dbPath?: string;
  now?: () => Date;
  modules?: AppModules;
  planUsageTtlMs?: number;
  doneCleanupDelayMs?: number;
  wsHeartbeatMs?: number;
}

export interface AppContext {
  home: string;
  repos: Repositories;
  configStore: ConfigStore;
  domain: Domain;
  auth: AuthService;
  runnerModule: RunnerModule;
  mcpModule: McpModule;
  github: GithubService;
  websocket: WebsocketHub;
}

declare module 'fastify' {
  interface FastifyInstance {
    projectman: AppContext;
  }
}

function hasInit(store: ConfigStore): store is ConfigStore & { init(): Promise<void> } {
  return typeof (store as { init?: unknown }).init === 'function';
}

/**
 * Composition root: Fastify (pino logger), cookie + websocket plugins, database, the
 * customization repository, every module (via its factory unless replaced in
 * `options.modules`), auth, REST routes, /ws, the runner's /hooks, the MCP /mcp routes and
 * optionally the built web app.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const home = resolve(options.home);
  for (const dir of [home, join(home, 'logs'), join(home, 'memory'), join(home, 'worktrees')]) {
    mkdirSync(dir, { recursive: true });
  }
  const publicBaseUrl = (options.publicBaseUrl ?? 'http://127.0.0.1:4700').replace(/\/+$/, '');
  const modules = options.modules ?? {};

  const app = Fastify({ logger: options.logger ?? { level: 'info' }, bodyLimit: 5 * 1024 * 1024 });
  let repos: Repositories | null = null;
  try {
    await app.register(fastifyCookie, { secret: loadOrCreateSecret(home) });
    await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

    repos = createRepositories(openDatabase(options.dbPath ?? join(home, 'db.sqlite')));
    const configStore =
      modules.configStore ??
      createConfigStore({
        rootDir: join(home, 'customization'),
        logger: app.log.child({ module: 'config' }),
      });
    if (hasInit(configStore)) await configStore.init();

    const log = app.log;
    const github =
      modules.github ??
      createGithubService({
        ghBin: options.ghBin ?? 'gh',
        pollIntervalMs: options.githubPollIntervalMs ?? 60_000,
        logger: log.child({ module: 'github' }),
      });
    const contextBuilder = modules.contextPackBuilder ?? createContextPackBuilder();
    const memory = modules.memberMemory ?? createMemberMemoryStore({ rootDir: join(home, 'memory') });
    const worktrees =
      modules.worktrees ??
      createWorktreeManager({ rootDir: join(home, 'worktrees'), logger: log.child({ module: 'worktree' }) });
    const makeRunner = modules.createRunnerModule ?? createRunnerModule;

    const domain = createDomain({
      repos,
      configStore,
      logger: log.child({ module: 'domain' }),
      publicBaseUrl,
      createRunner: (broker) =>
        makeRunner({
          claudeBin: options.claudeBin ?? 'claude',
          publicBaseUrl,
          broker,
          permissionTimeoutMs: options.permissionTimeoutMs ?? 10 * 60_000,
          logger: log.child({ module: 'runner' }),
        }),
      github,
      contextBuilder,
      memory,
      worktrees,
      templates: modules.templates,
      now: options.now,
      planUsageTtlMs: options.planUsageTtlMs,
      doneCleanupDelayMs: options.doneCleanupDelayMs,
    });
    const mcpModule = (modules.createMcpModule ?? createMcpModule)({
      handler: domain.teamTools,
      // O(1) in-memory lookup: runs on every MCP request.
      resolveContext: (token) => domain.sessions.resolveToken(token),
      logger: log,
    });
    const auth = new AuthService({ repos, now: options.now });

    const webDistDir =
      options.webDistDir && existsSync(join(options.webDistDir, 'index.html'))
        ? resolve(options.webDistDir)
        : null;
    registerErrorHandling(app, { spaIndex: webDistDir !== null });
    registerAuth(app, { auth, domain });
    registerApiRoutes(app, domain);
    const websocket = registerWebsocket(app, { domain, heartbeatMs: options.wsHeartbeatMs });
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
      mcpModule,
      github,
      websocket,
    });

    app.addHook('onReady', async () => {
      await domain.start();
    });
    const db = repos.db;
    app.addHook('onClose', async () => {
      domain.stop();
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
