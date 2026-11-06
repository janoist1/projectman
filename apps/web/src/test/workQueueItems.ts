import type { MemberQueueItem, WorkQueueItem } from '@projectman/shared';

export const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * A stored queue row. Its source is a card-level start, which every viewer who sees the queue may read, so a test
 * does not have to create the source record behind it.
 */
export function queueItem(partial: Partial<MemberQueueItem> & Pick<MemberQueueItem, 'id'>): MemberQueueItem {
  return {
    projectKey: 'AC',
    member: 'pm',
    kind: 'todo',
    source: { type: 'start', startKey: partial.id },
    place: { type: 'general' },
    wake: true,
    state: 'queued',
    title: `Item ${partial.id}`,
    from: 'owner',
    taskKey: null,
    queuedAt: minutesAgo(5),
    startedAt: null,
    closedAt: null,
    closeReason: null,
    attempts: 0,
    restartedAt: null,
    sessionId: null,
    wait: null,
    outcome: null,
    ...partial,
  };
}

/** An open item of the connected Claude's queue, as the read model serves it. */
export function integratorItem(partial: Partial<WorkQueueItem> & Pick<WorkQueueItem, 'id'>): WorkQueueItem {
  return {
    queue: { type: 'integrator' },
    kind: 'todo',
    source: { type: 'inbox', inboxItemId: partial.id },
    place: { type: 'general' },
    title: `Claude item ${partial.id}`,
    from: 'owner',
    taskKey: null,
    state: 'queued',
    queuedAt: minutesAgo(5),
    startedAt: null,
    reason: 'human',
    reasonCode: null,
    reasonSince: null,
    waitFacts: null,
    attempts: 0,
    restartedAt: null,
    closedAt: null,
    closeReason: null,
    outcome: null,
    ...partial,
  };
}
