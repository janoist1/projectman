import { z } from 'zod';
import { MemoryPressure } from '@projectman/shared';
import type { MachineProbe, MachineSnapshot, ProcessRecord } from '../contracts';

/**
 * The fixed-data probe of the screenshot mode (PM-320): `PROJECTMAN_MACHINE_FIXTURE` names a JSON
 * file, and the display shows it instead of the real machine (the members' sandbox does not allow
 * `ps`, so a real measurement cannot be photographed). It never sends a real signal: "stopping" a
 * process only takes it out of the list. See docs/SCREENSHOTS.md.
 */

const FixtureProcess = z.object({
  /** The command line. */
  args: z.string().min(1),
  /** Of one core, as `ps` shows it. */
  cpuPercent: z.number().min(0).default(0),
  memoryMb: z.number().min(0),
  /** How long ago it started. */
  ageMinutes: z.number().min(0).default(60),
});
type FixtureProcess = z.infer<typeof FixtureProcess>;

export const MachineFixture = z.object({
  machine: z.object({
    /** Of the whole machine; null: unknown. */
    cpuPercent: z.number().min(0).max(100).nullable(),
    cores: z.number().int().positive().nullable().default(8),
    memoryUsedGb: z.number().min(0).nullable(),
    memoryTotalGb: z.number().positive().nullable(),
    memoryPressure: MemoryPressure.nullable().default(null),
    swapUsedGb: z.number().min(0).nullable().default(null),
    swapTotalGb: z.number().min(0).nullable().default(null),
  }),
  /** The server's own process. */
  server: z.object({ cpuPercent: z.number().min(0).default(0), memoryMb: z.number().min(0) }).optional(),
  /**
   * The running sessions in the order the runner lists them: the first process is the session's CLI,
   * the rest are its children.
   */
  sessions: z.array(z.object({ processes: z.array(FixtureProcess).min(1) })).default([]),
  /** Processes of no session (each a process of its own, grouped by short name like the real ones). */
  others: z.array(FixtureProcess).default([]),
  /** The processes of ended sessions, marked as this instance's own: the first is the root, the rest are its children. */
  orphans: z
    .array(
      z.object({
        sessionId: z.string().startsWith('ses_').default('ses_fixture'),
        processes: z.array(FixtureProcess).min(1),
      }),
    )
    .default([]),
});
export type MachineFixture = z.infer<typeof MachineFixture>;

export function parseMachineFixture(text: string): MachineFixture {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('PROJECTMAN_MACHINE_FIXTURE is not valid JSON');
  }
  const parsed = MachineFixture.safeParse(json);
  if (!parsed.success)
    throw new Error(`PROJECTMAN_MACHINE_FIXTURE is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export interface FixtureProbeOptions {
  /** The pids of the running sessions' CLIs, in the runner's order. */
  runningPids: () => number[];
  /** The instance's tag: the orphans carry it. */
  instanceTag: string;
  serverPid?: number;
  uid?: number;
  now?: () => number;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
/** The counters start from here, so that two readings always have a time between them. */
const HEAD_START_SECONDS = 3600;
const ORPHAN_PID_BASE = 50_000;
const SESSION_CHILD_PID_BASE = 60_000;
const OTHER_PID_BASE = 40_000;

interface Group {
  sessionId: string;
  records: Array<{ pid: number; ppid: number; process: FixtureProcess }>;
}

export function createFixtureProbe(fixture: MachineFixture, options: FixtureProbeOptions): MachineProbe {
  const now = options.now ?? Date.now;
  const created = now();
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const serverPid = options.serverPid ?? process.pid;
  const cores = fixture.machine.cores;
  const removed = new Set<number>();

  const orphanGroups: Group[] = fixture.orphans.map((orphan, index) => {
    const rootPid = ORPHAN_PID_BASE + index * 100;
    return {
      sessionId: orphan.sessionId,
      records: orphan.processes.map((p, i) => ({
        pid: rootPid + i,
        ppid: i === 0 ? 1 : rootPid,
        process: p,
      })),
    };
  });

  const record = (pid: number, ppid: number, p: FixtureProcess): ProcessRecord => {
    const elapsedSeconds = (now() - created) / 1000 + HEAD_START_SECONDS;
    return {
      pid,
      ppid,
      uid,
      rssBytes: Math.round(p.memoryMb * MB),
      cpuSeconds: (p.cpuPercent / 100) * elapsedSeconds,
      cpuPercent: p.cpuPercent,
      startedAt: created - p.ageMinutes * 60_000,
      args: p.args,
    };
  };

  return {
    async machine(): Promise<MachineSnapshot> {
      const m = fixture.machine;
      const width = cores ?? 1;
      const totalMs = ((now() - created) / 1000 + HEAD_START_SECONDS) * width * 1000;
      return {
        cpu: m.cpuPercent === null ? null : { busyMs: (totalMs * m.cpuPercent) / 100, totalMs },
        cores,
        memoryUsedBytes: m.memoryUsedGb === null ? null : Math.round(m.memoryUsedGb * GB),
        memoryTotalBytes: m.memoryTotalGb === null ? null : Math.round(m.memoryTotalGb * GB),
        memoryPressure: m.memoryPressure,
        swapUsedBytes: m.swapUsedGb === null ? null : Math.round(m.swapUsedGb * GB),
        swapTotalBytes: m.swapTotalGb === null ? null : Math.round(m.swapTotalGb * GB),
      };
    },

    async processes(): Promise<ProcessRecord[]> {
      const list: ProcessRecord[] = [];
      if (fixture.server)
        list.push(record(serverPid, 1, { ...fixture.server, args: 'node projectman', ageMinutes: 600 }));
      const pids = options.runningPids();
      fixture.sessions.forEach((session, index) => {
        const cliPid = pids[index];
        if (cliPid === undefined || cliPid <= 1) return;
        session.processes.forEach((p, i) => {
          list.push(
            i === 0 ? record(cliPid, 1, p) : record(SESSION_CHILD_PID_BASE + index * 100 + i, cliPid, p),
          );
        });
      });
      fixture.others.forEach((p, index) => list.push(record(OTHER_PID_BASE + index, 1, p)));
      for (const group of orphanGroups) {
        for (const r of group.records)
          if (!removed.has(group.records[0]!.pid)) list.push(record(r.pid, r.ppid, r.process));
      }
      return list;
    },

    async envValues(pids, names) {
      const found = new Map<number, Record<string, string>>();
      const marker: Record<string, string> = {};
      for (const pid of pids) {
        const group = orphanGroups.find((g) => g.records.some((r) => r.pid === pid));
        const values: Record<string, string> = {};
        if (group) {
          if (names.includes('PROJECTMAN_INSTANCE')) values.PROJECTMAN_INSTANCE = options.instanceTag;
          if (names.includes('PROJECTMAN_SESSION_ID')) values.PROJECTMAN_SESSION_ID = group.sessionId;
        }
        found.set(pid, group ? values : marker);
      }
      return found;
    },

    /** Never a real signal: the orphan the pid belongs to leaves the list. */
    signal(pid) {
      const group = orphanGroups.find((g) => g.records.some((r) => r.pid === pid));
      if (!group || removed.has(group.records[0]!.pid)) return 'gone';
      removed.add(group.records[0]!.pid);
      return 'sent';
    },
  };
}
