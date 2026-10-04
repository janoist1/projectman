import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTROL_SOCKET_NAME, EXECUTION_PROFILES } from '@projectman/shared';
import type { ExecutionProfile } from '@projectman/shared';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance, FastifyServerOptions } from 'fastify';
import { registerApiRoutes, registerErrorHandling } from './api';
import { AuthService, loadOrCreateSecret, registerAuth } from './auth';
import { serializeRequest } from './auth/request-logging';
import { createConfigStore } from './config';
import type { GitConfigStore } from './config';
import { startControlSocket } from './control';
import type { ControlPause, ControlSocket } from './control';
import { createContextPackBuilder, createMemberMemoryStore } from './context';
import type {
  AttachmentStorage,
  BoundaryOperationAdapter,
  ContextPackBuilder,
  FullTestExecutor,
  GithubPublisher,
  GithubService,
  ManagedVmBoundary,
  McpModule,
  McpModuleOptions,
  MemberMemoryStore,
  MachineProbe,
  MemberWorkspaceManager,
  RunnerModule,
  RunnerModuleOptions,
  RuntimeBoundary,
  TerminalMode,
  WorktreeManager,
} from './contracts';
import { createRepositories, openDatabase } from './db';
import type { Repositories } from './db';
import { createAttachmentStorage, createDomain, freeBytesOf } from './domain';
import type { Domain, ScheduleTimer, TemplateRegistry } from './domain';
import { createGithubPublisher, createGithubService, createTokenFileReader } from './github';
import { assertHomeMayStart } from './instance';
import { createMcpModule } from './mcp';
import { createReadinessBoundary, createRunnerModule, ManagedVmUnavailableError } from './runner';
import {
  createManagedEgressProxy,
  createRuntimeBoundary,
  createServiceBridges,
  disabledRuntimeBoundary,
  egressScopeTag,
  isManagedBoundary,
  openWorkerBridges,
  passwdAccounts,
} from './runtime-boundary';
import type { AccountLookup, BoundaryConfig } from './runtime-boundary';
import { createMemberWorkspaceManager, createWorktreeManager } from './worktree';
import { registerWebsocket } from './ws';

/** Loopback addresses the server may listen on; remote access goes through `tailscale serve`. */
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export function isLoopbackHost(host: string): host is LoopbackHost {
  return (LOOPBACK_HOSTS as readonly string[]).includes(host);
}

/** What `parseTerminalMode` checks before it allows sessions without a terminal (PM-267). */
export interface TerminalModeGuard {
  /** The raw PROJECTMAN_HOME. */
  home: string | undefined;
  /** The live instance's home (`~/.projectman`). */
  liveHome: string;
  /** CLAUDE_BIN. */
  claudeBin: string | undefined;
  /** CODEX_BIN. */
  codexBin: string | undefined;
  /** PROJECTMAN_BOUNDARY_CONFIG. */
  boundaryConfig: string | undefined;
  executionProfile: ExecutionProfile;
}

/**
 * PROJECTMAN_TERMINAL: `pty` (default) or `pipe`, which starts the CLIs without a terminal. `pipe` is
 * only for a development instance with the fake CLIs, so it is refused for the live home, without
 * both CLI paths set explicitly, with the managed VM boundary or the managed VM profile.
 */
