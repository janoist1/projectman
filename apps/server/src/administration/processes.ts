import path from 'node:path';
import { LINUX_CLOCK_TICKS, LINUX_PAGE_BYTES, PS, parseElapsed } from './host';
import type { HostSystem } from './host';

/**
 * The supervisor user's processes, read the way the supervisor's own fixed commands print them (PM-886): `ps`
 * on macOS, `/proc` on Linux. Only processes of the supervisor's own user are ever returned, so neither the
 * machine snapshot nor the cleanup can see or touch anyone else's.
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  ageSeconds: number;
  cpuPercent: number;
  rssBytes: number;
  /** The program's base name (`comm`), never an argument. */
  name: string;
  /** The whole command line; only the cleanup's marker test reads it, nothing returns it. */
  command: string;
}

const DARWIN_COLUMNS = 'pid=,ppid=,pgid=,uid=,pcpu=,rss=,etime=';

/**
 * Two `ps` runs on macOS: `comm` (the executable path, spaces allowed) and `command` (the title and arguments)
 * each end a line, so they cannot share one run.
 */
export function parseDarwinComm(output: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const age = parseElapsed(match[7]!);
    if (age === null) continue;
    rows.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      uid: Number(match[4]),
      cpuPercent: Number(match[5]),
      rssBytes: Number(match[6]) * 1024,
      ageSeconds: age,
      name: path.basename(match[8]!),
      command: '',
    });
  }
  return rows;
}

export function parseDarwinCommands(output: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]!);
  }
  return commands;
}

/** The fields of `/proc/<pid>/stat` that the rows need (the command name may hold spaces and brackets). */
export function parseLinuxStat(stat: string): {
  name: string;
  ppid: number;
  pgid: number;
  cpuTicks: number;
  startTicks: number;
  rssPages: number;
} | null {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const number = (index: number) => Number(fields[index]);
  const parsed = {
    name: stat.slice(open + 1, close),
    ppid: number(1),
    pgid: number(2),
    cpuTicks: number(11) + number(12),
    startTicks: number(19),
    rssPages: number(21),
  };
  return [parsed.ppid, parsed.pgid, parsed.cpuTicks, parsed.startTicks, parsed.rssPages].every(
    Number.isFinite,
  )
    ? parsed
    : null;
}

export function parseLinuxStatus(status: string): { uid: number; rssBytes: number | null } | null {
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  if (uid === undefined) return null;
  const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
  return { uid: Number(uid), rssBytes: rss === undefined ? null : Number(rss) * 1024 };
}

async function listLinux(host: HostSystem, withCommand: boolean): Promise<ProcessRow[]> {
  const uptime = Number(/^(\d+(?:\.\d+)?)/.exec(await host.readFile('/proc/uptime'))?.[1]);
  if (!Number.isFinite(uptime)) throw new Error('the uptime is unreadable');
  const rows: ProcessRow[] = [];
  const pids = (await host.readdir('/proc')).filter((name) => /^\d+$/.test(name));
  await Promise.all(
    pids.map(async (name) => {
      try {
        const stat = parseLinuxStat(await host.readFile(`/proc/${name}/stat`));
        const status = parseLinuxStatus(await host.readFile(`/proc/${name}/status`));
        if (!stat || !status || (host.uid !== null && status.uid !== host.uid)) return;
        const age = Math.max(0, uptime - stat.startTicks / LINUX_CLOCK_TICKS);
        const command = withCommand
          ? (await host.readFile(`/proc/${name}/cmdline`)).split('\0').filter(Boolean).join(' ')
          : '';
        rows.push({
          pid: Number(name),
          ppid: stat.ppid,
          pgid: stat.pgid,
          uid: status.uid,
          ageSeconds: Math.floor(age),
          cpuPercent: Math.round((stat.cpuTicks / LINUX_CLOCK_TICKS / Math.max(age, 1)) * 1000) / 10,
          rssBytes: status.rssBytes ?? stat.rssPages * LINUX_PAGE_BYTES,
          name: stat.name,
          command,
        });
      } catch {
        // The process ended while it was being read.
      }
    }),
  );
  return rows;
}

