import { describe, expect, it } from 'vitest';
import { ALERT_ROUTE_CLASS } from './item-route';
import type { AlertPayload } from './inbox';
import { SYSTEM_NOTICE_KINDS, systemNoticeOf, waitingDigestNotice } from './system-notice';

const sample: Partial<Record<string, AlertPayload>> = {
  session_tokens: {
    alert: 'session_tokens',
    countedTokens: 5,
    limitTokens: 4,
    workItem: { type: 'task', taskKey: 'AR-1' },
    sessionStartedAt: '2026-10-01T12:00:00.000Z',
  },
  provider_rate_limited: {
    alert: 'provider_rate_limited',
    provider: 'gemini',
    until: null,
    weeklyPercent: null,
    message: 'x'.repeat(400),
    workItem: { type: 'general' },
  },
  feedback_forwarded: { alert: 'feedback_forwarded', markId: 'm', author: 'cleo', excerpt: '', reason: 'r' },
  host_request_answered: {
    alert: 'host_request_answered',
    requestId: 'r',
    title: 'Need a right',
    outcome: 'answered',
    answer: '',
  },
  email_parked: {
    alert: 'email_parked',
    emailId: 'e',
    reason: 'unknown_sender',
    fromAddress: 'a@b.c',
    subject: 's',
    excerpt: '',
    attachmentNames: [],
  },
};

describe('systemNoticeOf', () => {
  it.each(Object.keys(sample))('turns %s into a notice of its own kind', (alert) => {
    const notice = systemNoticeOf(sample[alert]!);
    expect(notice?.notice).toBe(alert);
    expect(SYSTEM_NOTICE_KINDS).toContain(notice!.notice);
    expect(notice!.text).not.toBe('');
  });

  it('keeps only values that are present and cuts a long message', () => {
    const notice = systemNoticeOf(sample.provider_rate_limited!)!;
    expect(notice.params).not.toHaveProperty('until');
    expect(String(notice.params.message).length).toBeLessThan(400);
  });

  it('names the card only when the session works on one', () => {
    const general = { ...sample.session_tokens!, workItem: { type: 'general' } } as AlertPayload;
    expect(systemNoticeOf(sample.session_tokens!)!.params).toMatchObject({ taskKey: 'AR-1' });
    expect(systemNoticeOf(general)!.params).not.toHaveProperty('taskKey');
  });

  it('tells a refinement only when it is done', () => {
    const refinement = (reason: 'done' | 'manual_step' | 'stalled'): AlertPayload => ({
      alert: 'refinement',
      taskKey: 'AR-1',
      label: null,
      reason,
    });
    expect(systemNoticeOf(refinement('done'))?.notice).toBe('refinement_done');
    expect(systemNoticeOf(refinement('manual_step'))).toBeNull();
  });

  it('turns no machine alert into a notice', () => {
    expect(systemNoticeOf({ alert: 'disk_low', freeBytes: 1, thresholdBytes: 2 })).toBeNull();
  });

  it('covers every kind the route rule sends to the owners as a message', () => {
    const toOwners = Object.entries(ALERT_ROUTE_CLASS)
      .filter(([, routeClass]) => routeClass === 'owner_messages')
      .map(([alert]) => alert);
    for (const alert of toOwners)
      if (alert !== 'refinement') expect(systemNoticeOf(sample[alert]!), alert).not.toBeNull();
  });
});

describe('waitingDigestNotice', () => {
  it('carries the counts and the age of the oldest as values', () => {
    expect(waitingDigestNotice({ todos: 2, questions: 1, oldestHours: 30 })).toMatchObject({
      notice: 'waiting_digest',
      params: { todos: 2, questions: 1, oldestHours: 30 },
    });
  });
});
