import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import type { MachineProbe, MachineSnapshot, ProcessRecord } from '../contracts';
import {
  diffPsEnvironment,
  parseEnvironFile,
  parseMeminfo,
  parseMemoryPressure,
  parsePsCommands,
  parsePsList,
  parseSwapUsage,
  parseVmStat,
} from './parse';

/** What the probe needs from the operating system; tests replace it. */
export interface ProbeSystem {
  platform: NodeJS.Platform;
  /** Runs a program and returns what it printed; rejects when it fails (an error with `stdout` keeps what it printed). */
  exec(file: string, args: string[]): Promise<string>;
  readFile(path: string): Promise<string>;
  cpus(): Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>;
  totalmem(): number;
  freemem(): number;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
}

const COMMAND_TIMEOUT_MS = 5000;
/** The most pids one `ps -p` call takes: keeps the command line short. */
const ENV_CHUNK = 100;

function realSystem(): ProbeSystem {
  return {
    platform: process.platform,
    exec: (file, args) =>
      new Promise((resolve, reject) => {
        execFile(
          file,
          args,
          {
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: 64 * 1024 * 1024,
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C' },
          },
          (error, stdout) => {
            if (error) reject(Object.assign(error, { stdout }));
            else resolve(stdout);
          },
        );
      }),
    readFile: (path) => readFile(path, 'utf8'),
    cpus: () => os.cpus(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    kill: (pid, signal) => process.kill(pid, signal),
  };
}

async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

/** What a failed command still printed: `ps -p` exits 1 when a listed pid is gone, with the others printed. */
async function outputOf(system: ProbeSystem, file: string, args: string[]): Promise<string> {
  try {
    return await system.exec(file, args);
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

const PS_COLUMNS = 'pid=,ppid=,uid=,rss=,%cpu=,time=,lstart=,args=';

/**
 * The real probe: Node's `os` for the processor and the memory total, `vm_stat` and `sysctl` on
 * macOS, `/proc` on Linux, `ps` for the process list. Every external command runs with a time
 * limit and `LC_ALL=C`.
 */
export function createMachineProbe(system: ProbeSystem = realSystem()): MachineProbe {
  async function usedMemory(totalBytes: number): Promise<number | null> {
    if (system.platform === 'darwin') {
      const output = await attempt(() => system.exec('vm_stat', []));
      return output === null ? null : parseVmStat(output);
    }
    if (system.platform === 'linux') {
      const meminfo = await attempt(() => system.readFile('/proc/meminfo'));
      const parsed = meminfo === null ? null : parseMeminfo(meminfo);
      return parsed?.availableBytes != null && parsed.totalBytes != null
        ? Math.max(0, parsed.totalBytes - parsed.availableBytes)
        : null;
    }
    return Math.max(0, totalBytes - system.freemem());
  }

  async function swap(): Promise<{ usedBytes: number; totalBytes: number } | null> {
    if (system.platform === 'darwin') {
      const output = await attempt(() => system.exec('sysctl', ['-n', 'vm.swapusage']));
      return output === null ? null : parseSwapUsage(output);
    }
    if (system.platform === 'linux') {
      const meminfo = await attempt(() => system.readFile('/proc/meminfo'));
      const parsed = meminfo === null ? null : parseMeminfo(meminfo);
      if (parsed?.swapTotalBytes == null || parsed.swapFreeBytes == null) return null;
      return {
        totalBytes: parsed.swapTotalBytes,
        usedBytes: Math.max(0, parsed.swapTotalBytes - parsed.swapFreeBytes),
      };
    }
    return null;
  }

  async function pressure(): Promise<MachineSnapshot['memoryPressure']> {
    if (system.platform !== 'darwin') return null;
    const output = await attempt(() => system.exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']));
    return output === null ? null : parseMemoryPressure(output);
  }

  async function environmentOnMac(
    pids: number[],
    names: string[],
  ): Promise<Map<number, Record<string, string>>> {
    const result = new Map<number, Record<string, string>>();
    for (let i = 0; i < pids.length; i += ENV_CHUNK) {
      const list = pids.slice(i, i + ENV_CHUNK).join(',');
      const [withEnvironment, plain] = await Promise.all([
        outputOf(system, 'ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', list]),
        outputOf(system, 'ps', ['-ww', '-o', 'pid=,command=', '-p', list]),
      ]);
      for (const [pid, values] of diffPsEnvironment(
        parsePsCommands(withEnvironment),
        parsePsCommands(plain),
        names,
      ))
        result.set(pid, values);
    }
    return result;
  }

  return {
    async machine(): Promise<MachineSnapshot> {
      let cpu: MachineSnapshot['cpu'] = null;
      let cores: number | null = null;
      try {
        const cpus = system.cpus();
        cores = cpus.length > 0 ? cpus.length : null;
        if (cpus.length > 0) {
          let total = 0;
          let idle = 0;
          for (const { times } of cpus) {
            total += times.user + times.nice + times.sys + times.idle + times.irq;
            idle += times.idle;
          }
          cpu = { busyMs: total - idle, totalMs: total };
        }
      } catch {
        // unknown
      }
      let totalBytes: number | null = null;
      try {
        totalBytes = system.totalmem();
      } catch {
        // unknown
      }
      const [used, swapped, memoryPressure] = await Promise.all([
        totalBytes === null ? Promise.resolve(null) : usedMemory(totalBytes),
        swap(),
        pressure(),
      ]);
      return {
        cpu,
        cores,
        memoryUsedBytes: used,
        memoryTotalBytes: totalBytes,
        memoryPressure,
        swapUsedBytes: swapped?.usedBytes ?? null,
        swapTotalBytes: swapped?.totalBytes ?? null,
      };
    },

    async processes(): Promise<ProcessRecord[] | null> {
      if (system.platform !== 'darwin' && system.platform !== 'linux') return null;
      const output = await attempt(() => system.exec('ps', ['-axww', '-o', PS_COLUMNS]));
      if (output === null) return null;
      const records = parsePsList(output);
      return records.length > 0 ? records : null;
    },

    async envValues(pids, names): Promise<Map<number, Record<string, string>>> {
      if (pids.length === 0) return new Map();
      if (system.platform === 'darwin') return environmentOnMac(pids, names);
      const result = new Map<number, Record<string, string>>();
      if (system.platform !== 'linux') return result;
      await Promise.all(
        pids.map(async (pid) => {
          const content = await attempt(() => system.readFile(`/proc/${pid}/environ`));
          if (content !== null && content !== '') result.set(pid, parseEnvironFile(content, names));
        }),
      );
      return result;
    },

    signal(pid, signal) {
      // Never a group or a broadcast (kill(-1), kill(0)), and never init.
      if (!Number.isInteger(pid) || pid <= 1) return Promise.resolve('denied');
      try {
        system.kill(pid, signal);
        return Promise.resolve('sent');
      } catch (error) {
        return Promise.resolve((error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'denied');
      }
    },
  };
}
