import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The machine's memory pressure (PM-1278 B1 / PM-1314). The places of the pool count only what starts
 * through it; a dev server, Docker, a browser or the owner's own programs show up here instead. The engine
 * measures every 10 s and writes `pressure.json` into the pool's folder, because the members' sandboxes may
 * not run `sysctl`; the head of the queue reads it and hands out no places while a fresh reading is
 * `critical`. The folder is writable by every member, so the engine itself decides (`machine_busy`) from the
 * meter's memory (`PressureMeter.level`), never from the file (PM-1328). No engine (CI, a lone developer): no
 * file, and only the places count. Only node built-ins are
 * used: the heavy CLI imports this file through `heavy-lock.ts`.
 */

export type PressureLevel = 'normal' | 'warn' | 'critical';
type PressureSource = 'sysctl' | 'psi';

export interface PressureReading {
  level: PressureLevel;
  source: PressureSource;
}

/** The content of `pressure.json`. */
interface PressureFile extends PressureReading {
  /** ISO. */
  at: string;
}

export const PRESSURE_FILE = 'pressure.json';
const PRESSURE_INTERVAL_MS = 10_000;
/** A reading older than this holds nothing back. */
const PRESSURE_FRESH_MS = 30_000;
const SYSCTL_TIMEOUT_MS = 5_000;

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical; anything else is no reading. */
function parseDarwinPressure(stdout: string): PressureLevel | null {
  switch (stdout.trim()) {
    case '1':
      return 'normal';
    case '2':
      return 'warn';
    case '4':
      return 'critical';
    default:
      return null;
  }
}

/** `/proc/pressure/memory`: `full avg10 ≥ 5` is critical, `some avg10 ≥ 10` warn; no `some` line is no reading. */
function parseLinuxPressure(text: string): PressureLevel | null {
  const avg10 = (kind: 'some' | 'full'): number | undefined => {
    const match = new RegExp(`^${kind}\\s.*\\bavg10=([0-9.]+)`, 'm').exec(text);
    const value = match ? Number(match[1]) : NaN;
    return Number.isFinite(value) ? value : undefined;
  };
  const some = avg10('some');
  if (some === undefined) return null;
  if ((avg10('full') ?? 0) >= 5) return 'critical';
  return some >= 10 ? 'warn' : 'normal';
}

export interface PressureProbe {
  platform: NodeJS.Platform;
  /** Resolves with the command's stdout. */
  execFile: (file: string, args: string[]) => Promise<string>;
  readFile: (file: string) => Promise<string>;
}

const defaultProbe: PressureProbe = {
  platform: process.platform,
  execFile: (file, args) =>
    new Promise((resolve, reject) =>
      execFile(file, args, { timeout: SYSCTL_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      ),
    ),
  readFile: (file) => readFile(file, 'utf8'),
};

/** One measurement on this machine; null on another system or when nothing could be read. May reject. */
export async function measurePressure(probe: PressureProbe = defaultProbe): Promise<PressureReading | null> {
  if (probe.platform === 'darwin') {
    const level = parseDarwinPressure(
      await probe.execFile('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    );
    return level ? { level, source: 'sysctl' } : null;
  }
  if (probe.platform === 'linux') {
    const level = parseLinuxPressure(await probe.readFile('/proc/pressure/memory'));
    return level ? { level, source: 'psi' } : null;
  }
  return null;
}

/** The level of a reading of the folder at most `PRESSURE_FRESH_MS` old; null when it is stale, missing or broken. */
export async function readFreshPressure(dir: string, now = Date.now()): Promise<PressureLevel | null> {
  try {
    const value = JSON.parse(await readFile(path.join(dir, PRESSURE_FILE), 'utf8')) as Partial<PressureFile>;
    const at = typeof value.at === 'string' ? Date.parse(value.at) : NaN;
    if (!(Math.abs(now - at) <= PRESSURE_FRESH_MS)) return null;
    return value.level === 'normal' || value.level === 'warn' || value.level === 'critical'
      ? value.level
      : null;
  } catch {
    return null;
  }
}

/** Written under another name and renamed, so a reader never sees half of it. */
export async function writePressure(dir: string, reading: PressureReading, now = Date.now()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, PRESSURE_FILE);
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const content: PressureFile = {
    level: reading.level,
    at: new Date(now).toISOString(),
    source: reading.source,
  };
  try {
    await writeFile(temp, JSON.stringify(content), { mode: 0o600 });
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface PressureMeterOptions {
  /** The pool's folder. */
  dir: string;
  measure?: () => Promise<PressureReading | null>;
  intervalMs?: number;
  /** Told once, at the first failed round; the meter goes on. */
  onError?: (err: unknown) => void;
  /** The clock of the freshness of `level()`; default `Date.now`. */
  now?: () => number;
}

export interface PressureMeter {
  /**
   * The level of the last successful measurement, from this process's memory (PM-1328: the engine never
   * decides from the members-writable `pressure.json`); null when it is older than `PRESSURE_FRESH_MS` or
   * there is none.
   */
  level(): PressureLevel | null;
  /** Stops the timer and waits for a round in progress; nothing is written after it. */
  close(): Promise<void>;
}

/** Measures at once, then every `intervalMs`; a round without a reading writes nothing, so the file goes stale. */
export function startPressureMeter(options: PressureMeterOptions): PressureMeter {
  const measure = options.measure ?? (() => measurePressure());
  const now = options.now ?? Date.now;
  let closed = false;
  let warned = false;
  let running: Promise<void> | undefined;
  let last: { level: PressureLevel; at: number } | undefined;
  const round = (): void => {
    if (closed || running) return;
    running = (async () => {
      try {
        const reading = await measure();
        if (reading) {
          last = { level: reading.level, at: now() };
          await writePressure(options.dir, reading);
        }
      } catch (err) {
        if (!warned) {
          warned = true;
          options.onError?.(err);
        }
      }
    })().finally(() => {
      running = undefined;
    });
  };
  round();
  const timer = setInterval(round, options.intervalMs ?? PRESSURE_INTERVAL_MS);
  timer.unref();
  return {
    level: () => (last && now() - last.at <= PRESSURE_FRESH_MS ? last.level : null),
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