export function parseTerminalMode(value: string | undefined, guard: TerminalModeGuard): TerminalMode {
  if (!value) return 'pty';
  if (value !== 'pty' && value !== 'pipe')
    throw new Error(`invalid PROJECTMAN_TERMINAL: ${value} (pty or pipe)`);
  if (value === 'pty') return 'pty';
  const liveHome = resolve(guard.liveHome);
  if (
    !guard.home ||
    resolve(guard.home) === liveHome ||
    !guard.claudeBin ||
    !guard.codexBin ||
    guard.boundaryConfig ||
    guard.executionProfile === 'managed_vm'
  )
    throw new Error(
      'PROJECTMAN_TERMINAL=pipe is only for development instances with the fake CLIs: set PROJECTMAN_HOME to a development home, CLAUDE_BIN and CODEX_BIN to the fake CLIs, and no managed VM setting',
    );
  return 'pipe';
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
  /** The VM boundary (default: from `runtimeBoundary` in the options, else none). Tests pass a fake. */
  runtimeBoundary?: RuntimeBoundary;
  /** The worker accounts of the boundary (default: /etc/passwd). */
  workerAccounts?: AccountLookup;
  /**
   * Makes the executor of the server's full test before review (PM-217). Default: none, so the feature
   * is off; `index.ts` passes the sandboxed one, except for the managed VM profile.
   */
  createFullTestExecutor?: (opts: { logger: FastifyBaseLogger }) => FullTestExecutor;
  /**
   * Makes what the machine display measures with (PM-320). Default: the operating system's; `index.ts`
   * passes the fixed-data probe of the screenshot mode, tests a fake.
   */
  createMachineProbe?: (opts: { runningPids: () => number[]; instanceTag: string }) => MachineProbe;
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
  shutdownPauseMs: 60_000,
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
  /** How the agent CLIs are started (default `pty`); `pipe` only through `parseTerminalMode` (PM-267). */
  terminal?: TerminalMode;
  /**
   * PROJECTMAN_CLIENT_IP_HEADER: the header the public entrance (e.g. `cf-connecting-ip` behind
   * Cloudflare) sets to the real client's address. Only the attempt limiters read it, and only
   * from a loopback peer (auth/local-request `clientAddress`). Default: none, the connection's
   * address counts.
   */
  clientIpHeader?: string;
  /** GitHub CLI (default "gh"). */
  ghBin?: string;
  /** Host whose `gh` login is checked (default "github.com"). */
  ghHost?: string;
  /** Pino options, or false; default: level "info". */
  logger?: FastifyServerOptions['logger'];
  /** Built web app served with an SPA fallback; null = API only. */
  webDistDir?: string | null;
  /** The checkout the server runs from: reading sessions never change it (PM-188). */
  installDir?: string;
  /**
   * The root of the session folders (PM-268): each Claude session gets its own writable folder
   * below it, for screenshots and other files its commands make. Absent (tests): no folders.
   */
  sessionFoldersDir?: string;
  /**
   * Playwright's browsers (PM-268), read-only for the members' commands in `PLAYWRIGHT_BROWSERS_PATH`.
   * Absent (tests): the variable is not set.
   */
  browsersDir?: string;
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
  doneTurnLimitMs?: number;
  /** The free bytes where the data is kept (default: `statfs` of `home`); null: not measurable (PM-243). */
  freeDiskBytes?: () => Promise<number | null>;
  wsHeartbeatMs?: number;
  /**
   * Durable member workspaces (PM-138, `${home}/workspaces/<PROJECT>/<handle>/<repo>`) in place of a
   * worktree per task. Off by default: switching the live instance over is its own decision (PM-143).
   */
  memberWorkspaces?: boolean;
  /**
   * The managed VM boundary (PM-140), from the root-owned boundary configuration the service unit
   * names. It only makes the server stricter: every session starts through the protected launcher
   * as its member's worker, workspaces live in worker homes, workers reach the network through the
   * egress proxy, and no session starts while the boundary is not ready. Needs `memberWorkspaces`.
   */
  runtimeBoundary?: BoundaryConfig;
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
  /**
   * How long stopping the server (a signal) lets the sessions come to a safe point before it closes
   * (PM-219): the team is paused first. Default `APP_DEFAULTS.shutdownPauseMs`; 0 switches the pause off.
   */
  shutdownPauseMs?: number;
  /** Opens `${home}/control.sock` for the control command (PM-219); default true, never for a standby copy. */
  controlSocket?: boolean;
}

