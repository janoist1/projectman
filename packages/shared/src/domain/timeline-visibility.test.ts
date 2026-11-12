import { expect, it } from 'vitest';
import type { TimelineEvent } from './event';
import { canSeeTimelineEvent } from './timeline-visibility';

it.each(['client', 'developer'] as const)('checks follow-up visibility for %s', (access) => {
  const event: TimelineEvent = {
    id: 'evt_follow',
    projectKey: 'AR',
    taskKey: 'AR-1',
    sessionId: null,
    actor: { kind: 'ai', handle: 'cr' },
    type: 'review_follow_ups',
    data: { items: ['Reuse the helper'] },
    createdAt: '2026-11-12T10:00:00Z',
  };
  expect(canSeeTimelineEvent({ access, handle: 'reader' }, event, () => null)).toBe(access !== 'client');
});
