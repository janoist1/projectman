import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTROL_SOCKET_NAME } from '@projectman/shared';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance, FastifyServerOptions } from 'fastify';
import { registerApiRoutes } from './api';
import { registerErrorHandling } from './http';
import {
  AuthService,
  createSetupCode,
  deriveEmailLoginKey,
  loadOrCreateSecret,
  MAX_SETUP_CODE_FAILURES,
  registerAuth,
} from './auth';
import { serializeRequest } from './http';
import { createConfigStore, createOperatorKnowledgeStore } from './config';
import type { GitConfigStore } from './config';
import { startControlSocket } from './control';
import type { ControlPause, ControlRelease, ControlSocket } from './control';
import { createContextPackBuilder, createMemberMemoryStore } from './context';
import type {
  AttachmentStorage,
  MessageAttachmentStorage,
  BoundaryOperationAdapter,
  ContextPackBuilder,
  EmailCodeMailer,
  FullTestExecutor,
  ScreenshotExecutor,
  GithubService,
  McpModule,
  McpModuleOptions,
  MemberMemoryStore,
  OperatorKnowledgeStore,
  MachineProbe,
  MemberWorkspaceManager,
  RunnerModule,
  RunnerModuleOptions,
  TerminalMode,
  WorktreeManager,
} from './contracts';
import { createRepositories, openDatabase } from './db';
import type { Repositories } from './db';
import { createAttachmentStorage, createMessageAttachmentStorage } from './core/attachments';
import { createDomain } from './assembly';
import { createEventBus } from './core/base';
import { freeBytesOf } from './engine-host';
import { readHeavyRunSessions } from './full-test';
import type { Domain } from './assembly';
import type { ScheduleTimer } from './services/schedules';
import type { TemplateRegistry } from './core/base';
import { createGithubService } from './services/github';
import { parseFeedbackPublicUrl, registerFeedbackHostGuard } from './http';
import { assertHomeMayStart, RUN_MODES } from './instance';
import type { RunMode } from './instance';
import { createMcpModule } from './mcp';
import { createRunnerModule } from './runner';
import { createMachineProbe } from './machine';
import { createMemberWorkspaceManager, createWorktreeManager } from './worktree';
import { registerWebsocket } from './ws';
import { createCloudRemote, createEngineLinks, ENGINE_MAX_FRAME_BYTES } from './engine-link';
import type { EngineLinks } from './engine-link';
import { EngineRegistry } from './runtime/sessions';

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
}

/**
 * PROJECTMAN_TERMINAL: `pty` (default) or `pipe`, which starts the CLIs without a terminal. `pipe` is
 * only for a development instance with the fake CLIs, so it is refused for the live home, without
 * both CLI paths set explicitly.
 */
