import { z } from 'zod';

/**
 * The server's full test of a task's pinned commit before it is reviewed (PM-217): `queued` waits for
 * its turn, `running` is in its sandbox, `passed`/`failed` are the command's verdict, `error` means it
 * could not run (`FullTestErrorReason`), `cancelled` was dropped before it ended (`FullTestCancelReason`).
 */
export const FullTestStatus = z.enum(['queued', 'running', 'passed', 'failed', 'error', 'cancelled']);
export type FullTestStatus = z.infer<typeof FullTestStatus>;

export const FullTestErrorReason = z.enum([
  'timeout',
  'sandbox_unavailable',
  'pty_unavailable',
  'checkout_dirty',
  'spawn_failed',
  'killed',
  // The engine's link was lost while the run was on its way (hybrid mode, PM-315).
  'engine_offline',
  // A run that requires the machine's heavy-run queue (PM-658) found it missing or unusable.
  'heavy_lock_unavailable',
  // The dependencies the run needs could not be prepared (PM-681), or the executor cannot prepare them yet.
  'dependency_install_failed',
]);
export type FullTestErrorReason = z.infer<typeof FullTestErrorReason>;

export const FullTestCancelReason = z.enum([
  'repinned',
  'stage_left',
  'branch_moved',
  'interrupted',
  'shutdown',
]);
export type FullTestCancelReason = z.infer<typeof FullTestCancelReason>;
