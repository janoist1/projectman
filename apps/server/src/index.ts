import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExecutionProfile } from '@projectman/shared';
import { APP_DEFAULTS, buildApp, isLoopbackHost, loopbackBaseUrl, parseMode, parseTerminalMode } from './app';
import type { BuildAppOptions, LoopbackHost, RunMode } from './app';
import { assertEngineProfile, buildEngineApp, ENGINE_DEFAULT_PORT } from './engine-app';
import { defaultSessionTmpRoot } from './engine-host';
import { createFullTestExecutor, createScreenshotExecutor, defaultHeavyLockDir } from './full-test';
import { createFixtureProbe, parseMachineFixture } from './machine';
import { loadBoundaryConfig } from './runtime-boundary';
import { createShutdown } from './shutdown';
import { createNanogptKeyCheck } from './domain';
import { resolveAppVersion } from './engine-link';
import { EngineConfigError } from './engine-link/engine-config';

/**
 * Server entry point. The environment is read here, once, into the app's options (defaults:
 * APP_DEFAULTS in app.ts and the modules' own):
 *   PORT (4700), HOST (127.0.0.1; loopback only), PROJECTMAN_HOME (~/.projectman),
 *   CLAUDE_BIN (claude), CODEX_BIN (codex), GH_BIN (gh), LOG_LEVEL (info),
 *   CODEX_HOME (~/.codex): where the runner reads Codex's transcripts and plan usage,
 *   CLAUDE_CONFIG_DIR (~): where the runner finds Claude Code's .claude.json (workspace trust),
 *   GH_HOST (github.com): the host whose `gh` login the GitHub module checks,
 *   PROJECTMAN_BROWSERS_PATH (<home>/browsers): Playwright's browsers (PM-268, docs/DEPLOY.md), which
 *   the members' sandboxed commands read and never write, in PLAYWRIGHT_BROWSERS_PATH.
 *   PROJECTMAN_HEAVY_LOCK_DIR (/tmp/projectman-<uid>/heavy): the machine's heavy-run queue (PM-332),
 *   shared by the members' sandboxes, the server's full test and `npm run heavy`.
 *   PROJECTMAN_WORKSPACES (task_worktree): `member` gives every AI member a durable workspace per
 *   repository (PM-138) instead of a worktree per task.
 *   PROJECTMAN_BOUNDARY_CONFIG (unset): the managed VM's boundary configuration
 *   (/etc/projectman/boundary.json, PM-140); sessions then start only through the protected
 *   launcher, as their members' worker accounts, while the boundary is ready.
 *   PROJECTMAN_EXECUTION_PROFILE (legacy): `managed_vm` is the owner's choice for the verified managed
 *   VM (PM-141, docs/VM.md): sessions run question-free in the member's workspace, but only behind
 *   the VM boundary (PROJECTMAN_BOUNDARY_CONFIG is required) and only while its readiness report
 *   (PROJECTMAN_VM_READINESS_REPORT, default: the boundary configuration's; at most
 *   PROJECTMAN_VM_REPORT_MAX_AGE_MINUTES old, default: the configuration's limit) proves the
 *   boundary at the start. It needs PROJECTMAN_WORKSPACES=member; an unknown or conflicting
 *   setting stops the server. The CLIs never see these variables.
 *   PROJECTMAN_GITHUB_PUBLISH_TOKEN_FILE: the VM's separate GitHub identity for publishing task
 *   branches (PM-142, docs/GITHUB.md): a file only the service can read, holding that identity's token.
 *   Only the managed VM profile accepts it; without it nothing is published.
 *   PROJECTMAN_TERMINAL (pty): `pipe` starts the agent CLIs with pipes instead of a pseudo-terminal
 *   (PM-267), for a development instance whose sandbox has no PTY, with the fake CLIs. The real
 *   `claude` and `codex` are not interactive without a terminal, so it needs PROJECTMAN_HOME set to
 *   a development home, CLAUDE_BIN and CODEX_BIN set, no boundary configuration and no managed VM profile.
 *   PROJECTMAN_CLIENT_IP_HEADER (unset): the header the public entrance sets to the real client's
 *   address (`cf-connecting-ip` behind Cloudflare, PM-211, docs/DEPLOY.md). The login and invitation
 *   limiters then count per that address instead of the proxy's, but only for requests from
 *   loopback whose header holds exactly one IP; unset (and always behind `tailscale serve`, which
 *   sets no such header) the connection's address counts. X-Forwarded-For is never read.
 *   PROJECTMAN_MACHINE_FIXTURE (unset): the JSON of a fixed machine (PM-320, docs/SCREENSHOTS.md): the
 *   machine display then shows it instead of the real machine and never signals a process. For
 *   the screenshots of a disposable instance only; the server logs a warning when it is set.
 *   PROJECTMAN_SHUTDOWN_PAUSE_MS (60000): how long stopping the server (SIGTERM, SIGINT) lets the
 *   sessions come to a safe point before it closes (PM-219); 0 turns the pause off. The service unit's
 *   TimeoutStopSec must exceed it by about 20 seconds.
 *   PROJECTMAN_CLONE_DEPENDENCIES (on): `off` stops cloning node_modules into task worktrees from an
 *   installed checkout with the same lockfile (PM-332, APFS clones on macOS); any other value stops the server.
 *   PROJECTMAN_MODE (single): `cloud` enables the engine registry and authenticated engine link (PM-313).
 *   In cloud mode the sessions, worktrees, gh, full test and screenshots run on the connected engine
 *   (PM-315); the server keeps no machine of its own. `engine` starts the engine process on the
 *   machine the work happens on (PM-314, `npm run engine -- start`): no database, no web app and no
 *   `/api`, only a loopback listener for the CLIs' hooks and team tools and one outbound link to the cloud.
 *   Its settings are `<home>/engine.json` (`npm run engine -- init`); it refuses the managed VM profile.
 *   PROJECTMAN_ENGINE_PORT (4801): the engine's loopback port (engine mode only).
 *   PROJECTMAN_VERSION (unset): shared cloud/engine version; otherwise the installation git HEAD, then dev.
 * The agent CLIs start with this environment, minus billing and host-session variables (the
 * runner removes them); the git and gh commands the server runs inherit it.
 * Remote access goes through Tailscale (`tailscale serve`), not by binding publicly.
 */