export function parseTerminalMode(value: string | undefined, guard: TerminalModeGuard): TerminalMode {
  if (!value) return 'pty';
  if (value !== 'pty' && value !== 'pipe')
    throw new Error(`invalid PROJECTMAN_TERMINAL: ${value} (pty or pipe)`);
  if (value === 'pty') return 'pty';
  const liveHome = resolve(guard.liveHome);
  if (!guard.home || resolve(guard.home) === liveHome || !guard.claudeBin || !guard.codexBin)
    throw new Error(
      'PROJECTMAN_TERMINAL=pipe is only for development instances with the fake CLIs: set PROJECTMAN_HOME to a development home, CLAUDE_BIN and CODEX_BIN to the fake CLIs',
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

/** `PROJECTMAN_MODE`: single (default), cloud (engine registry, PM-313) or engine (the engine process, PM-314). */
export function parseMode(value: string | undefined): RunMode {
  const mode = value?.trim() || 'single';
  if ((RUN_MODES as readonly string[]).includes(mode)) return mode as RunMode;
  throw new Error(`Invalid PROJECTMAN_MODE: ${mode} (${RUN_MODES.join(', ')})`);
}

/** Module factories and instances; each can be replaced (tests inject fakes). */
export interface AppModules {
  nanogptKeyCheck?: import('./runtime/usage').NanogptKeyCheck;
  boundaryAdapter?: BoundaryOperationAdapter;
  createRunnerModule?: (opts: RunnerModuleOptions) => RunnerModule;
  createMcpModule?: (opts: McpModuleOptions) => McpModule;
  github?: GithubService;
  contextPackBuilder?: ContextPackBuilder;
  memberMemory?: MemberMemoryStore;
  operatorKnowledge?: OperatorKnowledgeStore;
  worktrees?: WorktreeManager;
  /** Member workspaces, used when `memberWorkspaces` is on (default: the git-backed manager). */
  memberWorkspaces?: MemberWorkspaceManager;
  templates?: TemplateRegistry;
  /** The files of task attachments (default: PROJECTMAN_HOME/attachments). */
  attachmentStorage?: AttachmentStorage;
  /** The files of team message attachments (default: PROJECTMAN_HOME/message-attachments). */
  messageAttachmentStorage?: MessageAttachmentStorage;
  /**
   * Makes the executor of the server's full test before review (PM-217). Default: none, so the feature
   * is off; `index.ts` passes the sandboxed one.
   */
  createFullTestExecutor?: (opts: { logger: FastifyBaseLogger }) => FullTestExecutor;
  /**
   * Makes the executor of the screenshot runs of the Codex members (PM-351), in the same sandbox and the
   * same heavy-run queue as the full test. Default: none, so `take_screenshots` is refused.
   */
  createScreenshotExecutor?: (opts: { logger: FastifyBaseLogger }) => ScreenshotExecutor;
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
  engineMode?: 'single' | 'cloud';
  /** Tests: the cloud mode's setup code instead of a random one (PM-317). */
  setupCode?: string;
  appVersion?: string;
  /** The release tag on the running build's commit (`createAppTagReader`, PM-542); absent: no tag known. */
  appTag?: () => Promise<string | null>;
  /**
   * The project and repository that are this instance itself (`PROJECTMAN_RELEASE_TARGET`, PM-491):
   * its releases are proposed, approved and deployed. Absent: releases are off.
   */
  releaseTarget?: { projectKey: string; repo: string };
  /**
   * Delivers the one-time e-mail login code (PM-669). Absent: the e-mail login is off (PM-670).
   */
  emailCodeMailer?: EmailCodeMailer;
  /** PROJECTMAN_HOME: database, customization repository, memory, worktrees, attachments, cookie secret. */
  home: string;
  /** How the agent CLIs reach this server (hooks, MCP); default: the default host and port. */
  publicBaseUrl?: string;
  /** Claude Code CLI (default "claude"). */
  claudeBin?: string;
  /** PM-332: clone node_modules into new task worktrees from an installed checkout (default false; index.ts turns it on). */
  cloneDependencies?: boolean;
  /** OpenAI Codex CLI (default "codex"). */
  codexBin?: string;
  /** Codex's home, where it keeps transcripts (default: the runner's, ~/.codex). */
  codexHome?: string;
  geminiBin?: string;
  geminiConfigDir?: string;
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
   * from a loopback peer (kernel/local-request `clientAddress`). Default: none, the connection's
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
   * The root of the Codex and Claude sessions' own temporary directories (PM-339, PM-353), a short
   * path. Absent (tests): these sessions get no folder.
   */
  sessionTmpDir?: string;
  /** The base of Claude Code's shared temporary root (`CLAUDE_CODE_TMPDIR` of the server's environment, PM-353). */
  claudeTmpBase?: string;
  /** Explicit engine roots for isolated tests; otherwise discovered on the local machine. */
  claudeTmpRoots?: readonly string[];
  /**
   * Playwright's browsers (PM-268), read-only for the members' commands in `PLAYWRIGHT_BROWSERS_PATH`.
   * Absent (tests): the variable is not set.
   */
  browsersDir?: string;
  /**
   * The machine's heavy-run queue folder (PM-332, `full-test/heavy-lock.ts`): the members' sandboxes may
   * write its parent and name it in `PROJECTMAN_HEAVY_LOCK_DIR`. Absent (tests): neither.
   */
  heavyLockDir?: string;
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
  /** Tests: false sends every AI question to the people at once instead of the Operator's screening (PM-558). */
  screenQuestions?: boolean;
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
   * The public address of the feedback widget's entrance (PROJECTMAN_FEEDBACK_PUBLIC_URL, PM-506), when
   * the installation has one; the settings view shows it. Absent: the settings say there is none.
   */
  feedbackPublicUrl?: string;
  /** The built feedback widget (apps/feedback-widget/dist/widget.js, PM-509); null or missing: its route answers 404. */
  feedbackWidgetFile?: string | null;
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
  engineRegistry?: EngineRegistry;
  engineLinks?: EngineLinks;
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
  const home = resolve(options.home);
  // A retired copy never starts, a standby copy only shows its data (PM-143): checked before anything
  // in the home is created or opened.
  const standby = assertHomeMayStart(home, options.engineMode ?? 'single') === 'standby';
  const attachmentsDir = join(home, 'attachments');
  const feedbackDir = join(home, 'feedback');
  const messageAttachmentsDir = join(home, 'message-attachments');
  for (const dir of [
    home,
    join(home, 'memory'),
    join(home, 'worktrees'),
    attachmentsDir,
    feedbackDir,
    messageAttachmentsDir,
  ]) {
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
    // The widget's public hostname serves only its own paths (PM-513). Registered first, so it runs
    // before the cookie, auth and every other hook, and a bad address stops the start.
    if (options.feedbackPublicUrl)
      registerFeedbackHostGuard(app, parseFeedbackPublicUrl(options.feedbackPublicUrl));
    const secret = loadOrCreateSecret(home);
    await app.register(fastifyCookie, { secret });
    await app.register(fastifyWebsocket, {
      options: { maxPayload: options.engineMode === 'cloud' ? ENGINE_MAX_FRAME_BYTES : 1024 * 1024 },
    });

    repos = createRepositories(openDatabase(options.dbPath ?? join(home, 'db.sqlite')));
    const configStore = createConfigStore({
      rootDir: join(home, 'customization'),
      logger: app.log.child({ module: 'config' }),
    });
    await configStore.init();

    const log = app.log;
    // Cloud mode (PM-315): the machine's work (sessions, worktrees, gh, the full test, screenshots, the
    // machine display) is the connected engine's. The registry, the links and the remote parts exist
    // before the domain, which takes them as its engines, runner and probes; the bus is made here too
    // because the registry publishes on it.
    const cloudBus =
      options.engineMode === 'cloud' ? createEventBus(log.child({ module: 'events' })) : undefined;
    const engineRegistry = cloudBus
      ? new EngineRegistry({
          repos,
          bus: cloudBus,
          version: options.appVersion ?? 'dev',
          now: options.now,
        })
      : undefined;
    const clientIpHeader = options.clientIpHeader;
    const engineLinks = engineRegistry
      ? createEngineLinks({
          registry: engineRegistry,
          clientIpHeader,
          now: options.now ? () => options.now!().getTime() : undefined,
        })
      : undefined;
    const remote =
      engineRegistry && engineLinks
        ? createCloudRemote({
            links: engineLinks,
            registry: engineRegistry,
            recordedEngine: (sessionId) => repos!.sessions.get(sessionId)?.engineId ?? null,
            spoolDir: join(home, 'engine-spool'),
            logger: log.child({ module: 'engine-remote' }),
            now: options.now ? () => options.now!().getTime() : undefined,
          })
        : undefined;
    const github =
      modules.github ??
      remote?.github ??
      createGithubService({
        ghBin: options.ghBin ?? APP_DEFAULTS.ghBin,
        ghHost: options.ghHost ?? APP_DEFAULTS.ghHost,
        pollIntervalMs: options.githubPollIntervalMs ?? APP_DEFAULTS.githubPollIntervalMs,
        logger: log.child({ module: 'github' }),
      });
    const contextBuilder = modules.contextPackBuilder ?? createContextPackBuilder();
    const memory = modules.memberMemory ?? createMemberMemoryStore({ rootDir: join(home, 'memory') });
    const worktrees =
      modules.worktrees ??
      createWorktreeManager({
        rootDir: join(home, 'worktrees'),
        logger: log.child({ module: 'worktree' }),
        cloneDependencies: options.cloneDependencies ?? false,
      });
    const workspacesDir = join(home, 'workspaces');
    const memberWorkspaces = options.memberWorkspaces
      ? (modules.memberWorkspaces ??
        createMemberWorkspaceManager({
          rootDir: workspacesDir,
          logger: log.child({ module: 'workspace' }),
        }))
      : undefined;
    const makeRunner = modules.createRunnerModule ?? createRunnerModule;
    let scopeProbe: MachineProbe | undefined;
    const auth = new AuthService({ repos, now: options.now });

    const domain = createDomain({
      appVersion: options.appVersion ?? 'dev',
      ...(options.appTag ? { appTag: options.appTag } : {}),
      ...(options.releaseTarget ? { releaseTarget: options.releaseTarget } : {}),
      engineName: (id) => engineRegistry?.list().find((engine) => engine.id === id)?.name ?? null,
      boundaryAdapter: modules.boundaryAdapter,
      nanogptKeyCheck: modules.nanogptKeyCheck,
      fullTestExecutor: remote
        ? undefined
        : modules.createFullTestExecutor?.({ logger: log.child({ module: 'full-test' }) }),
      screenshotExecutor: remote
        ? undefined
        : modules.createScreenshotExecutor?.({
            logger: log.child({ module: 'screenshots' }),
          }),
      repos,
      configStore,
      logger: log.child({ module: 'domain' }),
      publicBaseUrl,
      instanceTag,
      ...(remote
        ? {
            bus: cloudBus,
            engines: remote.directory,
            engineAttachments: remote.attachments,
            machineEngine: remote.machineProbe,
          }
        : {}),
      machineProbe: remote
        ? () => remote.machineProbe
        : ({ runningPids }) =>
            (scopeProbe = modules.createMachineProbe?.({ runningPids, instanceTag }) ?? createMachineProbe()),
      createRunner: (broker, nanogptKey) =>
        remote
          ? remote.createRunnerModule(broker, nanogptKey)
          : makeRunner({
              claudeBin: options.claudeBin ?? APP_DEFAULTS.claudeBin,
              codexBin: options.codexBin ?? APP_DEFAULTS.codexBin,
              codexHome: options.codexHome,
              nanogptCodexHome: join(home, 'providers', 'nanogpt', 'codex-home'),
              nanogptKey,
              geminiBin: options.geminiBin,
              geminiConfigDir: options.geminiConfigDir,
              claudeConfigPath: options.claudeConfigPath,
              env: options.agentEnv,
              terminal: options.terminal,
              publicBaseUrl,
              instanceTag,
              scopeProcesses: {
                processes: () => scopeProbe?.processes() ?? Promise.resolve(null),
                envValues: (pids, names) => scopeProbe?.envValues(pids, names) ?? Promise.resolve(new Map()),
              },
              broker,
              refreshDependencies: (cwd) => worktrees.refreshDependencies(cwd).then(() => undefined),
              permissionTimeoutMs: options.permissionTimeoutMs ?? APP_DEFAULTS.permissionTimeoutMs,
              logger: log.child({ module: 'runner' }),
            }),
      github,
      contextBuilder,
      memory,
      operatorKnowledge:
        modules.operatorKnowledge ?? createOperatorKnowledgeStore({ rootDir: join(home, 'operator-data') }),
      worktrees,
      attachmentStorage: modules.attachmentStorage ?? createAttachmentStorage(attachmentsDir),
      feedbackDir,
      feedbackPublicUrl: options.feedbackPublicUrl ?? null,
      messageAttachmentStorage:
        modules.messageAttachmentStorage ?? createMessageAttachmentStorage(messageAttachmentsDir),
      accounts: auth,
      ...(options.emailCodeMailer
        ? { emailCodeMailer: options.emailCodeMailer, emailLoginKey: deriveEmailLoginKey(secret) }
        : {}),
      worktreesRootDir: join(home, 'worktrees'),
      appHome: home,
      installDir: options.installDir,
      sessionFoldersDir: options.sessionFoldersDir,
      sessionTmpDir: options.sessionTmpDir,
      claudeTmpBase: options.claudeTmpBase,
      claudeTmpRoots: options.claudeTmpRoots,
      browsersDir: options.browsersDir,
      heavyLockDir: options.heavyLockDir,
      memberWorkspaces,
      workspacesRootDir: workspacesDir,
      standby,
      templates: modules.templates,
      now: options.now,
      scheduleTimer: options.scheduleTimer,
      planUsageTtlMs: options.planUsageTtlMs,
      doneCleanupDelayMs: options.doneCleanupDelayMs,
      ...(options.screenQuestions !== undefined ? { screenQuestions: options.screenQuestions } : {}),
      doneTurnLimitMs: options.doneTurnLimitMs,
      freeDiskBytes: options.freeDiskBytes ?? (() => freeBytesOf(home)),
      heavyRunSessions: options.heavyLockDir ? () => readHeavyRunSessions(options.heavyLockDir!) : undefined,
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
    // The first setup from a non-local request needs a one-time code from this log (PM-317).
    const setupCode =
      options.engineMode === 'cloud' && auth.needsSetup()
        ? createSetupCode({ code: options.setupCode })
        : undefined;
    if (setupCode)
      log.warn(
        `the first setup needs the setup code ${setupCode.value}; enter it on the setup page (it is void after ${MAX_SETUP_CODE_FAILURES} wrong tries or a restart)`,
      );
    registerAuth(app, {
      auth,
      domain,
      clientIpHeader,
      cloud: options.engineMode === 'cloud',
      setupCode,
      emailLogin: domain.emailLogin,
    });
    // The remote parts that need the domain, and what the engine's settings view counts.
    remote?.bind(domain, app);
    engineRegistry?.useCounters((id) => domain.engineCounters(id));
    engineLinks?.register(app);
    remote?.transfers.register(app);
    registerApiRoutes(app, {
      domain,
      auth,
      clientIpHeader,
      engineRegistry,
      feedbackWidgetFile: options.feedbackWidgetFile,
    });
    registerWebsocket(app, { domain, auth, heartbeatMs: options.wsHeartbeatMs });
    domain.runnerModule.registerHookRoutes(app);
    mcpModule.registerRoutes(app);
    if (webDistDir) await app.register(fastifyStatic, { root: webDistDir, index: ['index.html'] });

    const shutdownPauseMs = options.shutdownPauseMs ?? APP_DEFAULTS.shutdownPauseMs;
    app.decorate('projectman', {
      engineRegistry,
      engineLinks,
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
    // The release watcher (PM-493) reads the approved release and reports on the same socket.
    const controlRelease: ControlRelease = {
      appVersion: () => domain.releases.appVersion(),
      next: () => domain.releases.next(),
      claim: (releaseId, previousCommit) => domain.releases.claim(releaseId, previousCommit),
      report: (releaseId, report) => domain.releases.report(releaseId, report),
    };
    let controlSocket: ControlSocket | undefined;
    app.addHook('onReady', async () => {
      await domain.start();
      // A standby copy (PM-143) is paused by nobody: the active instance's socket is the one that counts.
      if ((options.controlSocket ?? true) && !standby) {
        controlSocket = await startControlSocket({
          path: join(home, CONTROL_SOCKET_NAME),
          pause: controlPause,
          release: controlRelease,
          log: log.child({ module: 'control' }),
        });
      }
    });
    const db = repos.db;
    app.addHook('onClose', async () => {
      await controlSocket?.close();
      // The team is paused over the links that are up; none waits for an engine that is not.
      remote?.stopWaiting();
      await domain.stop();
      remote?.close();
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
