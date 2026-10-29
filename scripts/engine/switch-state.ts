import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const EngineSwitchState = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.enum(['switching', 'rolled_back', 'recovery_required']),
  target: z.strictObject({ version: z.string(), tag: z.string().nullable() }),
  previous: z.strictObject({ version: z.string(), tag: z.string().nullable() }).nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
});
export type EngineSwitchState = z.infer<typeof EngineSwitchState>;

export function switchPaths(home: string) {
  return {
    state: path.join(home, 'engine-switch.json'),
    previous: path.join(home, 'engine-switch.previous.plist'),
    lock: path.join(home, 'engine-switch.lock'),
  };
}

/** Invalid state is an error: callers must never mistake it for an idle switch. */
export function readSwitchState(home: string): EngineSwitchState | null {
  const file = switchPaths(home).state;
  return existsSync(file) ? EngineSwitchState.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;
}
