/** Types of `load-probe.mjs`, for the TypeScript tests. */

export const PROBE_VERSION: number;

export interface PsProcess {
  pid: number;
  ppid: number;
  cpuSeconds: number;
  rssKb: number;
  etimeSeconds: number;
  args: string;
}

export interface ProcessClass {
  cat: string;
  sub: string;
  session: number | null;
  provider: string | null;
  inQueue: boolean;
  own: boolean;
}

export interface HeavyEntry {
  pid: number;
  label: string;
  sessionId: string | null;
  queuedAt: string | null;
  since: string | null;
}

export interface LinkEvent {
  ts: string;
  tMs: number;
  side: string;
  level: number | null;
  msg: string;
  reason?: string;
  [field: string]: unknown;
}

export interface Run {
  kind: string;
  pid: number;
  processes: number;
  workers: number | null;
  cpuPct: number;
  rssKb: number;
  inQueue: boolean;
  session: number | null;
  provider: string | null;
  maxWorkersArg: number | null;
  env?: Record<string, number> | null;
}

export function parseClock(text: string): number | null;
export function parsePsLine(line: string): PsProcess | null;
export function parseVmStat(output: string): {
  usedBytes: number | null;
  freeBytes: number | null;
  compressedBytes: number | null;
  wiredBytes: number | null;
} | null;
export function parseSwapUsage(output: string): { totalBytes: number; usedBytes: number } | null;
export function parsePressure(output: string): 1 | 2 | 4 | null;
export function safeName(text: unknown, max?: number): string;
export function describeCommand(args: string): { exe: string; script: string };
export function classifyOwn(args: string): { cat: string; sub: string } | null;
export function classifyTree(
  procs: { pid: number; ppid: number; args: string }[],
  options?: { holderPid?: number | null; probePid?: number | null },
): Map<number, ProcessClass>;
export function findRuns(
  procs: (PsProcess & { etimeSeconds?: number })[],
  classes: Map<number, ProcessClass>,
  cpuOf: (pid: number) => number | null,
): Run[];
export function pickVitestEnv(line: string): Record<string, number>;
export function readHeavyQueueSync(
  dir: string,
  fsApi?: unknown,
  alive?: (pid: number) => boolean,
): { holder: HeavyEntry | null; waiting: HeavyEntry[] };
export function defaultQueueDir(): string;
export function collectSample(
  state: Record<string, unknown>,
  deps?: {
    exec?: (file: string, args: string[], options?: object) => Promise<string>;
    now?: () => number;
    cpus?: () => { times: { user: number; nice: number; sys: number; idle: number } }[];
    readQueue?: () => { holder: HeavyEntry | null; waiting: HeavyEntry[] };
    envOf?: (pids: number[]) => Promise<Record<number, Record<string, number>>>;
  },
): Promise<Record<string, any>>;
export function headerRecord(options: {
  interval: number;
  duration: number;
  label?: string;
}): Record<string, any>;
export function collectInventory(options?: {
  roots?: string[];
  count?: boolean;
  exec?: (file: string, args: string[], options?: object) => Promise<string>;
}): Promise<Record<string, any>>;
export function filterLogLine(line: string, side: string): LinkEvent | null;
export function filterLogText(text: string, side: string): LinkEvent[];
export function summarizeLinks(events: LinkEvent[]): Record<string, any>;
export function percentile(values: number[], p: number): number | null;
export function defaultTestWorkers(host: { cpus: number; memoryBytes: number }): number;
export function summarizeWindow(
  records: Record<string, any>[],
  linkEvents?: LinkEvent[],
): Record<string, any>;
