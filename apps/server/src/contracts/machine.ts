import type { MemoryPressure } from '@projectman/shared';

/**
 * What the machine display measures with (PM-320). The real probe reads the operating system
 * (`src/machine`); tests and the screenshot mode pass a fake one. Owned by src/machine.
 */

/** The whole machine's numbers at one moment; a part that cannot be read is null. */
export interface MachineSnapshot {
  /** Cumulative CPU times over all cores; two snapshots give the load between them. */
  cpu: { busyMs: number; totalMs: number } | null;
  cores: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  /** macOS only. */
  memoryPressure: MemoryPressure | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
}

/** One line of the process list. */
export interface ProcessRecord {
  pid: number;
  ppid: number;
  uid: number;
  rssBytes: number;
  /** Total CPU time the process used so far, in seconds. */
  cpuSeconds: number;
  /** The operating system's own `%cpu` (of one core; macOS: since the process started, a decayed average). */
  cpuPercent: number;
  /** Epoch milliseconds from `lstart`; with the pid it identifies the process. */
  startedAt: number;
  /** The command line. Shown to the instance owner only, never logged or stored. */
  args: string;
}

export interface MachineProbe {
  /** Never throws: the parts that cannot be read are null. */
  machine(): Promise<MachineSnapshot>;
  /** Null: the list is unavailable (another operating system, `ps` refused). */
  processes(): Promise<ProcessRecord[] | null>;
  /** Values of the named environment variables per pid; a process whose environment cannot be read is missing. */
  envValues(pids: number[], names: string[]): Promise<Map<number, Record<string, string>>>;
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): 'sent' | 'gone' | 'denied';
}
