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
 * The alert a card's conversation calls for now, or null. `entries` are those of the card since
 * `messageBurstSince`; `earlier` are the card's message storm alerts so far (open or not, `at`
 * being the `at` of their payload).
 *
 * One alert per storm: none while an earlier one is open, and once it is closed the next one comes
 * only when a whole window has passed since the last alert was raised, so every entry counted is
 * new.
 */
export function messageBurstAlertFor(input: {
  taskKey: string;
  burst: MessageBurst;
  now: Date;
  entries: readonly BurstEntry[];
  earlier: readonly { open: boolean; at: string }[];
}): MessageBurstAlert | null {
  const { burst, entries } = input;
  if (entries.length < burst.count) return null;
  const since = messageBurstSince(burst, input.now);
  if (input.earlier.some((alert) => alert.open || alert.at > since)) return null;
  return {
    alert: 'message_burst',
    taskKey: input.taskKey,
    count: entries.length,
    minutes: burst.minutes,
    members: burstMembers(entries),
    at: input.now.toISOString(),
  };
}