/** What `app.projectman` exposes (tests and tooling reach the services through it). */
export interface AppContext {
  home: string;
  /** Pauses the team before the server closes (`shutdownPauseMs`); nothing when that is 0 or this is a standby copy. */
  pauseForShutdown: () => Promise<void>;
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
    // Question-free sessions only behind the VM boundary (PM-140): without it they would run as the
    // service itself. A test may inject its own proof instead.
    if (!modules.managedVmBoundary && !options.runtimeBoundary)
      throw new Error(
        'execution profile managed_vm needs the VM boundary configuration (PROJECTMAN_BOUNDARY_CONFIG)',
      );
    const reportPath = options.vmReadinessReport ?? options.runtimeBoundary?.readiness.report;
    if (!modules.managedVmBoundary && !reportPath)
      throw new Error('execution profile managed_vm needs a readiness report to verify the boundary');
    managedVm =
      modules.managedVmBoundary ??
      createReadinessBoundary({
        reportPath: reportPath!,
        maxAgeMs:
          options.vmReadinessMaxAgeMs ??
          (options.runtimeBoundary ? options.runtimeBoundary.readiness.maxAgeSeconds * 1000 : undefined),
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
  // The mark every session of this instance carries in its environment (PM-320): the first 16 hex digits
  // of the hash of the real home path, so a development and the live instance never claim each other's
  // processes, and a symlinked home gives the same tag.
  const instanceTag = createHash('sha256').update(realpathSync(home)).digest('hex').slice(0, 16);
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
    // The VM boundary (PM-140): fail closed. Its proxy is the workers' only way out; the status
    // reports it down until it listens, and no session starts meanwhile.
    const boundaryConfig = options.runtimeBoundary;
    if (boundaryConfig && !options.memberWorkspaces)
      throw new Error('the managed VM boundary needs member workspaces (PROJECTMAN_WORKSPACES=member)');
    let egressProxy: ReturnType<typeof createManagedEgressProxy> | null = null;
    const workerAccounts = modules.workerAccounts ?? passwdAccounts();
    // Each worker unit reaches the app and the proxy only through its member's bridge sockets.
    const bridges = boundaryConfig
      ? createServiceBridges({
          root: boundaryConfig.bridgeRoot,
          appPort: boundaryConfig.appPort,
          groupOf: (member) =>
            workerAccounts.byName(`${boundaryConfig.workers.prefix}${member}`)?.gid ?? null,
          onEgress: (socket, member) => {
            if (egressProxy?.listening()) egressProxy.acceptFrom(socket, member);
            else socket.destroy();
          },
          logger: log.child({ module: 'bridge' }),
        })
      : null;
    const runtimeBoundary: RuntimeBoundary =
      modules.runtimeBoundary ??
      (boundaryConfig
        ? createRuntimeBoundary({
            config: boundaryConfig,
            egressUp: () => egressProxy?.listening() ?? false,
            prepare: (member) => bridges!.ensure(member),
            serverSpool: join(home, 'spool'),
          })
        : disabledRuntimeBoundary(options.now));
    const managed = isManagedBoundary(runtimeBoundary) ? runtimeBoundary : null;
    // The question-free profile (PM-141) holds only while the boundary holds now: the report, and
    // the launcher and the egress proxy answering (PM-140), at every session start.
    const verifiedManagedVm: ManagedVmBoundary | undefined =
      managedVm && runtimeBoundary.mode === 'managed_vm'
        ? {
            async verify() {
              const attestation = await managedVm.verify();
              const status = await runtimeBoundary.status();
              if (!status.ready)
                throw new ManagedVmUnavailableError(
                  'not_ready',
                  'the VM boundary is not ready (readiness, launcher or egress proxy)',
                  { problems: status.problems },
                );
              return attestation;
            },
          }
        : managedVm;
    const workspacesDir = join(home, 'workspaces');
    const memberWorkspaces = options.memberWorkspaces
      ? (modules.memberWorkspaces ??
        createMemberWorkspaceManager({
          rootDir: workspacesDir,
          logger: log.child({ module: 'workspace' }),
          ...(managed ? { access: managed.workspaceAccess, rootFor: managed.workspacesRoot } : {}),
        }))
      : undefined;
    const makeRunner = modules.createRunnerModule ?? createRunnerModule;
    const auth = new AuthService({ repos, now: options.now });

    const domain = createDomain({
      runtimeBoundary,
      ...(boundaryConfig
        ? { egress: { base: boundaryConfig.egress.base, grantHours: boundaryConfig.egress.grantHours } }
        : {}),
      boundaryAdapter: modules.boundaryAdapter,
      fullTestExecutor: modules.createFullTestExecutor?.({ logger: log.child({ module: 'full-test' }) }),
      repos,
      configStore,
      logger: log.child({ module: 'domain' }),
      publicBaseUrl,
      instanceTag,
      machineProbe: modules.createMachineProbe
        ? ({ runningPids }) => modules.createMachineProbe!({ runningPids, instanceTag })
        : undefined,
      createRunner: (broker) =>
        makeRunner({
          claudeBin: options.claudeBin ?? APP_DEFAULTS.claudeBin,
          codexBin: options.codexBin ?? APP_DEFAULTS.codexBin,
          codexHome: options.codexHome,
          claudeConfigPath: options.claudeConfigPath,
          env: options.agentEnv,
          terminal: options.terminal,
          managedVm: verifiedManagedVm,
          publicBaseUrl,
          instanceTag,
          broker,
          permissionTimeoutMs: options.permissionTimeoutMs ?? APP_DEFAULTS.permissionTimeoutMs,
          logger: log.child({ module: 'runner' }),
          ...(runtimeBoundary.mode === 'managed_vm' && runtimeBoundary.launcher && runtimeBoundary.layout
            ? { launcher: runtimeBoundary.launcher, workerLayout: runtimeBoundary.layout }
            : {}),
        }),
      github,
      githubPublisher,
      contextBuilder,
      memory,
      worktrees,
      attachmentStorage: modules.attachmentStorage ?? createAttachmentStorage(attachmentsDir),
      accounts: auth,
      worktreesRootDir: join(home, 'worktrees'),
      appHome: home,
      installDir: options.installDir,
      sessionFoldersDir: options.sessionFoldersDir,
      browsersDir: options.browsersDir,
      memberWorkspaces,
      workspacesRootDir: workspacesDir,
      // Behind the boundary a session's pid is the launcher's (root's) process, and the launcher
      // stops every session whose service connection drops: none outlives a restart of the server.
      ...(runtimeBoundary.mode === 'managed_vm' ? { processExists: () => false } : {}),
      executionProfile,
      managedVm: verifiedManagedVm,
      standby,
      templates: modules.templates,
      now: options.now,
      scheduleTimer: options.scheduleTimer,
      planUsageTtlMs: options.planUsageTtlMs,
      doneCleanupDelayMs: options.doneCleanupDelayMs,
      doneTurnLimitMs: options.doneTurnLimitMs,
      freeDiskBytes: options.freeDiskBytes ?? (() => freeBytesOf(home)),
    });
    if (boundaryConfig) {
      const proxy = createManagedEgressProxy({
        config: boundaryConfig,
        logger: log.child({ module: 'egress' }),
        resolveToken: (token) => domain.sessions.resolveEgressToken(token),
        async authorize(identity, destination) {
          const decision = await domain.egress.authorize(identity, destination);
          if (!decision.allowed) return decision;
          // A session's tunnels carry its member's scope in its project, so they can be ended.
          const scope = identity.session
            ? [egressScopeTag(identity.session.projectKey, identity.member)]
            : [];
          return decision.via === 'allowance'
            ? { allowed: true, tags: [decision.allowanceId, ...scope], expiresAt: decision.expiresAt }
            : { allowed: true, tags: scope };
        },
      });
      // A revoked allowance ends its open tunnels too, not only new connections...
      domain.ctx.events.on('egress_allowance_revoked', (allowance) => {
        const closed = proxy.closeTagged(allowance.id);
        if (closed > 0)
          log.info({ allowanceId: allowance.id, closed }, 'closed egress tunnels of a revoked allowance');
      });
      // ... and so does a member who may no longer work in the project (removed, on leave, AI off).
      domain.ctx.events.on('egress_member_inactive', ({ projectKey, member }) => {
        const closed = proxy.closeTagged(egressScopeTag(projectKey, member), { remember: false });
        if (closed > 0)
          log.info({ projectKey, member, closed }, 'closed egress tunnels of an inactive member');
      });
      egressProxy = proxy;
    }
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
    const clientIpHeader = options.clientIpHeader;
    registerAuth(app, { auth, domain, clientIpHeader });
    registerApiRoutes(app, { domain, auth, clientIpHeader });
    registerWebsocket(app, { domain, auth, heartbeatMs: options.wsHeartbeatMs });
    domain.runnerModule.registerHookRoutes(app);
    mcpModule.registerRoutes(app);
    if (webDistDir) await app.register(fastifyStatic, { root: webDistDir, index: ['index.html'] });

    const shutdownPauseMs = options.shutdownPauseMs ?? APP_DEFAULTS.shutdownPauseMs;
    app.decorate('projectman', {
      home,
      pauseForShutdown: async () => {
        if (shutdownPauseMs <= 0 || standby) return;
        app.log.info(
          { seconds: Math.round(shutdownPauseMs / 1000) },
          'pausing the team before shutdown (up to this many seconds; press Ctrl-C again to skip)',
        );
        await domain.pauses.pauseForShutdown(shutdownPauseMs);
      },
      repos,
      configStore,
      domain,
      auth,
      runnerModule: domain.runnerModule,
    });

    // The deploy script pauses the instance over a local socket (PM-219); no person is behind it.
    const controlPause: ControlPause = {
      pause: async (request) => {
        await domain.pauses.pause({ scope: 'instance' }, { userId: null, source: 'control' }, request);
        return controlPause.status();
      },
      resume: async () => {
        await domain.pauses.resume({ scope: 'instance' }, { userId: null, source: 'control' });
        return controlPause.status();
      },
      force: async () => {
        await domain.pauses.force({ scope: 'instance' }, { userId: null, source: 'control' });
        return controlPause.status();
      },
      status: () =>
        domain.pauses.instanceView(
          domain.projects.summaries().map((project) => project.key),
          false,
        ).pause,
    };
    let controlSocket: ControlSocket | undefined;
    app.addHook('onReady', async () => {
      await domain.start();
      // A standby copy (PM-143) is paused by nobody: the active instance's socket is the one that counts.
      if ((options.controlSocket ?? true) && !standby) {
        controlSocket = await startControlSocket({
          path: join(home, CONTROL_SOCKET_NAME),
          pause: controlPause,
          log: log.child({ module: 'control' }),
        });
      }
      // A standby copy (PM-143) opens no way out for anyone: the proxy's port belongs to the active instance.
      if (egressProxy && !standby) {
        const proxy = egressProxy;
        await proxy.listen().catch((err: unknown) => log.error({ err }, 'the egress proxy could not listen'));
      }
      // Every worker's bridge from the start (PM-175): the readiness probe needs them before any session.
      if (bridges && boundaryConfig && !standby) {
        await openWorkerBridges({
          config: boundaryConfig,
          accounts: workerAccounts,
          bridges,
          logger: log.child({ module: 'bridge' }),
        });
      }
    });
    const db = repos.db;
    app.addHook('onClose', async () => {
      await controlSocket?.close();
      await egressProxy?.close();
      await bridges?.close();
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
