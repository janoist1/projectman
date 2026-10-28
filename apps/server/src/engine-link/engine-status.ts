import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeSecretFile } from './engine-config';

/**
 * `<home>/engine-status.json` (PM-314): what `npm run engine -- status` shows. No secret goes in:
 * no key, no token, no URL with credentials; error messages are the engine's own fixed texts.
 */
export const EngineStatus = z.strictObject({
  pid: z.number().int(),
  bootId: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  connection: z.enum(['connecting', 'connected', 'disconnected', 'stopped']),
  connectedSince: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  lastError: z.strictObject({ at: z.string(), code: z.string(), message: z.string() }).optional(),
  pendingEvents: z.number().int().nonnegative(),
  droppedEvents: z.number().int().nonnegative(),
  /** PM-1087: the version and release the engine runs (as in the hello); optional like the fields below. */
  version: z.string().optional(),
  releaseTag: z.string().nullable().optional(),
  running: z.array(
    z.strictObject({
      sessionId: z.string(),
      state: z.string(),
      member: z.string().optional(),
      provider: z.string().optional(),
      /** The session's display name ("{name} · {work}"); never a prompt, path or token. */
      label: z.string().optional(),
      startedAt: z.string().optional(),
    }),
  ),
  /** PM-1086: optional, since a newer CLI also reads the file of an older engine. */
  work: z
    .strictObject({
      sessions: z.number().int().nonnegative(),
      fullTests: z.number().int().nonnegative(),
      screenshots: z.number().int().nonnegative(),
    })
    .optional(),
  keepAwake: z
    .strictObject({
      mode: z.enum(['while_working', 'off']),
      holding: z.boolean(),
      since: z.string().optional(),
      unsupported: z.boolean().optional(),
    })
    .optional(),
});
export type EngineStatus = z.infer<typeof EngineStatus>;

type RunningEntry = EngineStatus['running'][number];

export interface RunningTracker {
  /** Remembers what the cloud's `session.start` said about the session (no prompt, token or path). */
  started(spec: { sessionId: string; member?: string; provider?: string; displayName: string }): void;
  /** The runner reported the exit. */
  exited(sessionId: string): void;
  /** The runner's live list with the remembered details; a session the runner no longer lists is dropped. */
  decorate(live: Array<{ sessionId: string; state: string }>): RunningEntry[];
}

export function createRunningTracker(now: () => Date = () => new Date()): RunningTracker {
  const known = new Map<string, Omit<RunningEntry, 'sessionId' | 'state'>>();
  return {
    started(spec) {
      known.set(spec.sessionId, {
        ...(spec.member ? { member: spec.member } : {}),
        ...(spec.provider ? { provider: spec.provider } : {}),
        label: spec.displayName,
        startedAt: now().toISOString(),
      });
    },
    exited: (sessionId) => void known.delete(sessionId),
    decorate(live) {
      const ids = new Set(live.map((session) => session.sessionId));
      for (const id of known.keys()) if (!ids.has(id)) known.delete(id);
      return live.map(({ sessionId, state }) => ({ sessionId, state, ...known.get(sessionId) }));
    },
  };
}

export interface EngineStatusWriter {
  get(): EngineStatus;
  set(patch: Partial<Omit<EngineStatus, 'pid' | 'bootId' | 'startedAt' | 'updatedAt'>>): void;
  /** Writes now, whatever is waiting. */
  flush(): void;
}

export function createEngineStatusWriter(
  file: string,
  initial: { pid: number; bootId: string },
  options: { now?: () => Date; delayMs?: number } = {},
): EngineStatusWriter {
  const now = options.now ?? (() => new Date());
  let status: EngineStatus = {
    pid: initial.pid,
    bootId: initial.bootId,
    startedAt: now().toISOString(),
    updatedAt: now().toISOString(),
    connection: 'connecting',
    attempts: 0,
    pendingEvents: 0,
    droppedEvents: 0,
    running: [],
  };
  let timer: NodeJS.Timeout | null = null;
  const write = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    status = { ...status, updatedAt: now().toISOString() };
    try {
      writeSecretFile(file, `${JSON.stringify(status, null, 2)}\n`);
    } catch {
      // The status file is a convenience; the engine goes on without it.
    }
  };
  return {
    get: () => status,
    set(patch) {
      status = { ...status, ...patch };
      if (!timer) {
        timer = setTimeout(write, options.delayMs ?? 200);
        timer.unref();
      }
    },
    flush: write,
  };
}

/** The file as `status` shows it; null when it is missing or not an engine status. */
export function readEngineStatus(file: string): EngineStatus | null {
  try {
    const parsed = EngineStatus.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
