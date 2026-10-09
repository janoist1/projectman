import { describe, expect, it, vi } from 'vitest';
import { createMachineProbe } from './probe';
import type { ProbeSystem } from './probe';

const GB = 1024 ** 3;

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               3338.
Pages wired down:                        86000.
Pages purgeable:                          2000.
Anonymous pages:                        260000.
"Pages occupied by compressor":          88000.
`;

const MAC_PS = `    1     0     0  13520   0.0   1:09.31 Thu Sep 25 08:01:02 2026 /sbin/launchd
 5100  5000   501   2048  12.5   0:00.01 Sat Oct  4 21:20:11 2026 sleep 600
`;

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    6384000 kB
SwapTotal:       2097152 kB
SwapFree:        2000000 kB
`;

function system(over: Partial<ProbeSystem> & { outputs?: Record<string, string> } = {}): ProbeSystem {
  const { outputs = {}, ...rest } = over;
  return {
    platform: 'darwin',
    exec: async (file, args) => {
      const key = [file, ...args].join(' ');
      if (key in outputs) return outputs[key]!;
      throw new Error(`unexpected command: ${key}`);
    },
    readFile: async (path) => {
      throw new Error(`unexpected read: ${path}`);
    },
    cpus: () => [
      { times: { user: 100, nice: 0, sys: 50, idle: 800, irq: 50 } },
      { times: { user: 200, nice: 0, sys: 50, idle: 700, irq: 50 } },
    ],
    totalmem: () => 16 * GB,
    freemem: () => 4 * GB,
    kill: () => undefined,
    ...rest,
  };
}

describe('the machine on macOS', () => {
  it('reads the processor, memory, swap and pressure', async () => {
    const probe = createMachineProbe(
      system({
        outputs: {
          vm_stat: VM_STAT,
          'sysctl -n vm.swapusage': 'total = 16.00G  used = 15.60G  free = 0.40G  (encrypted)',
          'sysctl -n kern.memorystatus_vm_pressure_level': '4\n',
        },
      }),
    );
    expect(await probe.machine()).toEqual({
      cpu: { busyMs: 500, totalMs: 2000 },
      cores: 2,
      memoryUsedBytes: (86000 + 88000 + 260000 - 2000) * 16384,
      memoryTotalBytes: 16 * GB,
      memoryPressure: 'critical',
      swapUsedBytes: Math.round(15.6 * GB),
      swapTotalBytes: 16 * GB,
    });
  });

  it('leaves what it cannot read null and never throws', async () => {
    const probe = createMachineProbe(
      system({
        cpus: () => {
          throw new Error('no cpus');
        },
        totalmem: () => {
          throw new Error('no memory');
        },
      }),
    );
    expect(await probe.machine()).toEqual({
      cpu: null,
      cores: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      memoryPressure: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
    });
  });
});

describe('the machine on Linux', () => {
  it('reads the memory and the swap from /proc/meminfo, and has no pressure level', async () => {
    const probe = createMachineProbe(system({ platform: 'linux', readFile: async () => MEMINFO }));
    expect(await probe.machine()).toMatchObject({
      memoryUsedBytes: (16384000 - 6384000) * 1024,
      swapUsedBytes: (2097152 - 2000000) * 1024,
      swapTotalBytes: 2097152 * 1024,
      memoryPressure: null,
    });
  });
});

describe('another operating system', () => {
  it('takes the used memory as total minus free, and has no process list', async () => {
    const probe = createMachineProbe(system({ platform: 'win32' }));
    expect(await probe.machine()).toMatchObject({
      memoryUsedBytes: 12 * GB,
      swapUsedBytes: null,
      memoryPressure: null,
    });
    expect(await probe.processes()).toBeNull();
  });
});

