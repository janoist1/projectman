import { describe, expect, it } from 'vitest';
import type { WorkQueueGroup } from '@projectman/shared';
import { integratorItem, minutesAgo } from '../../test/workQueueItems';
import {
  hasStaleWorkQueueParams,
  parseWorkQueueFilter,
  workQueueTotals,
  writeWorkQueueFilter,
} from './workQueueFilters';

const params = (query: string) => new URLSearchParams(query);

describe('the work queue filters in the URL', () => {
  it('reads the queue, the reason, the long-wait flag and the search', () => {
    expect(parseWorkQueueFilter(params('view=queues&queue=member:pm&reason=usage&long=1&q=abc'))).toEqual({
      queue: { type: 'member', member: 'pm' },
      reason: 'usage',
      long: true,
      q: 'abc',
    });
  });

  it('reads an invalid reason, queue or flag as no filter and marks them stale', () => {
    const query = params('view=queues&queue=nobody&reason=bogus&long=yes');
    expect(parseWorkQueueFilter(query)).toEqual({ queue: null, reason: null, long: false, q: '' });
    expect(hasStaleWorkQueueParams(query)).toBe(true);
    expect(hasStaleWorkQueueParams(params('view=queues&queue=integrator&reason=human&long=1'))).toBe(false);
  });

  it('writes only the parameters it owns and drops the empty ones', () => {
    const next = writeWorkQueueFilter(params('view=queues&reason=usage&q=old'), {
      queue: { type: 'integrator' },
      reason: null,
      long: true,
      q: '  ',
    });
    expect(next.toString()).toBe('view=queues&queue=integrator&long=1');
  });
});

describe('the work queue totals', () => {
  const group = (partial: Partial<WorkQueueGroup>): WorkQueueGroup => ({
    queue: { type: 'integrator' },
    items: [],
    queued: 0,
    processing: 0,
    everQueued: true,
    restricted: false,
    ...partial,
  });

  it('leaves a restricted group out and counts the long waits of the listed items', () => {
    const now = Date.now();
    const totals = workQueueTotals(
      [
        group({
          items: [
            integratorItem({ id: 'a', queuedAt: minutesAgo(31) }),
            integratorItem({ id: 'b', queuedAt: minutesAgo(29) }),
            integratorItem({ id: 'c', state: 'processing', queuedAt: minutesAgo(90) }),
          ],
          queued: 2,
          processing: 1,
        }),
        group({ queue: { type: 'member', member: 'pm' }, queued: null, processing: null, restricted: true }),
      ],
      now,
    );
    expect(totals).toEqual({ queued: 2, processing: 1, long: 1, longAtLeast: false });
  });

  it('reads "at least" when a group lists fewer items than it counts', () => {
    const totals = workQueueTotals(
      [group({ items: [integratorItem({ id: 'a', queuedAt: minutesAgo(40) })], queued: 5 })],
      Date.now(),
    );
    expect(totals).toMatchObject({ long: 1, longAtLeast: true });
  });
});
