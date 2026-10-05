import { z } from 'zod';
import { MemberHandle, MemberKind } from './member';
import { RoleId } from './role';
import { SessionState, WorkItemRef } from './session';

/**
 * The machine display (PM-300, server side PM-320): how loaded the machine is, which session
 * uses it, and which processes of a finished session are left behind ("orphans").
 */

export const MachineLevel = z.enum(['ok', 'high', 'critical']);
export type MachineLevel = z.infer<typeof MachineLevel>;

/** The operating system's memory pressure (macOS only). */
export const MemoryPressure = z.enum(['normal', 'warn', 'critical']);
export type MemoryPressure = z.infer<typeof MemoryPressure>;

/**
 * A value at a threshold is already in the higher level. Swap is compared with the *physical*
 * memory, not with the swap size: on macOS the swap file grows on demand.
 */
export const MACHINE_THRESHOLDS = {
  cpuPercent: { high: 70, critical: 90 },
  memoryPercent: { high: 80, critical: 90 },
  swapOfMemoryPercent: { high: 25, critical: 50 },
} as const;

export const MachineSummary = z.object({
  /** 0..100, the whole machine. */
  cpuPercent: z.number().nullable(),
  cores: z.number().int().nullable(),
  memoryUsedBytes: z.number().nullable(),
  memoryTotalBytes: z.number().nullable(),
  /** macOS only. */
  memoryPressure: MemoryPressure.nullable(),
  swapUsedBytes: z.number().nullable(),
  swapTotalBytes: z.number().nullable(),
  sessionsRunning: z.number().int(),
  /** Sessions in the state `starting` or `working`. */
  sessionsWorking: z.number().int(),
});
export type MachineSummary = z.infer<typeof MachineSummary>;

/** The level of each measure; null: unknown (the display shows it in a neutral colour). */
export interface MachineLevels {
  cpu: MachineLevel | null;
  memory: MachineLevel | null;
  swap: MachineLevel | null;
  /** The worst known level. */
  overall: MachineLevel | null;
}

const LEVEL_ORDER: readonly MachineLevel[] = ['ok', 'high', 'critical'];

function worse(a: MachineLevel | null, b: MachineLevel | null): MachineLevel | null {
  if (a === null) return b;
  if (b === null) return a;
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

function levelOf(value: number | null, limits: { high: number; critical: number }): MachineLevel | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= limits.critical) return 'critical';
  if (value >= limits.high) return 'high';
  return 'ok';
}

function percentOf(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null;
  return (part * 100) / whole;
}

export function machineLevels(summary: MachineSummary): MachineLevels {
  const cpu = levelOf(summary.cpuPercent, MACHINE_THRESHOLDS.cpuPercent);
  let memory = levelOf(
    percentOf(summary.memoryUsedBytes, summary.memoryTotalBytes),
    MACHINE_THRESHOLDS.memoryPercent,
  );
  // The memory pressure of macOS only raises the level.
  if (summary.memoryPressure === 'critical') memory = worse(memory, 'critical');
  else if (summary.memoryPressure === 'warn') memory = worse(memory, 'high');
  const swap = levelOf(
    percentOf(summary.swapUsedBytes, summary.memoryTotalBytes),
    MACHINE_THRESHOLDS.swapOfMemoryPercent,
  );
  return { cpu, memory, swap, overall: worse(worse(cpu, memory), swap) };
}

export const ProcessUsage = z.object({
  pid: z.number().int(),
  name: z.string(),
  cpuPercent: z.number().nullable(),
  memoryBytes: z.number().nullable(),
});
export type ProcessUsage = z.infer<typeof ProcessUsage>;

export const MachineMember = z.object({
  handle: MemberHandle,
  displayName: z.string(),
  kind: MemberKind,
  role: RoleId,
  specialty: z.string().nullable(),
});
export type MachineMember = z.infer<typeof MachineMember>;

/** A session that runs: its process tree's use of the machine. */
export const MachineSessionRow = z.object({
  sessionId: z.string(),
  projectKey: z.string(),
  memberHandle: z.string(),
  /** Null: the member is no longer in the configuration. */
  member: MachineMember.nullable(),
  workItem: WorkItemRef,
  taskTitle: z.string().nullable(),
  state: SessionState,
  stateSince: z.string(),
  paused: z.boolean(),
  pid: z.number().int().nullable(),
  processStartedAt: z.string().nullable(),
  cpuPercent: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  processCount: z.number().int().nullable(),
  /** At most 5, largest memory first. */
  top: z.array(ProcessUsage),
});
export type MachineSessionRow = z.infer<typeof MachineSessionRow>;

/** The session an orphan process was started by. */
export const OrphanOrigin = z.object({
  sessionId: z.string(),
  projectKey: z.string(),
  memberHandle: z.string(),
  member: MachineMember.nullable(),
  workItem: WorkItemRef,
  taskTitle: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type OrphanOrigin = z.infer<typeof OrphanOrigin>;

/** A process (with its descendants) a projectman session started and that outlived the session. */
export const OrphanProcessRow = z.object({
  pid: z.number().int(),
  /** ISO, from the start time `ps` gives; the pid and this identify the process. */
  startedAt: z.string(),
  name: z.string(),
  /** At most 160 characters. */
  command: z.string(),
  cpuPercent: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  processCount: z.number().int(),
  /** Null: the session row is gone. */
  origin: OrphanOrigin.nullable(),
});
export type OrphanProcessRow = z.infer<typeof OrphanProcessRow>;

export const OtherProcessRow = z.object({
  kind: z.enum(['server', 'process']),
  name: z.string(),
  cpuPercent: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  processCount: z.number().int(),
});
export type OtherProcessRow = z.infer<typeof OtherProcessRow>;

export const MachineView = z.object({
  /** Null: there is no sample yet. */
  sampledAt: z.string().nullable(),
  intervalMs: z.number().int(),
  summary: MachineSummary,
  sessions: z.array(MachineSessionRow),
  /** Null: the process list is unavailable. */
  orphans: z.array(OrphanProcessRow).nullable(),
  others: z.array(OtherProcessRow).nullable(),
  /** What the machine uses beyond the rows above (never negative). */
  rest: z.object({ cpuPercent: z.number().nullable(), memoryBytes: z.number().nullable() }).nullable(),
  /** Resumable sessions that do not run (a finished or failed one of a card still open, or of a general chat). */
  closedSessions: z.number().int(),
});
export type MachineView = z.infer<typeof MachineView>;

export const StopOrphansRequest = z.object({
  orphans: z
    .array(z.object({ pid: z.number().int().positive(), startedAt: z.string() }))
    .min(1)
    .max(50),
});
export type StopOrphansRequest = z.infer<typeof StopOrphansRequest>;

/** `gone`: no such process (any more); `refused`: it is not an orphan of this instance. */
export const OrphanStopOutcome = z.enum(['stopped', 'gone', 'refused', 'failed']);
export type OrphanStopOutcome = z.infer<typeof OrphanStopOutcome>;

export const StopOrphansResult = z.object({
  results: z.array(z.object({ pid: z.number().int(), startedAt: z.string(), outcome: OrphanStopOutcome })),
});
export type StopOrphansResult = z.infer<typeof StopOrphansResult>;
