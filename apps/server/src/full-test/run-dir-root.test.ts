import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullTestSpec, ScreenshotRunSpec } from '../contracts';
import { createFullTestExecutor } from './index';
import { createScreenshotExecutor } from './screenshots';

/**
 * A run whose run directory has no root with room for the sandbox sockets (PM-847) ends in the existing
 * unavailable result: nothing is created, nothing runs, and no wider permission or longer path is tried.
 */
vi.mock('./run-sandboxed', () => ({ runSandboxed: vi.fn(), srtCli: vi.fn() }));
vi.mock('./sandbox', async (original) => ({
  ...(await original<typeof import('./sandbox')>()),
  runDirOf: () => {
    throw new Error('no root leaves 40 bytes for a socket below the run directory');
  },
}));

let root: string;
const warn = vi.fn();
const logger = { warn, info: vi.fn() } as unknown as FastifyBaseLogger;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pm-run-dir-root-'));
  warn.mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a run directory with no root that has room for the sockets', () => {
  it('ends the full test as sandbox_unavailable, before anything is created', async () => {
    const spec: FullTestSpec = {
      runId: 'ftr_deep',
      cwd: '/work/PM-1-checkout',
      command: 'npm test',
      maxWorkers: 2,
      timeoutMs: 1000,
      sandbox: { denyRead: [], allowRead: [] },
    };
    const executor = createFullTestExecutor({ logger, tmpDir: root });
    const result = await executor.run(spec, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'error', reason: 'sandbox_unavailable' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'ftr_deep' }),
      expect.stringContaining('room for the sandbox sockets'),
    );
    expect(readdirSync(root)).toEqual([]);
  });

  it('ends a screenshot run without starting it', async () => {
    const spec = {
      runId: 'ftr_deep',
      cwd: '/work/PM-1-checkout',
      sandbox: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    } as unknown as ScreenshotRunSpec;
    const executor = createScreenshotExecutor({ logger, tmpDir: root });
    const ended = await executor.run(spec, new AbortController().signal, () => undefined);
    expect(ended.spawnError).toBe('could not prepare the run directory');
    expect(readdirSync(root)).toEqual([]);
  });
});
