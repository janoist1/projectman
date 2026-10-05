/** Helpers for the runner tests (not used by production code). */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';

/** The fake Claude Code CLI shared by the server tests. */
export const FAKE_CLAUDE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures/fake-claude.mjs',
);

/** The fake OpenAI Codex CLI. */
export const FAKE_CODEX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures/fake-codex.mjs',
);
export const FAKE_GEMINI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures/fake-gemini.mjs',
);

/** A logger that drops everything. */
export function silentLogger(): FastifyBaseLogger {
  const noop = () => undefined;
  const logger = {
    level: 'silent',
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => logger,
  };
  return logger as unknown as FastifyBaseLogger;
}

/** Temporary directories, removed by `cleanup()`. Paths are real paths (macOS /var -> /private/var). */
export function tempDirs() {
  const dirs: string[] = [];
  return {
    async make(prefix = 'projectman-runner-'): Promise<string> {
      const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
      dirs.push(dir);
      return dir;
    },
    async cleanup(): Promise<void> {
      await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}

export async function waitFor<T>(
  check: () => T | undefined | null | false,
  { timeoutMs = 10_000, intervalMs = 20, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A TCP port that was free a moment ago. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
