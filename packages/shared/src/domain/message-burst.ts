import { DEFAULT_MESSAGE_BURST } from '../config/schema';
import type { MessageBurst } from '../config/schema';
import type { MessageBurstAlert } from './inbox';

/**
 * The message storm rule (PM-186, rule 5 of PM-176), shared by the server and the web's fake
 * backend. The entries counted are the team messages and notes (not imported ones) of one card.
 */

const MINUTE_MS = 60_000;

/** An entry of a card's conversation: when, who wrote it and (for a team message) who it went to. */
export interface BurstEntry {
  createdAt: string;
  actor: string | null;
  to?: readonly string[];
}

/** The threshold a project's limits set, else the default. */
export function messageBurstOf(limits: { messageBurst?: MessageBurst }): MessageBurst {
  return limits.messageBurst ?? DEFAULT_MESSAGE_BURST;
}

/** The start (ISO time) of the window that ends at `now`. */
export function messageBurstSince(burst: MessageBurst, now: Date): string {
  return new Date(now.getTime() - burst.minutes * MINUTE_MS).toISOString();
}

/** Who wrote or was written to in these entries, in the order they first appear. */
export function burstMembers(entries: readonly BurstEntry[]): string[] {
  const handles = new Set<string>();
  for (const entry of entries) {
    if (entry.actor) handles.add(entry.actor);
    for (const handle of entry.to ?? []) handles.add(handle);
  }
  return [...handles];
}

/**
 * Whether a whole window of quiet came between `from` and the end of `times` (ascending, ms): a
 * stretch of at least `windowMs` in which no window of that length held `count` entries. An entry
 * at time t is counted by the windows that end from t to t + `windowMs`; `count` entries within
 * `windowMs` of each other make everything from the last of them until the first one leaves the
 * window "hot". The last of `times` is the entry now, and it ends a hot stretch.
 */
function hadQuietWindow(times: readonly number[], from: number, burst: MessageBurst): boolean {
  const windowMs = burst.minutes * MINUTE_MS;
  let quietFrom = from;
  for (let i = burst.count - 1; i < times.length; i++) {
    const first = times[i - burst.count + 1]!;
    if (times[i]! - first > windowMs) continue;
    if (times[i]! - quietFrom >= windowMs) return true;
    quietFrom = Math.max(quietFrom, first + windowMs);
  }
  return false;
}

/**
 * The alert a card's conversation calls for now, or null. `entries` are the card's, the most
 * recent ones, oldest first, at least those of the window ending at `now` and, when there is an
 * earlier alert, those since a window before the last one was raised; `coveredFrom` (ISO time) is
 * where they begin when the list was cut short, else they are taken to cover everything.
 * `earlier` are the card's message storm alerts so far (open or not, `at` being the `at` of their
 * payload).
 *
 * One alert per storm: none while an earlier one is open. Once it is closed the next one comes
 * only when a whole window of quiet followed the last alert (a stretch of `minutes` minutes in
 * which fewer than `count` entries fell in any window) before the storm that is on now. The
 * entries up to that alert are not counted in the new one, but they keep the windows just after it
 * hot. A storm that goes on after the owner has seen its alert therefore raises nothing more.
 */
export function messageBurstAlertFor(input: {
  taskKey: string;
  burst: MessageBurst;
  now: Date;
  entries: readonly BurstEntry[];
  earlier: readonly { open: boolean; at: string }[];
  coveredFrom?: string;
}): MessageBurstAlert | null {
  const { burst, earlier } = input;
  if (earlier.some((alert) => alert.open)) return null;
  const lastAlert = Math.max(...earlier.map((alert) => Date.parse(alert.at)));
  // Only what was written after the last alert is counted (the entry that raised it belongs to it).
  const windowStart = Date.parse(messageBurstSince(burst, input.now));
  const counted = input.entries.filter((entry) => {
    const at = Date.parse(entry.createdAt);
    return at >= windowStart && (earlier.length === 0 || at > lastAlert);
  });
  if (counted.length < burst.count) return null;
  if (earlier.length) {
    // The quiet is looked for from the alert on, but the entries before it still make the windows
    // after it hot for up to a window, so they are in the list the walk goes through.
    const covered = input.coveredFrom ? Date.parse(input.coveredFrom) : lastAlert;
    const times = input.entries.map((entry) => Date.parse(entry.createdAt)).sort((a, b) => a - b);
    if (!hadQuietWindow(times, Math.max(lastAlert, covered), burst)) return null;
  }
  return {
    alert: 'message_burst',
    taskKey: input.taskKey,
    count: counted.length,
    minutes: burst.minutes,
    members: burstMembers(counted),
    at: input.now.toISOString(),
  };
}
