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
