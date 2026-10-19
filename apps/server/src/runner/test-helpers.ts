/** Helpers for the runner tests (not used by production code). */
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import type { ProcessRecord, ScopeProcessSource } from '../contracts';

/** The disposable fake CLIs report their own identities; no host-wide ps or environment read is needed. */
export function fixtureScopeProcesses(directory: string): ScopeProcessSource {
  const read = async () => {
    const entries: Array<ProcessRecord & { env: Record<string, string> }> = [];
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.json')) continue;
      let record: ProcessRecord & { env: Record<string, string> };
      try {
        record = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) continue; // A fake may still be writing its startup record.
        throw error;
      }
      try {
        process.kill(record.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
        throw error;
      }
      entries.push({ ...record, rssBytes: 0, cpuSeconds: 0, cpuPercent: 0, args: 'fake CLI' });
    }
    return entries;
  };
  return {
    processes: read,
    envValues: async (pids, names) =>
      new Map(
        (await read())
          .filter((record) => pids.includes(record.pid))
          .map((record) => [
            record.pid,
            Object.fromEntries(
              names.filter((name) => record.env[name] !== undefined).map((name) => [name, record.env[name]!]),
            ),
          ]),
      ),
  };
}

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

/**
 * Where the fake claude writes what it loaded from `--settings` and `--mcp-config` when given the
 * args file `argsFile`: set `FAKE_CLAUDE_LOADED_FILE` to this beside `FAKE_CLAUDE_ARGS_FILE`.
 */
export function claudeLoadedFile(argsFile: string): string {
  return `${argsFile}.loaded`;
}

/**
 * The argv in the fake claude's args file, with the file paths after `--settings` and `--mcp-config`
 * (private launch files that are gone once the session ends, PM-156) replaced by the JSON it
 * loaded from them. Needs `FAKE_CLAUDE_LOADED_FILE` set to `claudeLoadedFile(argsFile)`.
 */
export function inlineLoadedClaudeConfig(argv: string[], argsFile: string): string[] {
  const loaded = JSON.parse(readFileSync(claudeLoadedFile(argsFile), 'utf8')) as {
    settings: unknown;
    mcpConfig: unknown[];
  };
  let mcp = 0;
  return argv.map((arg, i) => {
    if (argv[i - 1] === '--settings') return JSON.stringify(loaded.settings);
    if (argv[i - 1] === '--mcp-config') return JSON.stringify(loaded.mcpConfig[mcp++]);
    return arg;
  });
}

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
