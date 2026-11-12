import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from './event';
import { canSeeTimelineEvent } from './timeline-visibility';

const HIDDEN_FROM_CLIENT = [
  ['review_follow_ups', { items: ['Reuse the helper'] }],
  ['member_involved', { member: 'dev-2', reason: 'Knows the cart' }],
] as const;

describe.each(HIDDEN_FROM_CLIENT)('%s visibility', (type, data) => {
  it.each(['client', 'developer'] as const)('is checked for %s', (access) => {
    const event = {
      id: 'evt_hidden',
      projectKey: 'AR',
      taskKey: 'AR-1',
      sessionId: null,
      actor: { kind: 'ai', handle: 'cr' },
      type,
      data,
      createdAt: '2026-11-12T10:00:00Z',
    } as TimelineEvent;
    expect(canSeeTimelineEvent({ access, handle: 'reader' }, event, () => null)).toBe(access !== 'client');
  });
});
