import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { HumanAccess, ProjectConfig } from '@projectman/shared';
import { buildApp } from '../../src/app';
import type { AppModules, BuildAppOptions } from '../../src/app';
import type { BoundaryOperationAdapter, RuntimeBoundary } from '../../src/contracts';
import { createTemplateRegistry, humanActor } from '../../src/domain';
import type { ScheduleTimer } from '../../src/domain';
import { createRunnerModule } from '../../src/runner';
import { FAKE_CLAUDE, FAKE_CODEX, FAKE_GEMINI, freePort } from '../../src/runner/test-helpers';
import {
  createFakeMcp,
  createFakeRunnerModule,
  FakeContextBuilder,
  FakeGithub,
  FakeMemoryStore,
  FakeWorktreeManager,
} from './fakes';
import type { FakeMcp, FakeRunner, FakeRunnerModule } from './fakes';
import { testTemplate } from './test-template';

export const OWNER_LOGIN = { name: 'Owner', email: 'owner@example.com', password: 'correct horse battery' };

export interface AppHarnessOptions {
  nanogptKeyCheck?: AppModules['nanogptKeyCheck'];
  boundaryAdapter?: BoundaryOperationAdapter;
  /** The VM boundary (PM-140); default: none. */
  runtimeBoundary?: RuntimeBoundary;
  webDistDir?: string;
  now?: () => Date;
  scheduleTimer?: ScheduleTimer;
  /** What the machine display measures with (PM-320); default: the real probe of the operating system. */
  machineProbe?: AppModules['createMachineProbe'];
  /** Modules that stay real instead of being replaced by the fakes the harness returns. */
  real?: { context?: boolean; memory?: boolean; worktrees?: boolean; mcp?: boolean; templates?: boolean };
  /** Further buildApp options. */
  app?: Pick<
    BuildAppOptions,
    | 'doneCleanupDelayMs'
    | 'doneTurnLimitMs'
    | 'clientIpHeader'
    | 'freeDiskBytes'
    | 'controlSocket'
    | 'shutdownPauseMs'
    | 'logger'
  >;
}

/**
 * The real runner driving the fake claude and codex CLIs (test/fixtures). The app listens on a
 * free loopback port, which their hooks and MCP calls reach; HOME, CODEX_HOME and the fake
 * CLIs' config and transcript locations point into the temp directory.
 */
export interface FakeCliOptions {
  runner: 'fake-cli';
  /**
   * Pre-accepts Claude Code's trust dialog for the whole temp directory. Real worktrees need it:
   * the fake CLI checks the worktree, while the runner trusts the main checkout.
   */
  trustAll?: boolean;
}

interface HarnessBase {
  app: FastifyInstance;
  /** PROJECTMAN_HOME, a temp directory that also holds the workspace. */
  home: string;
  /** An empty directory for project AR (see createProject). */
  workspace: string;
  mcp: FakeMcp;
  github: FakeGithub;
  contextBuilder: FakeContextBuilder;
  memory: FakeMemoryStore;
  worktrees: FakeWorktreeManager;
  close(): Promise<void>;
}

/** The fake runner the in-memory harness uses. */
export interface AppHarness extends HarnessBase {
  runnerModule: FakeRunnerModule;
  runner: FakeRunner;
}

export interface CliAppHarness extends HarnessBase {
  port: number;
  /** HOME of the fake CLIs. */
  userHome: string;
  /**
   * A server restart: the app closes (its sessions end) and starts again over the same home and
   * database, on the same port. `app` is the new instance afterwards.
   */
  restart(): Promise<void>;
}

/**
 * The whole server (buildApp) over a temp PROJECTMAN_HOME, with fakes for every external
 * module (except those listed in `real`); `runner: 'fake-cli'` runs the real runner against
 * the fake CLIs instead of the in-memory fake runner.
 */
