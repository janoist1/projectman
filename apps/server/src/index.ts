import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';

/**
 * Server entry point.
 *   PORT (4700), HOST (127.0.0.1), PROJECTMAN_HOME (~/.projectman),
 *   CLAUDE_BIN (claude), GH_BIN (gh), LOG_LEVEL (info)
 * Remote access goes through Tailscale (`tailscale serve`), not by binding publicly.
 */

/** The address the local claude CLI uses to reach the hooks and MCP endpoints. */
function localBaseUrl(host: string, port: number): string {
  const loopback = ['', '0.0.0.0', '::', 'localhost', '127.0.0.1', '::1'].includes(host);
  const address = loopback ? '127.0.0.1' : host;
  return `http://${address.includes(':') ? `[${address}]` : address}:${port}`;
}

async function main(): Promise<void> {
  const env = process.env;
  const home = resolve(env.PROJECTMAN_HOME ?? join(homedir(), '.projectman'));
  const port = Number.parseInt(env.PORT ?? '4700', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid PORT: ${env.PORT}`);
  const host = env.HOST ?? '127.0.0.1';
  // apps/web/dist, from src/index.ts (tsx) as well as from dist/index.js (bundle).
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

  const app = await buildApp({
    home,
    publicBaseUrl: localBaseUrl(host, port),
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    ghBin: env.GH_BIN ?? 'gh',
    logger: { level: env.LOG_LEVEL ?? 'info' },
    webDistDir: existsSync(join(webDist, 'index.html')) ? webDist : null,
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) {
      app.log.warn({ signal }, 'forced exit');
      process.exit(1);
    }
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port, host });
  app.log.info({ home, webApp: existsSync(join(webDist, 'index.html')) }, 'projectman server ready');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
