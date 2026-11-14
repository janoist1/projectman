import { describe, expect, it } from 'vitest';
import {
  configChangeArea,
  isoWeekKey,
  OPERATIONS_REVIEW_INTERVAL_DAYS,
  operationsReview,
  operationsReviewDue,
} from './operations-review';
import type { OperationsReviewInput } from './operations-review';
import type { ClosedCardMeasure } from './card-measure';

const NOW = '2026-11-14T12:00:00.000Z';
const hoursBefore = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

function closedCard(
  taskKey: string,
  closedAt: string,
  rounds: Partial<ClosedCardMeasure['rounds']> = {},
  tokens = 0,
): ClosedCardMeasure {
  return {
    taskKey,
    title: taskKey,
    closedAt,
    implementer: null,
    reviewer: null,
    implementerModels: [],
    tokens,
    byModel: [],
    rounds: {
      reviewRounds: 0,
      changeRequests: 0,
      designChangeRequests: 0,
      sendBacks: 0,
      testsFailed: 0,
      ...rounds,
    } as ClosedCardMeasure['rounds'],
    unmeasuredSessions: 0,
  };
}

const empty: OperationsReviewInput = { now: NOW, closed: [], createdAt: {}, open: [], humanItems: [] };

describe('operationsReview', () => {
  it('counts nothing and knows no lead time without closed cards', () => {
    expect(operationsReview(empty)).toEqual({
      closedCards: 0,
      medianLeadHours: null,
      fixRounds: 0,
      sendBacks: 0,
      waitingForPeople: { count: 0, oldestAgeHours: null },
      stuckCards: [],
      tokens: 0,
    });
  });

  it('takes the median lead time of the cards whose creation is known, in one decimal', () => {
    const review = operationsReview({
      ...empty,
      closed: [
        closedCard('PM-1', hoursBefore(0)),
        closedCard('PM-2', hoursBefore(0)),
        closedCard('PM-3', hoursBefore(0)),
        closedCard('PM-4', hoursBefore(0)),
      ],
      createdAt: { 'PM-1': hoursBefore(10), 'PM-2': hoursBefore(4.5), 'PM-3': hoursBefore(30) },
    });
    expect(review.closedCards).toBe(4);
    expect(review.medianLeadHours).toBe(10);
  });

  it('averages the two middle lead times of an even count', () => {
    const review = operationsReview({
      ...empty,
      closed: [closedCard('PM-1', hoursBefore(0)), closedCard('PM-2', hoursBefore(0))],
      createdAt: { 'PM-1': hoursBefore(3), 'PM-2': hoursBefore(8) },
    });
    expect(review.medianLeadHours).toBe(5.5);
  });

  it('sums the fix rounds of both reviews, the send-backs and the tokens', () => {
    const review = operationsReview({
      ...empty,
      closed: [
        closedCard('PM-1', NOW, { changeRequests: 2, designChangeRequests: 1, sendBacks: 1 }, 100),
        closedCard('PM-2', NOW, { changeRequests: 1, sendBacks: 2 }, 50),
      ],
    });
    expect(review).toMatchObject({ fixRounds: 4, sendBacks: 3, tokens: 150 });
  });

  it('counts what waits for people and the age of the oldest', () => {
    const review = operationsReview({
      ...empty,
      humanItems: [{ createdAt: hoursBefore(5) }, { createdAt: hoursBefore(26.25) }],
    });
    expect(review.waitingForPeople).toEqual({ count: 2, oldestAgeHours: 26.3 });
  });

  it('lists the work-stage cards idle for three days, the longest idle first, and no other card', () => {
    const review = operationsReview({
      ...empty,
      open: [
        { taskKey: 'PM-1', stageKind: 'work', lastActivityAt: hoursBefore(72) },
        { taskKey: 'PM-2', stageKind: 'work', lastActivityAt: hoursBefore(24 * 9) },
        { taskKey: 'PM-3', stageKind: 'work', lastActivityAt: hoursBefore(71) },
        { taskKey: 'PM-4', stageKind: 'queue', lastActivityAt: hoursBefore(24 * 20) },
      ],
    });
    expect(review.stuckCards).toEqual([
      { taskKey: 'PM-2', idleDays: 9 },
      { taskKey: 'PM-1', idleDays: 3 },
    ]);
  });
});

describe('operationsReviewDue', () => {
  const due = {
    now: NOW,
    setting: 'weekly' as const,
    hasProjectManager: true,
    lastReviewAt: hoursBefore(OPERATIONS_REVIEW_INTERVAL_DAYS * 24),
    projectCreatedAt: hoursBefore(24 * 100),
    moved: true,
  };

  it('is due a week after the last review when something moved', () => {
    expect(operationsReviewDue(due)).toBe(true);
  });

  it.each([
    ['the last review is under a week old', { lastReviewAt: hoursBefore(24 * 7 - 1) }],
    ['nothing moved', { moved: false }],
    ['the setting is off', { setting: 'off' as const }],
    ['there is no project manager', { hasProjectManager: false }],
  ])('is not due when %s', (_name, change) => {
    expect(operationsReviewDue({ ...due, ...change })).toBe(false);
  });

  it('waits for a week-old project when there was no review yet', () => {
    expect(operationsReviewDue({ ...due, lastReviewAt: null, projectCreatedAt: hoursBefore(24 * 6) })).toBe(
      false,
    );
    expect(operationsReviewDue({ ...due, lastReviewAt: null, projectCreatedAt: hoursBefore(24 * 7) })).toBe(
      true,
    );
  });
});

describe('isoWeekKey', () => {
  it.each([
    ['2026-11-14T12:00:00.000Z', '2026-W46'],
    ['2026-11-16T00:00:00.000Z', '2026-W47'],
    ['2026-01-01T10:00:00.000Z', '2026-W01'],
    ['2027-01-01T10:00:00.000Z', '2026-W53'],
    ['2024-12-30T10:00:00.000Z', '2025-W01'],
  ])('puts %s in %s', (at, key) => {
    expect(isoWeekKey(at)).toBe(key);
  });
});

describe('configChangeArea', () => {
  it('names the section, the stage with its fields, and the id of an added item', () => {
    expect(configChangeArea({ kind: 'section_changed', section: 'team' })).toBe('section team');
    expect(
      configChangeArea({ kind: 'stage_changed', id: 'review', name: 'Review', fields: ['kind', 'owners'] }),
    ).toBe('stage_changed review (kind, owners)');
    expect(configChangeArea({ kind: 'label_added', id: 'ui', name: 'UI' })).toBe('label_added ui');
  });
});