interface ServerConfig {
  port: number;
  host: LoopbackHost;
  app: BuildAppOptions;
  /** The machine display shows fixed data (PROJECTMAN_MACHINE_FIXTURE), not the machine. */
  machineFixture: boolean;
}

async function configFromEnv(
  env: NodeJS.ProcessEnv,
  engineMode: Exclude<RunMode, 'engine'>,
): Promise<ServerConfig> {
  const port = Number.parseInt(env.PORT ?? String(APP_DEFAULTS.port), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid PORT: ${env.PORT}`);
  const host = env.HOST ?? APP_DEFAULTS.host;
  if (!isLoopbackHost(host))
    throw new Error('HOST must be loopback; use an HTTPS reverse proxy for remote access');
  const workspaces = env.PROJECTMAN_WORKSPACES || 'task_worktree';
  if (workspaces !== 'task_worktree' && workspaces !== 'member')
    throw new Error(`invalid PROJECTMAN_WORKSPACES: ${workspaces} (task_worktree or member)`);
  // The managed VM boundary: a root-owned file the service unit names. Unreadable or invalid, the
  // server does not start (it never falls back to running sessions itself).
  const boundaryFile = env.PROJECTMAN_BOUNDARY_CONFIG || undefined;
  const runtimeBoundary = boundaryFile ? loadBoundaryConfig(boundaryFile) : undefined;
  // The owner's installation profile (PM-141): an unknown value stops the start. `managed_vm` is
  // proven by the readiness report at every session start, so this setting alone changes nothing.
  const executionProfile = parseExecutionProfile(env.PROJECTMAN_EXECUTION_PROFILE);
  const reportMinutes = Number.parseInt(env.PROJECTMAN_VM_REPORT_MAX_AGE_MINUTES ?? '', 10);
  if (env.PROJECTMAN_VM_REPORT_MAX_AGE_MINUTES && !(reportMinutes > 0))
    throw new Error(
      `invalid PROJECTMAN_VM_REPORT_MAX_AGE_MINUTES: ${env.PROJECTMAN_VM_REPORT_MAX_AGE_MINUTES}`,
    );
  // The header a trusted entrance sets to the client's address; a header name, and never the
  // forgeable X-Forwarded-For chain.
  const clientIpHeader = env.PROJECTMAN_CLIENT_IP_HEADER?.trim().toLowerCase() || undefined;
  if (clientIpHeader && (!/^[a-z0-9-]+$/.test(clientIpHeader) || clientIpHeader === 'x-forwarded-for'))
    throw new Error(
      `invalid PROJECTMAN_CLIENT_IP_HEADER: ${env.PROJECTMAN_CLIENT_IP_HEADER} (one header name, not x-forwarded-for)`,
    );
  // How long stopping the server lets the sessions come to a safe point (PM-219); 0 is off.
  const shutdownPauseMs = env.PROJECTMAN_SHUTDOWN_PAUSE_MS
    ? Number(env.PROJECTMAN_SHUTDOWN_PAUSE_MS)
    : undefined;
  if (shutdownPauseMs !== undefined && !(Number.isInteger(shutdownPauseMs) && shutdownPauseMs >= 0))
    throw new Error(
      `invalid PROJECTMAN_SHUTDOWN_PAUSE_MS: ${env.PROJECTMAN_SHUTDOWN_PAUSE_MS} (milliseconds; 0 turns it off)`,
    );
  // Cloning node_modules into task worktrees (PM-332): on unless turned off; anything else stops the start.
  const cloneDependencies = env.PROJECTMAN_CLONE_DEPENDENCIES || 'on';
  if (cloneDependencies !== 'on' && cloneDependencies !== 'off')
    throw new Error(`invalid PROJECTMAN_CLONE_DEPENDENCIES: ${cloneDependencies} (on or off)`);
  // apps/web/dist, from src/index.ts (tsx) as well as from dist/index.js (bundle).
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const home = resolve(env.PROJECTMAN_HOME ?? join(homedir(), '.projectman'));
  const installDir = fileURLToPath(new URL('../../..', import.meta.url));
  // The screenshot mode's fixed machine (PM-320): invalid JSON stops the start.
  const machineFixture = env.PROJECTMAN_MACHINE_FIXTURE
    ? parseMachineFixture(env.PROJECTMAN_MACHINE_FIXTURE)
    : undefined;
  return {
    port,
    host,
    machineFixture: machineFixture !== undefined,
    app: {
      engineMode,
      appVersion: await resolveAppVersion(installDir, env.PROJECTMAN_VERSION),
      modules: machineFixture
        ? {
            createMachineProbe: (opts) => createFixtureProbe(machineFixture, opts),
          }
        : undefined,
      home,
      // The session folders (PM-268) below the real temp directory (macOS: /var is /private/var, the
      // path the sandbox sees); the hash keeps a development and the live instance's folders apart,
      // so neither sweeps the other's.
      sessionFoldersDir: join(
        realpathSync(tmpdir()),
        'projectman-sessions',
        createHash('sha256').update(home).digest('hex').slice(0, 12),
      ),
      // The Codex sessions' own TMPDIR root (PM-339): short, because a Unix socket's path may be 104
      // bytes at most; a folder per installation, like the session folders above.
      sessionTmpDir: join(
        defaultSessionTmpRoot(),
        createHash('sha256').update(home).digest('hex').slice(0, 8),
      ),
      claudeTmpBase: env.CLAUDE_CODE_TMPDIR || undefined,
      browsersDir: resolve(env.PROJECTMAN_BROWSERS_PATH || join(home, 'browsers')),
      heavyLockDir: env.PROJECTMAN_HEAVY_LOCK_DIR || defaultHeavyLockDir(),
      publicBaseUrl: loopbackBaseUrl(host, port),
      clientIpHeader,
      cloneDependencies: cloneDependencies !== 'off',
      claudeBin: env.CLAUDE_BIN,
      codexBin: env.CODEX_BIN,
      geminiBin: env.AGY_BIN,
      geminiConfigDir: join(home, 'providers', 'gemini'),
      codexHome: env.CODEX_HOME || undefined,
      claudeConfigPath: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : undefined,
      agentEnv: env,
      terminal: parseTerminalMode(env.PROJECTMAN_TERMINAL, {
        home: env.PROJECTMAN_HOME,
        liveHome: join(homedir(), '.projectman'),
        claudeBin: env.CLAUDE_BIN,
        codexBin: env.CODEX_BIN,
        boundaryConfig: boundaryFile,
        executionProfile,
      }),
      ghBin: env.GH_BIN,
      ghHost: env.GH_HOST || undefined,
      logger: env.LOG_LEVEL === undefined ? undefined : { level: env.LOG_LEVEL },
      webDistDir: existsSync(join(webDist, 'index.html')) ? webDist : null,
      // The checkout the server runs from (three levels up from src/ or dist/).
      installDir,
      memberWorkspaces: workspaces === 'member',
      runtimeBoundary,
      executionProfile,
      vmReadinessReport: env.PROJECTMAN_VM_READINESS_REPORT || undefined,
      vmReadinessMaxAgeMs: reportMinutes > 0 ? reportMinutes * 60_000 : undefined,
      githubPublishTokenFile: env.PROJECTMAN_GITHUB_PUBLISH_TOKEN_FILE || undefined,
      shutdownPauseMs,
    },
  };
}

/**
 * The engine process (PM-314): `npm run engine -- start`. The environment is read here into the engine's
 * options; the engine's own configuration (cloud address, projects, repos, limits) is `<home>/engine.json`.
 */
async function engineMain(env: NodeJS.ProcessEnv): Promise<void> {
  const port = Number.parseInt(env.PROJECTMAN_ENGINE_PORT ?? String(ENGINE_DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`invalid PROJECTMAN_ENGINE_PORT: ${env.PROJECTMAN_ENGINE_PORT}`);
  const home = resolve(env.PROJECTMAN_HOME ?? join(homedir(), '.projectman'));
  const installDir = fileURLToPath(new URL('../../..', import.meta.url));
  const shutdownPauseMs = env.PROJECTMAN_SHUTDOWN_PAUSE_MS
    ? Number(env.PROJECTMAN_SHUTDOWN_PAUSE_MS)
    : undefined;
  if (shutdownPauseMs !== undefined && !(Number.isInteger(shutdownPauseMs) && shutdownPauseMs >= 0))
    throw new Error(
      `invalid PROJECTMAN_SHUTDOWN_PAUSE_MS: ${env.PROJECTMAN_SHUTDOWN_PAUSE_MS} (milliseconds; 0 turns it off)`,
    );
  const cloneDependencies = env.PROJECTMAN_CLONE_DEPENDENCIES || 'on';
  if (cloneDependencies !== 'on' && cloneDependencies !== 'off')
    throw new Error(`invalid PROJECTMAN_CLONE_DEPENDENCIES: ${cloneDependencies} (on or off)`);
  const boundaryConfig = env.PROJECTMAN_BOUNDARY_CONFIG || undefined;
  const executionProfile = parseExecutionProfile(env.PROJECTMAN_EXECUTION_PROFILE);
  assertEngineProfile({ executionProfile, boundaryConfig });
  const engine = await buildEngineApp({
    home,
    port,
    installDir,
    version: await resolveAppVersion(installDir, env.PROJECTMAN_VERSION),
    executionProfile,
    boundaryConfig,
    agentEnv: env,
    sessionFoldersDir: join(
      realpathSync(tmpdir()),
      'projectman-sessions',
      createHash('sha256').update(home).digest('hex').slice(0, 12),
    ),
    sessionTmpDir: join(defaultSessionTmpRoot(), createHash('sha256').update(home).digest('hex').slice(0, 8)),
    claudeTmpBase: env.CLAUDE_CODE_TMPDIR || undefined,
    browsersDir: resolve(env.PROJECTMAN_BROWSERS_PATH || join(home, 'browsers')),
    heavyLockDir: env.PROJECTMAN_HEAVY_LOCK_DIR || defaultHeavyLockDir(),
    cloneDependencies: cloneDependencies !== 'off',
    claudeBin: env.CLAUDE_BIN,
    codexBin: env.CODEX_BIN,
    geminiBin: env.AGY_BIN,
    codexHome: env.CODEX_HOME || undefined,
    claudeConfigPath: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : undefined,
    terminal: parseTerminalMode(env.PROJECTMAN_TERMINAL, {
      home: env.PROJECTMAN_HOME,
      liveHome: join(homedir(), '.projectman'),
      claudeBin: env.CLAUDE_BIN,
      codexBin: env.CODEX_BIN,
      boundaryConfig,
      executionProfile,
    }),
    ghBin: env.GH_BIN,
    ghHost: env.GH_HOST || undefined,
    logger: env.LOG_LEVEL === undefined ? undefined : { level: env.LOG_LEVEL },
    shutdownPauseMs,
  });
  const shutdown = createShutdown({
    pause: () => engine.pauseForShutdown(),
    close: () => engine.close(),
    exit: (code) => process.exit(code),
    log: {
      info: (obj, msg) => engine.app.log.info(obj, msg),
      warn: (obj, msg) => engine.app.log.warn(obj, msg),
      error: (obj, msg) => engine.app.log.error(obj, msg),
    },
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  await engine.start();
}

async function main(): Promise<void> {
  const mode = parseMode(process.env.PROJECTMAN_MODE);
  if (mode === 'engine') return engineMain(process.env);
  const config = await configFromEnv(process.env, mode);
  // The server's full test before review (PM-217) runs in the Anthropic Sandbox Runtime on the Mac. The
  // managed VM profile leaves it out: its members have no CLI sandbox and run the full test themselves.
  const app = await buildApp({
    ...config.app,
    // Always wire the live checker here; buildApp and domain harnesses never contact NanoGPT.
    modules:
      // The cloud runs none of the machine's work itself: its engine does the full test and the screenshots.
      config.app.executionProfile === 'managed_vm' || mode === 'cloud'
        ? { ...config.app.modules, nanogptKeyCheck: createNanogptKeyCheck() }
        : {
            ...config.app.modules,
            nanogptKeyCheck: createNanogptKeyCheck(),
            createFullTestExecutor: ({ logger }) =>
              createFullTestExecutor({ logger, env: process.env, heavyLockDir: config.app.heavyLockDir }),
            createScreenshotExecutor: ({ logger }) =>
              createScreenshotExecutor({ logger, env: process.env, heavyLockDir: config.app.heavyLockDir }),
          },
  });
  if (config.app.executionProfile === 'managed_vm')
    app.log.info('the full test before review is off: the managed VM profile has no sandbox for it');
  if (config.machineFixture)
    app.log.warn('the machine display shows fixed data (PROJECTMAN_MACHINE_FIXTURE), not the real machine');

  const shutdown = createShutdown({
    pause: () => app.projectman.pauseForShutdown(),
    close: () => app.close(),
    exit: (code) => process.exit(code),
    log: {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    },
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ home: config.app.home, webApp: config.app.webDistDir !== null }, 'projectman server ready');
}

main().catch((err: unknown) => {
  // A problem the person starting the engine can fix: the message, not a stack.
  if (err instanceof EngineConfigError) console.error(`projectman engine: ${err.message}`);
  else console.error(err);
  process.exit(1);
});
