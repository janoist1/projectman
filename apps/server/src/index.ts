import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DEFAULTS, buildApp, isLoopbackHost, loopbackBaseUrl } from './app';
import type { BuildAppOptions, LoopbackHost } from './app';
import { loadBoundaryConfig } from './runtime-boundary';
import { createShutdown } from './shutdown';

/**
 * Server entry point. The environment is read here, once, into the app's options (defaults:
 * APP_DEFAULTS in app.ts and the modules' own):
 *   PORT (4700), HOST (127.0.0.1; loopback only), PROJECTMAN_HOME (~/.projectman),
 *   CLAUDE_BIN (claude), CODEX_BIN (codex), GH_BIN (gh), LOG_LEVEL (info),
 *   CODEX_HOME (~/.codex): where the runner reads Codex's transcripts and plan usage,
 *   CLAUDE_CONFIG_DIR (~): where the runner finds Claude Code's .claude.json (workspace trust),
 *   GH_HOST (github.com): the host whose `gh` login the GitHub module checks,
 *   PROJECTMAN_WORKSPACES (task_worktree): `member` gives every AI member a durable workspace per
 *   repository (PM-138) instead of a worktree per task.
 *   PROJECTMAN_BOUNDARY_CONFIG (unset): the managed VM's boundary configuration
 *   (/etc/projectman/boundary.json, PM-140); sessions then start only through the protected
 *   launcher, as their members' worker accounts, while the boundary is ready.
 * The agent CLIs start with this environment, minus billing and host-session variables (the
 * runner removes them); the git and gh commands the server runs inherit it.
 * Remote access goes through Tailscale (`tailscale serve`), not by binding publicly.
 */

interface ServerConfig {
  port: number;
  host: LoopbackHost;
  app: BuildAppOptions;
}

function configFromEnv(env: NodeJS.ProcessEnv): ServerConfig {
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
  // apps/web/dist, from src/index.ts (tsx) as well as from dist/index.js (bundle).
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  return {
    port,
    host,
    app: {
      home: resolve(env.PROJECTMAN_HOME ?? join(homedir(), '.projectman')),
      publicBaseUrl: loopbackBaseUrl(host, port),
      claudeBin: env.CLAUDE_BIN,
      codexBin: env.CODEX_BIN,
      codexHome: env.CODEX_HOME || undefined,
      claudeConfigPath: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : undefined,
      agentEnv: env,
      ghBin: env.GH_BIN,
      ghHost: env.GH_HOST || undefined,
      logger: env.LOG_LEVEL === undefined ? undefined : { level: env.LOG_LEVEL },
      webDistDir: existsSync(join(webDist, 'index.html')) ? webDist : null,
      memberWorkspaces: workspaces === 'member',
      runtimeBoundary,
    },
  };
}

async function main(): Promise<void> {
  const config = configFromEnv(process.env);
  const app = await buildApp(config.app);

  const shutdown = createShutdown({
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
  console.error(err);
  process.exit(1);
});
