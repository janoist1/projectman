import type { HeavyLockEntry, HeavyWait } from '../../apps/server/src/full-test/heavy-lock';

// What the heavy CLI (`run.ts`) and the vitest places plugin (`vitest-places.mjs`) tell, and the exit
// statuses they share: one text for the same event, whoever asked for the places.

/** Exit status of a `--max-wait` that ran out (EX_TEMPFAIL). */
export const EXIT_QUEUE_TIMEOUT = 75;
/** Exit status of a command that did not run because the queue folder cannot be used (EX_CONFIG, PM-346). */
export const EXIT_QUEUE_UNAVAILABLE = 78;
/** Exit status of a command that did not start because the same command of the session is still running. */
export const EXIT_ALREADY_RUNNING = 79;

/** `3m05s`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

function clock(iso: string | undefined): string {
  const date = iso ? new Date(iso) : undefined;
  if (!date || Number.isNaN(date.getTime())) return '?';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** Who holds the places, how many are free and how many waiters are ahead. */
export function waitingLine(wait: HeavyWait & { waitedMs: number }): string {
  const holding = (holder: HeavyLockEntry): string =>
    `"${holder.label}" since ${clock(holder.since ?? holder.queuedAt)} (${holder.granted ?? wait.capacity} of ${wait.capacity} places)`;
  const who = wait.holders.length > 0 ? wait.holders.map(holding).join(', ') : 'someone';
  const pressure =
    wait.pressure === 'critical'
      ? "heavy: the machine's memory pressure is critical: no places are handed out until it eases\n"
      : '';
  return `heavy: waiting for the machine's heavy-run queue (${wait.free} of ${wait.capacity} places free): ${who}, ${wait.ahead} ahead of you (waited ${formatDuration(wait.waitedMs)})\n${pressure}`;
}

/** The queue cannot be used, so the command did not run (owner's decision, PM-346). */
export function unavailableMessage(label: string, reason: string): string {
  // Without the queue a member's full test would run beside the others and overload the machine.
  return (
    `heavy: the machine's heavy-run queue cannot be used, so this did not run: ${label}\n` +
    `heavy: ${reason}\n` +
    'heavy: running it without the queue would overload the machine; do not run it another way.\n' +
    'heavy: note on your task that this did not run and why, and hand over; do not ask for it to run outside your sandbox: the full test runs on the server.\n'
  );
}
