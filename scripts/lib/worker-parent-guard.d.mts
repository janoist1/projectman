/** Types of `worker-parent-guard.mjs`, for the TypeScript tests. */

export interface WorkerParentGuardOptions {
  target?: NodeJS.Process;
  /** Default: SIGKILL to itself (a vitest worker's `process.exit` throws). */
  exit?: () => void;
  intervalMs?: number;
}

/** Installs the guard in this process, once. Returns true when it was installed now. */
export function guardWorkerParent(options?: WorkerParentGuardOptions): boolean;
