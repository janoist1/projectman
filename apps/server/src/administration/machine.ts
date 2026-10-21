import type { AdministrationMachineSnapshot } from '../contracts';
import { SYSCTL, VM_STAT } from './host';
import type { HostSystem } from './host';
import { listProcesses } from './processes';

/**
 * The machine snapshot of the supervisor's host (PM-886): `/usr/sbin/sysctl`, `/usr/bin/vm_stat` and `/bin/ps`
 * on macOS, `/proc` on Linux. Each part is read with a fixed program or file and parsed here; an unreadable
 * part fails the whole read (`administration_failed`), except the swap, which a host may simply not have.
 * The process list is the supervisor user's own, the names are base names and no argument is read.
 */

const TOP_PROCESSES = 10;

const KIB = 1024;
const SWAP_UNITS: Record<string, number> = { K: KIB, M: KIB ** 2, G: KIB ** 3, T: KIB ** 4 };

/** `{ 1.23 2.34 3.45 }` (macOS `vm.loadavg`) or `1.23 2.34 3.45 1/234 5678` (`/proc/loadavg`). */
export function parseLoadAvg(text: string): [number, number, number] | null {
  const numbers = text
    .match(/\d+(?:\.\d+)?/g)
    ?.slice(0, 3)
    .map(Number);
  return numbers && numbers.length === 3 ? [numbers[0]!, numbers[1]!, numbers[2]!] : null;
}

/** `total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)`. */
export function parseSwapUsage(text: string): { totalBytes: number; usedBytes: number } | null {
  const read = (name: string) => {
    const match = new RegExp(`${name} = (\\d+(?:\\.\\d+)?)([KMGT])`).exec(text);
    return match ? Math.round(Number(match[1]) * SWAP_UNITS[match[2]!]!) : null;
  };
  const totalBytes = read('total');
  const usedBytes = read('used');
  return totalBytes === null || usedBytes === null ? null : { totalBytes, usedBytes };
}

/** The memory that can be given to a program without paging: free, inactive and speculative pages. */
export function parseVmStatAvailable(text: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(text)?.[1];
  if (!pageSize) return null;
  const pages = (label: string) => {
    const value = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1];
    return value === undefined ? null : Number(value);
  };
  const parts = [pages('free'), pages('inactive'), pages('speculative')];
  return parts.every((part) => part !== null)
    ? parts.reduce((sum, part) => sum! + part!, 0)! * Number(pageSize)
    : null;
}

/** `/proc/meminfo`, in bytes. */
export function parseMeminfo(text: string): {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
} | null {
  const kib = (name: string) => {
    const value = new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm').exec(text)?.[1];
    return value === undefined ? null : Number(value) * KIB;
  };
  const totalBytes = kib('MemTotal');
  const availableBytes = kib('MemAvailable');
  if (totalBytes === null || availableBytes === null) return null;
  return { totalBytes, availableBytes, swapTotalBytes: kib('SwapTotal'), swapFreeBytes: kib('SwapFree') };
}

const unreadable = (what: string) => new Error(`the ${what} of the machine cannot be read`);

async function readDarwin(host: HostSystem) {
  const [load, memsize, swap, vmStat] = await Promise.all([
    host.exec(SYSCTL, ['-n', 'vm.loadavg']),
    host.exec(SYSCTL, ['-n', 'hw.memsize']),
    host.exec(SYSCTL, ['-n', 'vm.swapusage']).catch(() => null),
    host.exec(VM_STAT, []),
  ]);
  const loadAvg = parseLoadAvg(load);
  const totalBytes = Number(memsize.trim());
  const availableBytes = parseVmStatAvailable(vmStat);
  if (!loadAvg) throw unreadable('load');
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || availableBytes === null) throw unreadable('memory');
  return {
    loadAvg,
    memory: { totalBytes, availableBytes: Math.min(availableBytes, totalBytes) },
    swap: swap === null ? null : parseSwapUsage(swap),
  };
}

async function readLinux(host: HostSystem) {
  const [load, meminfo] = await Promise.all([host.readFile('/proc/loadavg'), host.readFile('/proc/meminfo')]);
  const loadAvg = parseLoadAvg(load);
  const memory = parseMeminfo(meminfo);
  if (!loadAvg) throw unreadable('load');
  if (!memory) throw unreadable('memory');
  return {
    loadAvg,
    memory: { totalBytes: memory.totalBytes, availableBytes: memory.availableBytes },
    swap:
      memory.swapTotalBytes === null || memory.swapFreeBytes === null
        ? null
        : {
            totalBytes: memory.swapTotalBytes,
            usedBytes: Math.max(0, memory.swapTotalBytes - memory.swapFreeBytes),
          },
  };
}

export interface MachineReader {
  snapshot(): Promise<AdministrationMachineSnapshot>;
}

export function createMachineReader(host: HostSystem): MachineReader {
  return {
    async snapshot() {
      if (host.platform !== 'darwin' && host.platform !== 'linux')
        throw new Error('the machine snapshot is not supported on this platform');
      const [base, rows] = await Promise.all([
        host.platform === 'darwin' ? readDarwin(host) : readLinux(host),
        listProcesses(host, { withCommand: false }),
      ]);
      const topProcesses = rows
        .sort((a, b) => b.rssBytes - a.rssBytes)
        .slice(0, TOP_PROCESSES)
        .map((row) => ({ pid: row.pid, name: row.name, cpuPercent: row.cpuPercent, rssBytes: row.rssBytes }));
      return { at: host.now().toISOString(), ...base, topProcesses };
    },
  };
}
