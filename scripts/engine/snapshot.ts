import { existsSync, readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { engineFiles, loadEngineConfig } from '../../apps/server/src/engine-link/engine-config';
import type { EngineConfig } from '../../apps/server/src/engine-link/engine-config';
import { readEngineStatus } from '../../apps/server/src/engine-link/engine-status';
import type { EngineStatus } from '../../apps/server/src/engine-link/engine-status';
import { installedServiceFor, serviceInstallation, serviceLogPaths, serviceState } from './service';
import { EngineSwitchState, readSwitchState } from './switch-state';
import type { ServiceOptions } from './service';

/**
 * The machine-readable state of the engine on this machine (PM-1087, `npm run engine -- status --json`): the
 * only contract of the menu bar app and of any other shell. It is built from the engine's own files and one
 * `launchctl print`; it asks neither git nor the cloud. No secret goes in: no key, token, prompt or session path.
 */

export const EngineLocalSnapshot = z.strictObject({
  schemaVersion: z.literal(1),
  at: z.string(),
  home: z.string(),
  overall: z.enum(['running', 'no_cloud', 'stopped', 'not_initialised']),
  engine: z.strictObject({ id: z.string(), name: z.string().nullable(), cloudOrigin: z.string() }).nullable(),
  service: z.strictObject({
    supported: z.boolean(),
    installed: z.boolean(),
    loaded: z.boolean(),
    running: z.boolean(),
    pid: z.number().int().nullable(),
    manager: z.enum(['app', 'checkout']).nullable(),
  }),
  package: z.strictObject({ version: z.string(), tag: z.string().nullable(), root: z.string() }).nullable(),
  switch: EngineSwitchState.nullable(),
  process: z.strictObject({
    running: z.boolean(),
    pid: z.number().int().nullable(),
    startedAt: z.string().nullable(),
    version: z.string().nullable(),
    releaseTag: z.string().nullable(),
  }),
  link: z.strictObject({
    state: z.enum(['connected', 'connecting', 'disconnected', 'stopped', 'down']),
    since: z.string().nullable(),
    attempts: z.number().int(),
    lastError: z.strictObject({ at: z.string(), code: z.string(), message: z.string() }).nullable(),
    pendingEvents: z.number().int(),
    droppedEvents: z.number().int(),
  }),
  sessions: z.array(
    z.strictObject({
      sessionId: z.string(),
      state: z.string(),
      member: z.string().nullable(),
      provider: z.string().nullable(),
      label: z.string().nullable(),
      startedAt: z.string().nullable(),
    }),
  ),
  work: z.strictObject({
    sessions: z.number().int(),
    fullTests: z.number().int(),
    screenshots: z.number().int(),
  }),
  keepAwake: z.strictObject({
    mode: z.enum(['while_working', 'off']),
    holding: z.boolean(),
    since: z.string().nullable(),
    supported: z.boolean(),
  }),
  machine: z.strictObject({
    diskPath: z.string(),
    diskFreeBytes: z.number().nullable(),
    diskTotalBytes: z.number().nullable(),
    memTotalBytes: z.number(),
    memFreeBytes: z.number(),
    loadAverage1m: z.number(),
  }),
  logs: z.strictObject({ out: z.string(), err: z.string() }),
});
export type EngineLocalSnapshot = z.infer<typeof EngineLocalSnapshot>;

type Overall = EngineLocalSnapshot['overall'];

/**
 * The one rule for the overall state: no `engine.json` is not initialised; no status file or a process that
 * is gone is stopped; a live process whose link is connected is running, any other live process has no cloud.
 */
export function overallState(input: {
  initialised: boolean;
  processAlive: boolean;
  connection: EngineStatus['connection'] | null;
}): Overall {
  if (!input.initialised) return 'not_initialised';
  if (!input.processAlive) return 'stopped';
  return input.connection === 'connected' ? 'running' : 'no_cloud';
}

export interface SnapshotIo {
  home: string;
  now: () => Date;
  isRunning: (pid: number) => boolean;
  pathEnv: string;
  /** The launchd access of `service`; absent where there is none. Not darwin: no `launchctl` call. */
  launchd?: Omit<ServiceOptions, 'home' | 'pathEnv' | 'out'>;
  /** The platform the keep-awake default is judged for (default: this one). */
  platform?: NodeJS.Platform;
  /** The machine readings; tests name their own. */
  machine?: {
    disk: (dir: string) => { freeBytes: number; totalBytes: number };
    totalmem: () => number;
    freemem: () => number;
    loadavg1m: () => number;
  };
}

const defaultMachine: NonNullable<SnapshotIo['machine']> = {
  disk: (dir) => {
    const stats = statfsSync(dir);
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  },
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  loadavg1m: () => os.loadavg()[0] ?? 0,
};

function serviceOf(io: SnapshotIo): Pick<EngineLocalSnapshot, 'service' | 'package'> {
  const none = { installed: false, loaded: false, running: false, pid: null, manager: null };
  const { launchd } = io;
  if (!launchd || launchd.platform !== 'darwin')
    return { service: { supported: false, ...none }, package: null };
  // A LaunchAgent of another home is not this engine's service.
  const plist = installedServiceFor(io.home, launchd.agentsDir);
  if (!plist) return { service: { supported: true, ...none }, package: null };
  const state = serviceState({ ...launchd, home: io.home, pathEnv: io.pathEnv, out: () => undefined });
  const installed = serviceInstallation(readFileSync(plist, 'utf8'));
  return { service: { supported: true, ...state, manager: installed.manager }, package: installed.package };
}

/** Reporting remains available on corruption; mutation commands still use the strict reader. */
function switchOf(home: string, at: string): EngineLocalSnapshot['switch'] {
  try {
    return readSwitchState(home);
  } catch {
    return {
      schemaVersion: 1,
      phase: 'recovery_required',
      target: { version: 'unknown', tag: null },
      previous: null,
      startedAt: at,
      updatedAt: at,
      error: {
        code: 'switch_state_invalid',
        message: 'The engine switch state cannot be read; manual recovery is required.',
      },
    };
  }
}

/**
 * An engine without a configuration is `not_initialised`. A configuration that cannot be read is an error (the
 * caller exits 1): nothing is guessed about a machine whose state is not known. A missing or unreadable status
 * file is not: it reads as an engine that is not running.
 */
export function buildSnapshot(io: SnapshotIo): EngineLocalSnapshot {
  const files = engineFiles(io.home);
  const config: EngineConfig | null = existsSync(files.config) ? loadEngineConfig(io.home) : null;
  const status = readEngineStatus(files.status);
  const alive = status !== null && io.isRunning(status.pid);
  const platform = io.platform ?? process.platform;
  const machine = io.machine ?? defaultMachine;

  const diskPath = config?.workRoot ? path.resolve(io.home, config.workRoot) : io.home;
  let disk: { freeBytes: number; totalBytes: number } | null = null;
  try {
    disk = machine.disk(diskPath);
  } catch {
    // The disk is a convenience reading; null says it could not be read.
  }

  // A running engine reports what it is doing; a stopped one is doing nothing.
  const live = alive ? status : null;
  const running = live?.running ?? [];
  const { logOut, logErr } = serviceLogPaths(io.home);
  const keepAwake = live?.keepAwake;
  const at = io.now().toISOString();
  return {
    schemaVersion: 1,
    at,
    home: io.home,
    overall: overallState({
      initialised: config !== null,
      processAlive: alive,
      connection: live?.connection ?? null,
    }),
    engine: config
      ? {
          id: config.engineId,
          name: config.name ?? null,
          cloudOrigin: new URL(config.cloudUrl).origin,
        }
      : null,
    ...serviceOf(io),
    switch: switchOf(io.home, at),
    process: {
      running: alive,
      pid: live?.pid ?? null,
      startedAt: live?.startedAt ?? null,
      // The version of the last run stays known while the engine is stopped.
      version: status?.version ?? null,
      releaseTag: status?.releaseTag ?? null,
    },
    link: {
      state: live?.connection ?? 'down',
      since: live?.connectedSince ?? null,
      attempts: status?.attempts ?? 0,
      lastError: status?.lastError ?? null,
      pendingEvents: status?.pendingEvents ?? 0,
      droppedEvents: status?.droppedEvents ?? 0,
    },
    sessions: running.map((entry) => ({
      sessionId: entry.sessionId,
      state: entry.state,
      member: entry.member ?? null,
      provider: entry.provider ?? null,
      label: entry.label ?? null,
      startedAt: entry.startedAt ?? null,
    })),
    work: live?.work ?? { sessions: running.length, fullTests: 0, screenshots: 0 },
    keepAwake: {
      mode: keepAwake?.mode ?? config?.keepAwake ?? 'while_working',
      holding: keepAwake?.holding ?? false,
      since: keepAwake?.since ?? null,
      supported: keepAwake ? keepAwake.unsupported !== true : platform === 'darwin',
    },
    machine: {
      diskPath,
      diskFreeBytes: disk?.freeBytes ?? null,
      diskTotalBytes: disk?.totalBytes ?? null,
      memTotalBytes: machine.totalmem(),
      memFreeBytes: machine.freemem(),
      loadAverage1m: machine.loadavg1m(),
    },
    logs: { out: logOut, err: logErr },
  };
}
