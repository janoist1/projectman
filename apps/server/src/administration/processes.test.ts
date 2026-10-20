import { describe, expect, it } from 'vitest';
import { createProcessCleaner } from './processes';
import { fakeHost } from './test-helpers';

interface Fake {
  pid: number;
  ppid?: number;
  pgid?: number;
  uid?: number;
  ageSeconds?: number;
  command: string;
  /** Survives a TERM; only a KILL ends it. */
  stubborn?: boolean;
  /** Survives everything. */
  immortal?: boolean;
}

const SUPERVISOR_PID = 1000;
const SERVICE_PID = 2000;

const etime = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

/** A macOS-style host over a mutable process table; a signal removes the processes it ends. */
function tableHost(table: Fake[]) {
  const live = new Map(table.map((process) => [process.pid, process]));
  const host = fakeHost({
    platform: 'darwin',
    uid: 501,
    pid: SUPERVISOR_PID,
    exec: async (_file, args) => {
      const rows = [...live.values()];
      if (args.includes('pid=,command='))
        return rows.map((process) => `${process.pid} ${process.command}`).join('\n');
      return rows
        .map(
          (process) =>
            `${process.pid} ${process.ppid ?? 1} ${process.pgid ?? process.pid} ${process.uid ?? 501} 0.0 1024 ${etime(process.ageSeconds ?? 600)} ${process.command.split(' ')[0]}`,
        )
        .join('\n');
    },
  });
  host.kill = (pid, signal) => {
    host.signals.push({ pid, signal });
    const process = live.get(pid);
    if (!process) return 'gone';
    if (signal === 'SIGKILL' ? !process.immortal : !process.stubborn && !process.immortal) live.delete(pid);
    return 'sent';
  };
  return host;
}

const cleaner = (host: ReturnType<typeof tableHost>) =>
  createProcessCleaner({
    host,
    protectedPid: async () => SERVICE_PID,
    graceMs: 1000,
    pollMs: 500,
  });

describe('orphan test worker cleanup', () => {
  it('stops only own-user, parentless, old processes that carry a test marker', async () => {
    const host = tableHost([
      { pid: 10, command: '/usr/bin/node /repo/node_modules/vitest/dist/workers/forks.js' },
      { pid: 11, command: '/usr/bin/node /repo/node_modules/tinypool/dist/entry/process.js' },
      { pid: 12, ppid: 500, command: '/usr/bin/node /repo/node_modules/vitest/dist/workers/forks.js' },
      { pid: 13, command: '/usr/bin/node /repo/server.js' },
      { pid: 14, ageSeconds: 60, command: '/usr/bin/node /repo/node_modules/vitest/dist/cli.js' },
      { pid: 15, uid: 0, command: '/usr/bin/node /repo/node_modules/vitest/dist/cli.js' },
      { pid: SERVICE_PID, command: '/usr/bin/node /repo/vitest-looking-service.js' },
      { pid: 2001, pgid: SERVICE_PID, command: '/usr/bin/node /repo/node_modules/vitest/child.js' },
      { pid: SUPERVISOR_PID, command: '/usr/bin/node /repo/vitest-supervisor.js' },
    ]);
    expect(await cleaner(host).cleanup('orphan_test_workers')).toEqual({
      found: 2,
      stopped: 2,
      remaining: 0,
    });
    expect(host.signals).toEqual([
      { pid: 10, signal: 'SIGTERM' },
      { pid: 11, signal: 'SIGTERM' },
    ]);
  });

  it('sends a kill only to what a term did not end, after the grace period', async () => {
    const host = tableHost([
      { pid: 10, command: '/usr/bin/node vitest/forks.js' },
      { pid: 11, stubborn: true, command: '/usr/bin/node vitest/forks.js' },
    ]);
    expect(await cleaner(host).cleanup('orphan_test_workers')).toEqual({
      found: 2,
      stopped: 2,
      remaining: 0,
    });
    expect(host.signals).toEqual([
      { pid: 10, signal: 'SIGTERM' },
      { pid: 11, signal: 'SIGTERM' },
      { pid: 11, signal: 'SIGKILL' },
    ]);
  });

  it('counts a process that survives even a kill as remaining', async () => {
    const host = tableHost([{ pid: 10, immortal: true, command: '/usr/bin/node vitest/forks.js' }]);
    expect(await cleaner(host).cleanup('orphan_test_workers')).toEqual({
      found: 1,
      stopped: 0,
      remaining: 1,
    });
  });

  it('does nothing when no process matches', async () => {
    const host = tableHost([{ pid: 13, command: '/usr/bin/node /repo/server.js' }]);
    expect(await cleaner(host).cleanup('orphan_test_workers')).toEqual({
      found: 0,
      stopped: 0,
      remaining: 0,
    });
    expect(host.signals).toEqual([]);
  });

  it('is supported only where the host can list and signal processes', () => {
    expect(cleaner(tableHost([])).supported()).toBe(true);
    expect(createProcessCleaner({ host: fakeHost({ platform: 'win32' }) }).supported()).toBe(false);
    expect(createProcessCleaner({ host: fakeHost({ uid: null }) }).supported()).toBe(false);
  });
});
