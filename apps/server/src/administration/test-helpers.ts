import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { HostSystem } from './host';

/**
 * Test support for the administration module (PM-763). Some sandboxes refuse to bind a Unix socket (the
 * agent sandbox does); the tests that need a real socket skip there and run in the merge test.
 */

/** A host that knows nothing and records the signals it is asked to send; a test overrides what it needs (PM-886). */
export function fakeHost(overrides: Partial<HostSystem> = {}): HostSystem & {
  signals: Array<{ pid: number; signal: 'SIGTERM' | 'SIGKILL' }>;
} {
  const signals: Array<{ pid: number; signal: 'SIGTERM' | 'SIGKILL' }> = [];
  return {
    platform: 'linux',
    uid: 501,
    pid: 1000,
    exec: async (file) => {
      throw new Error(`unexpected command ${file}`);
    },
    readFile: async (file) => {
      throw new Error(`unexpected file ${file}`);
    },
    readdir: async () => [],
    now: () => new Date('2026-10-17T10:00:00.000Z'),
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      return 'sent';
    },
    sleep: async () => undefined,
    ...overrides,
    signals,
  };
}

export async function unixSocketsWork(): Promise<boolean> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'adm-probe-'));
  try {
    return await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(path.join(dir, 's'), () => server.close(() => resolve(true)));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