describe('the process list', () => {
  it('asks ps for the columns and parses the answer', async () => {
    const exec = vi.fn(async () => MAC_PS);
    const probe = createMachineProbe(system({ exec }));
    const list = await probe.processes();
    expect(exec).toHaveBeenCalledWith('ps', [
      '-axww',
      '-o',
      'pid=,ppid=,uid=,rss=,%cpu=,time=,lstart=,args=',
    ]);
    expect(list).toHaveLength(2);
    expect(list![1]).toMatchObject({
      pid: 5100,
      ppid: 5000,
      uid: 501,
      rssBytes: 2048 * 1024,
      args: 'sleep 600',
    });
  });

  it('is null when ps fails or prints nothing', async () => {
    expect(await createMachineProbe(system()).processes()).toBeNull();
    expect(await createMachineProbe(system({ exec: async () => '' })).processes()).toBeNull();
  });
});

describe('the environment of processes', () => {
  it('on macOS is the difference between ps -E and plain ps, in chunks of 100 pids', async () => {
    const calls: string[][] = [];
    const probe = createMachineProbe(
      system({
        exec: async (_file, args) => {
          calls.push(args);
          const list = args[args.length - 1]!.split(',');
          const withEnvironment = args.includes('-E');
          return list
            .map((pid) =>
              withEnvironment
                ? ` ${pid} sleep 600 HOME=/h PROJECTMAN_SESSION_ID=ses_${pid} PROJECTMAN_INSTANCE=abc`
                : ` ${pid} sleep 600`,
            )
            .join('\n');
        },
      }),
    );
    const pids = Array.from({ length: 250 }, (_, i) => 1000 + i);
    const environment = await probe.envValues(pids, ['PROJECTMAN_SESSION_ID', 'PROJECTMAN_INSTANCE']);
    expect(calls).toHaveLength(6); // three chunks, each with and without -E
    expect(environment.size).toBe(250);
    expect(environment.get(1249)).toEqual({ PROJECTMAN_SESSION_ID: 'ses_1249', PROJECTMAN_INSTANCE: 'abc' });
  });

  it('on macOS keeps what ps printed when it exits with an error for a vanished pid', async () => {
    const probe = createMachineProbe(
      system({
        exec: async (_file, args) => {
          const out = args.includes('-E') ? ' 7 sleep 1 PROJECTMAN_SESSION_ID=ses_7' : ' 7 sleep 1';
          throw Object.assign(new Error('exit 1'), { stdout: out });
        },
      }),
    );
    expect((await probe.envValues([7, 8], ['PROJECTMAN_SESSION_ID'])).get(7)).toEqual({
      PROJECTMAN_SESSION_ID: 'ses_7',
    });
  });

  it('on Linux is read from /proc/<pid>/environ; an unreadable process is missing', async () => {
    const probe = createMachineProbe(
      system({
        platform: 'linux',
        readFile: async (path) => {
          if (path === '/proc/5/environ') return 'A=1\0PROJECTMAN_SESSION_ID=ses_5\0';
          throw new Error('EACCES');
        },
      }),
    );
    const environment = await probe.envValues([5, 6], ['PROJECTMAN_SESSION_ID']);
    expect(environment.get(5)).toEqual({ PROJECTMAN_SESSION_ID: 'ses_5' });
    expect(environment.has(6)).toBe(false);
  });
});

describe('signals', () => {
  it('maps the outcome of kill', async () => {
    const kill = vi.fn();
    const probe = createMachineProbe(system({ kill }));
    await expect(probe.signal(4321, 'SIGTERM')).resolves.toBe('sent');
    expect(kill).toHaveBeenCalledWith(4321, 'SIGTERM');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    await expect(probe.signal(4321, 'SIGKILL')).resolves.toBe('gone');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    await expect(probe.signal(4321, 'SIGKILL')).resolves.toBe('denied');
  });

  it('never signals init, a group or a broadcast', async () => {
    const kill = vi.fn();
    const probe = createMachineProbe(system({ kill }));
    for (const pid of [1, 0, -1, -4321, 1.5, Number.NaN])
      await expect(probe.signal(pid, 'SIGTERM')).resolves.toBe('denied');
    expect(kill).not.toHaveBeenCalled();
  });
});
