import { z } from 'zod';
import { isIntegratorInboxItem, questionPayloadOf } from './inbox';
import type { InboxItem } from './inbox';

/**
 * What waits for someone other than the owners (PM-1241, PM-1252): the questions that wait for the project
 * manager's screening, and the open todos of the connected Claude (the integrator). It is a summary, not an
 * item: it is not counted in the inbox numbers and it sends no push. One rule for the server and the web's
 * fake backend.
 */

const WaitingKind = z.object({
  count: z.number().int().min(0),
  /** ISO: since when the oldest one waits; null when none waits. */
  oldestAt: z.string().nullable(),
});

export const WaitingForOthers = z.object({
  /** Questions that wait for the project manager's screening (`payload.screening.waiting`). */
  screening: WaitingKind,
  /** Open integrator todos (`isIntegratorInboxItem`). */
  integrator: WaitingKind,
});
export type WaitingForOthers = z.infer<typeof WaitingForOthers>;

/** Since when a question waits for the screening, or null when it does not wait for it. */
export function screeningWaitingSince(item: Pick<InboxItem, 'kind' | 'state' | 'payload'>): string | null {
  if (item.kind !== 'question' || item.state !== 'screening') return null;
  return questionPayloadOf(item)?.screening?.waiting?.since ?? null;
}

/** Since when an open integrator todo waits (it was opened to the integrator at that time), or null. */
function integratorWaitingSince(item: InboxItem): string | null {
  if (item.state !== 'open' || !isIntegratorInboxItem(item)) return null;
  const opened = item.payload.integratorOpenedAt;
  return typeof opened === 'string' ? opened : item.createdAt;
}

const summarize = (times: string[]) => ({
  count: times.length,
  oldestAt: times.length > 0 ? times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null,
});

/** The summary of what waits for others in `items` (any states; only the waiting ones count). */
export function waitingForOthers(items: readonly InboxItem[]): WaitingForOthers {
  const screening: string[] = [];
  const integrator: string[] = [];
  for (const item of items) {
    const since = screeningWaitingSince(item);
    if (since) {
      screening.push(since);
      continue;
    }
    const opened = integratorWaitingSince(item);
    if (opened) integrator.push(opened);
  }
  return { screening: summarize(screening), integrator: summarize(integrator) };
}
