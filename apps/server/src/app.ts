import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import type { Domain, ScheduleTimer, TemplateRegistry } from './domain';
import { createGithubService } from './github';
import { createMcpModule } from './mcp';
import { createRunnerModule } from './runner';
import { createWorktreeManager } from './worktree';
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
  createRunnerModule?: (opts: RunnerModuleOptions) => RunnerModule;
  createMcpModule?: (opts: McpModuleOptions) => McpModule;
  github?: GithubService;
  contextPackBuilder?: ContextPackBuilder;
  memberMemory?: MemberMemoryStore;
  worktrees?: WorktreeManager;
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
  scheduleTimer?: ScheduleTimer;
  doneCleanupDelayMs?: number;
  wsHeartbeatMs?: number;
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
  const home = resolve(options.home);
  for (const dir of [home, join(home, 'memory'), join(home, 'worktrees')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(home, 0o700);
  const publicBaseUrl = (options.publicBaseUrl ?? 'http://127.0.0.1:4700').replace(/\/+$/, '');
  const modules = options.modules ?? {};

  const logger = options.logger ?? { level: 'info' };
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
      worktreesRootDir: join(home, 'worktrees'),
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
    const auth = new AuthService({ repos, now: options.now });

    const webDistDir =
      options.webDistDir && existsSync(join(options.webDistDir, 'index.html'))
        ? resolve(options.webDistDir)
        : null;
    registerErrorHandling(app, { spaIndex: webDistDir !== null });
    registerAuth(app, { auth, domain });
    registerApiRoutes(app, domain);
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
