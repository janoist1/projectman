import { WorkQueueReason, isWorkQueueLongWait } from '@projectman/shared';
import type { WorkQueueGroup, WorkQueueItem, WorkQueueRef, WorkQueuesView } from '@projectman/shared';
import { parseWorkQueueRef, sameWorkQueue, workQueueRefId } from '../../lib/workQueues';

/** What the view's filters hold (the search parameters `queue`, `reason`, `long` and `q`). */
export interface WorkQueueFilter {
  queue: WorkQueueRef | null;
  reason: WorkQueueReason | null;
  long: boolean;
  q: string;
}

export const NO_WORK_QUEUE_FILTER: WorkQueueFilter = { queue: null, reason: null, long: false, q: '' };

/** The filters of the URL; a value that is not valid reads as no filter (the view then clears it from the URL). */
export function parseWorkQueueFilter(params: URLSearchParams): WorkQueueFilter {
  const reason = WorkQueueReason.safeParse(params.get('reason'));
  return {
    queue: parseWorkQueueRef(params.get('queue')),
    reason: reason.success ? reason.data : null,
    long: params.get('long') === '1',
    q: params.get('q') ?? '',
  };
}

/** The search parameters a filter writes; the ones it does not own (`view`) stay as they are. */
export function writeWorkQueueFilter(params: URLSearchParams, filter: WorkQueueFilter): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (name: string, value: string | null) => (value ? next.set(name, value) : next.delete(name));
  set('queue', filter.queue ? workQueueRefId(filter.queue) : null);
  set('reason', filter.reason);
  set('long', filter.long ? '1' : null);
  set('q', filter.q.trim() === '' ? null : filter.q);
  return next;
}

/** Whether the URL holds a filter value that is not valid or not canonical, so the view can clear it. */
export function hasStaleWorkQueueParams(params: URLSearchParams): boolean {
  const filter = parseWorkQueueFilter(params);
  const clean = writeWorkQueueFilter(params, filter);
  for (const name of ['queue', 'reason', 'long', 'q']) {
    if (params.has(name) && params.get(name) !== clean.get(name)) return true;
  }
  return false;
}

export function isWorkQueueFiltered(filter: WorkQueueFilter): boolean {
  return filter.queue !== null || filter.reason !== null || filter.long || filter.q.trim() !== '';
}

/** Whether the item passes the reason, long-wait and search filters (the queue filter picks the groups). */
export function matchesWorkQueueFilter(item: WorkQueueItem, filter: WorkQueueFilter, nowMs: number): boolean {
  if (filter.reason !== null && item.reason !== filter.reason) return false;
  if (filter.long && !isWorkQueueLongWait(item, nowMs)) return false;
  const needle = filter.q.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return (
    item.title.toLocaleLowerCase().includes(needle) ||
    (item.taskKey ?? '').toLocaleLowerCase().includes(needle)
  );
}

/** Whether the group lists fewer open items than it counts: the overview cut it. */
export function isCutGroup(group: WorkQueueGroup): boolean {
  return group.items.length < (group.queued ?? 0) + (group.processing ?? 0);
}

/** How many open items a cut group does not list. */
export function hiddenItemCount(group: WorkQueueGroup): number {
  return Math.max(0, (group.queued ?? 0) + (group.processing ?? 0) - group.items.length);
}

export interface WorkQueueTotals {
  queued: number;
  processing: number;
  long: number;
  /** A group was cut, so `long` may be higher: the tile reads "≥". */
  longAtLeast: boolean;
}

/** The numbers of the tiles: over everything the viewer may see, whatever the filters say. */
export function workQueueTotals(groups: readonly WorkQueueGroup[], nowMs: number): WorkQueueTotals {
  const totals: WorkQueueTotals = { queued: 0, processing: 0, long: 0, longAtLeast: false };
  for (const group of groups) {
    if (group.restricted) continue;
    totals.queued += group.queued ?? 0;
    totals.processing += group.processing ?? 0;
    totals.long += group.items.filter((item) => isWorkQueueLongWait(item, nowMs)).length;
    if (isCutGroup(group)) totals.longAtLeast = true;
  }
  return totals;
}

interface WorkQueueEntry {
  group: WorkQueueGroup;
  items: WorkQueueItem[];
}

/** What the view lists, from the filters. */
export interface WorkQueueLayout {
  /** Groups with at least one matching item, the longest-waiting first. */
  itemized: WorkQueueEntry[];
  /** The integrator group the viewer sees but whose items they may not (an admin). */
  restricted: WorkQueueGroup | null;
  /** The group shown although it has no matching item: the integrator while unfiltered, or the picked queue. */
  bare: WorkQueueGroup[];
  /** The member queues with nothing open, under "Üres sorok" (unfiltered view only). */
  empty: WorkQueueGroup[];
  /** Open items of every visible group, before the filters. */
  openCount: number;
  /** Whether any visible group ever held an item. */
  everQueued: boolean;
  /** The queue the filter names is not among the groups. */
  missingQueue: boolean;
}

function oldestQueuedMs(items: readonly WorkQueueItem[]): number {
  let oldest = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (item.state === 'queued') oldest = Math.min(oldest, Date.parse(item.queuedAt));
  }
  return oldest;
}

export function layoutWorkQueues(
  view: WorkQueuesView,
  filter: WorkQueueFilter,
  nowMs: number,
): WorkQueueLayout {
  const filtered = isWorkQueueFiltered(filter);
  const picked = filter.queue;
  const pickedGroup = picked ? view.groups.find((group) => sameWorkQueue(group.queue, picked)) : undefined;
  const scope = pickedGroup ? [pickedGroup] : picked ? [] : view.groups;

  const entries = scope
    .filter((group) => !group.restricted)
    .map((group) => ({
      group,
      items: group.items.filter((item) => matchesWorkQueueFilter(item, filter, nowMs)),
    }));
  const itemized = entries
    .filter((entry) => entry.items.length > 0)
    .sort((a, b) => oldestQueuedMs(a.items) - oldestQueuedMs(b.items));

  const restricted = scope.find((group) => group.restricted) ?? null;
  const bare: WorkQueueGroup[] = [];
  if (pickedGroup && !pickedGroup.restricted && !itemized.some((e) => e.group === pickedGroup)) {
    bare.push(pickedGroup);
  } else if (!filtered) {
    const integrator = view.groups.find((group) => group.queue.type === 'integrator');
    if (integrator && !integrator.restricted && !itemized.some((e) => e.group === integrator)) {
      bare.push(integrator);
    }
  }
  // A developer sees the project manager's queue alone: it stands on its own even when empty.
  if (!filtered && view.scope === 'project_manager') {
    for (const entry of entries) {
      if (entry.items.length === 0 && !bare.includes(entry.group)) bare.push(entry.group);
    }
  }
  const empty =
    filtered || view.scope === 'project_manager'
      ? []
      : view.groups.filter(
          (group) =>
            group.queue.type === 'member' &&
            !group.restricted &&
            !itemized.some((entry) => entry.group === group),
        );

  const visible = view.groups.filter((group) => !group.restricted);
  return {
    itemized,
    restricted,
    bare,
    empty,
    openCount: visible.reduce((sum, group) => sum + group.items.length, 0),
    everQueued: visible.some((group) => group.everQueued),
    missingQueue: picked !== null && pickedGroup === undefined,
  };
}
