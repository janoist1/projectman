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
  running: z.array(z.strictObject({ sessionId: z.string(), state: z.string() })),
});
export type EngineStatus = z.infer<typeof EngineStatus>;

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