async function listDarwin(host: HostSystem, withCommand: boolean): Promise<ProcessRow[]> {
  const rows = parseDarwinComm(await host.exec(PS, ['-axo', `${DARWIN_COLUMNS},comm=`]));
  if (withCommand) {
    const commands = parseDarwinCommands(await host.exec(PS, ['-axo', 'pid=,command=']));
    for (const row of rows.values()) row.command = commands.get(row.pid) ?? '';
  }
  return [...rows.values()].filter((row) => host.uid === null || row.uid === host.uid);
}

/** The supervisor user's processes; rejects where the platform is not supported or the list cannot be read. */
export async function listProcesses(
  host: HostSystem,
  options: { withCommand: boolean },
): Promise<ProcessRow[]> {
  if (host.platform === 'darwin') return listDarwin(host, options.withCommand);
  if (host.platform === 'linux') return listLinux(host, options.withCommand);
  throw new Error('the process list is not supported on this platform');
}

/** What a cleanup returns: counts only, so no process name, id or argument leaves the machine. */
export interface ProcessCleanupResult {
  found: number;
  stopped: number;
  remaining: number;
}

export interface ProcessCleaner {
  /** Whether this host can list and signal processes (the capability is advertised only then). */
  supported(): boolean;
  cleanup(selector: 'orphan_test_workers'): Promise<ProcessCleanupResult>;
}

export interface ProcessCleanerOptions {
  host: HostSystem;
  /** The running service's main process; it and its process group are never a target. */
  protectedPid?: () => Promise<number | null>;
  /** The command-line markers of a test worker; a test passes its own so it cannot meet a real worker. */
  markers?: readonly string[];
  minAgeSeconds?: number;
  graceMs?: number;
  pollMs?: number;
}

export const ORPHAN_MARKERS = ['vitest', 'tinypool'] as const;
export const ORPHAN_MIN_AGE_SECONDS = 5 * 60;
export const ORPHAN_GRACE_MS = 10_000;
const ORPHAN_POLL_MS = 500;

export function createProcessCleaner(options: ProcessCleanerOptions): ProcessCleaner {
  const { host } = options;
  const markers = (options.markers ?? ORPHAN_MARKERS).map((marker) => marker.toLowerCase());
  const minAge = options.minAgeSeconds ?? ORPHAN_MIN_AGE_SECONDS;
  const graceMs = options.graceMs ?? ORPHAN_GRACE_MS;
  const pollMs = options.pollMs ?? ORPHAN_POLL_MS;

  /** The processes that match all of: own user, parent 1, a marker in the command, old enough; not the service. */
  async function select(): Promise<ProcessRow[]> {
    if (host.uid === null) throw new Error('the supervisor has no numeric user id');
    const rows = await listProcesses(host, { withCommand: true });
    const servicePid = (await options.protectedPid?.()) ?? null;
    const fixedPids = new Set([host.pid, ...(servicePid === null ? [] : [servicePid])]);
    const fixedGroups = new Set(rows.filter((row) => fixedPids.has(row.pid)).map((row) => row.pgid));
    return rows.filter((row) => {
      if (row.uid !== host.uid || row.ppid !== 1 || row.pid <= 1) return false;
      if (row.ageSeconds < minAge) return false;
      if (fixedPids.has(row.pid) || fixedGroups.has(row.pgid)) return false;
      const command = row.command.toLowerCase();
      return markers.some((marker) => command.includes(marker));
    });
  }

  const alive = async (pids: Set<number>) => (await select()).filter((row) => pids.has(row.pid));

  return {
    supported: () => (host.platform === 'darwin' || host.platform === 'linux') && host.uid !== null,

    async cleanup() {
      const targets = await select();
      const found = new Set(targets.map((row) => row.pid));
      if (found.size === 0) return { found: 0, stopped: 0, remaining: 0 };
      for (const pid of found) host.kill(pid, 'SIGTERM');
      let remaining = found.size;
      for (let waited = 0; waited < graceMs && remaining > 0; waited += pollMs) {
        await host.sleep(pollMs);
        remaining = (await alive(found)).length;
      }
      if (remaining > 0) {
        // Selected again just now, so a process that ended and whose id was reused is not hit.
        for (const row of await alive(found)) host.kill(row.pid, 'SIGKILL');
        await host.sleep(pollMs);
        remaining = (await alive(found)).length;
      }
      return { found: found.size, stopped: found.size - remaining, remaining };
    },
  };
}
