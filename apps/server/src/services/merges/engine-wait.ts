import { MERGE_ENGINE_WAIT_MINUTES } from '@projectman/shared';
import type { EngineId } from '@projectman/shared';
import type { EngineDirectory } from '../../contracts';

/** Engine losses one merge run waits through, then it blocks. */
export const MERGE_ENGINE_LOSSES = 5;
export const MERGE_ENGINE_WAIT_MS = MERGE_ENGINE_WAIT_MINUTES * 60_000;

export function waitForEngine(
  engines: EngineDirectory,
  id: EngineId,
  waitMs: number,
  signal?: AbortSignal,
): Promise<'connected' | 'timeout' | 'aborted'> {
  if (signal?.aborted) return Promise.resolve('aborted');
  if (engines.awaitConnected) return engines.awaitConnected(id, waitMs, signal);
  return Promise.resolve(engines.get(id) !== null ? 'connected' : 'timeout');
}