export async function createAppHarness(opts?: AppHarnessOptions): Promise<AppHarness>;
export async function createAppHarness(opts: AppHarnessOptions & FakeCliOptions): Promise<CliAppHarness>;
export async function createAppHarness(
  opts: AppHarnessOptions & Partial<FakeCliOptions> = {},
): Promise<AppHarness | CliAppHarness> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pm-app-')));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const runnerModule = createFakeRunnerModule();
  const mcp = createFakeMcp();
  const github = new FakeGithub();
  const contextBuilder = new FakeContextBuilder();
  const memory = new FakeMemoryStore();
  const worktrees = new FakeWorktreeManager(join(home, 'worktrees'));
  const real = opts.real ?? {};
  const modules: AppModules = {
    nanogptKeyCheck: opts.nanogptKeyCheck,
    boundaryAdapter: opts.boundaryAdapter,
    runtimeBoundary: opts.runtimeBoundary,
    createRunnerModule: (o) => runnerModule.create(o),
    createMcpModule: real.mcp ? undefined : (o) => mcp.create(o),
    github,
    contextPackBuilder: real.context ? undefined : contextBuilder,
    memberMemory: real.memory ? undefined : memory,
    worktrees: real.worktrees ? undefined : worktrees,
    templates: real.templates ? undefined : createTemplateRegistry([testTemplate]),
    createMachineProbe: opts.machineProbe,
  };

  const cli = opts.runner === 'fake-cli';
  const userHome = join(home, 'user');
  const claudeConfig = join(userHome, '.claude.json');
  const codexHome = join(userHome, '.codex');
  const port = cli ? await freePort() : 0;
  if (cli) {
    mkdirSync(userHome);
    const projects = opts.trustAll ? { [home]: { hasTrustDialogAccepted: true } } : {};
    writeFileSync(claudeConfig, JSON.stringify({ numStartups: 1, projects }));
    // The fake CLIs read their locations from the environment they inherit.
    vi.stubEnv('HOME', userHome);
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('FAKE_CLAUDE_CONFIG_FILE', claudeConfig);
    vi.stubEnv('FAKE_CLAUDE_TRANSCRIPT_DIR', join(userHome, 'transcripts'));
    modules.createRunnerModule = (options) => {
      const module = createRunnerModule(options);
      // Plan usage would start `claude -p`; the fake CLIs have no plan.
      return { ...module, planUsage: { get: async () => null } };
    };
  }

  const launch = async (): Promise<FastifyInstance> => {
    const launched = await buildApp({
      home,
      now: opts.now,
      scheduleTimer: opts.scheduleTimer,
      logger: false,
      webDistDir: opts.webDistDir ?? null,
      planUsageTtlMs: 0,
      doneCleanupDelayMs: 0,
      // The tests must not depend on how full the disk they run on is.
      freeDiskBytes: async () => null,
      // Only the tests of the control command open the socket (PM-219).
      controlSocket: false,
      ...opts.app,
      ...(cli
        ? {
            claudeBin: FAKE_CLAUDE,
            codexBin: FAKE_CODEX,
            geminiBin: FAKE_GEMINI,
            geminiConfigDir: join(home, 'providers', 'gemini'),
            codexHome,
            claudeConfigPath: claudeConfig,
            publicBaseUrl: `http://127.0.0.1:${port}`,
          }
        : {}),
      modules,
    });
    if (cli) await launched.listen({ host: '127.0.0.1', port });
    else await launched.ready();
    return launched;
  };
  let app = await launch();

  const base: HarnessBase = {
    app,
    home,
    workspace,
    mcp,
    github,
    contextBuilder,
    memory,
    worktrees,
    async close() {
      try {
        await app.close();
      } finally {
        rmSync(home, { recursive: true, force: true });
        if (cli) vi.unstubAllEnvs();
      }
    },
  };
  if (!cli) return { ...base, runnerModule, runner: runnerModule.runner };
  const harness: CliAppHarness = {
    ...base,
    port,
    userHome,
    async restart() {
      await app.close();
      app = await launch();
      harness.app = app;
    },
  };
  return harness;
}

/** "name=value" of the response's first Set-Cookie header. */
export function cookieOf(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new Error('no set-cookie header');
  return raw.split(';')[0]!;
}

/** A request as the user with this login cookie (none: anonymous), with an optional JSON body. */
export function inject(
  app: FastifyInstance,
  method: NonNullable<InjectOptions['method']>,
  url: string,
  cookie?: string | null,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

/** First-run setup from localhost; returns the login cookie. */
export async function setupOwner(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: OWNER_LOGIN });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return cookieOf(res);
}

/** Creates project AR from the test template (workspace + one repo). */
export async function createProject(h: HarnessBase, cookie: string): Promise<void> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie },
    payload: {
      key: 'AR',
      name: 'acme',
      workspacePath: h.workspace,
      templateId: 'test',
      repos: [{ name: 'web', path: '.', github: 'acme/web' }],
    },
  });
  if (res.statusCode !== 201) throw new Error(`project creation failed: ${res.statusCode} ${res.body}`);
}

export interface HumanLogin {
  handle: string;
  /** Default "developer". */
  access?: HumanAccess;
  /** Default: none. */
  roles?: string[];
  /** Account and display name; default: the handle. */
  name?: string;
  /** Default `<handle>@example.test`. */
  email?: string;
  /** Project to join (default "AR"); null creates only the account. */
  projectKey?: string | null;
  /** Further changes in the same configuration commit. */
  adjust?: (draft: ProjectConfig) => void;
}

/**
 * A logged-in human member: an account (with the owner's password, which spares hashing) and,
 * in one configuration commit by the owner, the member. Returns the login cookie.
 */
export async function addHumanAndLogin(app: FastifyInstance, human: HumanLogin): Promise<string> {
  const { repos, domain } = app.projectman;
  const name = human.name ?? human.handle;
  const email = human.email ?? `${human.handle}@example.test`;
  repos.users.insert({
    id: `usr_${human.handle}`,
    name,
    email,
    passwordHash: repos.users.findByEmail(OWNER_LOGIN.email)!.passwordHash,
    createdAt: new Date().toISOString(),
  });
  const projectKey = human.projectKey === undefined ? 'AR' : human.projectKey;
  if (projectKey) {
    await domain.projects.update(projectKey, { actor: humanActor('owner'), author: OWNER_LOGIN }, (draft) => {
      draft.team.members.push({
        kind: 'human',
        handle: human.handle,
        displayName: name,
        email,
        access: human.access ?? 'developer',
        roles: human.roles ?? [],
      });
      human.adjust?.(draft);
      return `Add fictional member ${human.handle}`;
    });
  }
  const login = await inject(app, 'POST', routes.login(), null, { email, password: OWNER_LOGIN.password });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  return cookieOf(login);
}
