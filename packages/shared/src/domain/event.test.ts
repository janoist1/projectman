import { describe, expect, it } from 'vitest';
import { TimelineEvent, type TimelineEventData } from './event';
import { LabelChangeReason, LabelClearTrigger } from './label';

const payloads: Array<{
  type: 'task_updated' | 'task_stage_changed';
  data: TimelineEventData['task_updated'] | TimelineEventData['task_stage_changed'];
}> = [
  {
    type: 'task_updated',
    data: {
      fields: ['status'],
      gateRequest: { requestId: 'gate-1', from: 'review', to: 'merge', inboxItemIds: ['inbox-1'] },
    },
  },
  {
    type: 'task_updated',
    data: { fields: ['status'], gateRejected: { requestId: 'gate-1', to: 'merge', inboxItemId: 'inbox-1' } },
  },
  {
    type: 'task_updated',
    data: {
      fields: ['status'],
      gateBlocked: {
        to: 'merge',
        unmet: [{ stageId: 'merge', condition: { type: 'has_label', label: 'pr-merged' } }],
        approvalsStillValid: false,
      },
    },
  },
  {
    type: 'task_updated',
    data: { fields: ['status'], gateBlocked: { to: 'merge', reason: 'unknown_stage' } },
  },
  {
    type: 'task_updated',
    data: {
      fields: ['status'],
      gateBlocked: { to: 'release', label: 'release-approved', reason: 'label_not_allowed' },
    },
  },
  {
    type: 'task_updated',
    data: {
      fields: [],
      gateBlocked: {
        to: 'release',
        unmet: [],
        approvals: [{ stageId: 'release', label: 'release-approved', approvers: ['owner'] }],
      },
    },
  },
  {
    type: 'task_stage_changed',
    data: { from: 'review', to: 'merge', approvedBy: ['owner'], inboxItemIds: ['inbox-1'] },
  },
];

describe('documented gate timeline data', () => {
  it.each(payloads)('preserves the documented $type gate payload', ({ type, data }) => {
    expect(
      TimelineEvent.parse({
        id: 'event-1',
        projectKey: 'AC',
        taskKey: 'AC-1',
        sessionId: null,
        actor: { kind: 'human', handle: 'owner' },
        createdAt: '2026-10-01T10:00:00.000Z',
        type,
        data,
      }).data,
    ).toEqual(data);
  });
});

describe('label change reasons', () => {
  it('covers the clear triggers, a merged pull request, an approval and an open question', () => {
    expect(LabelChangeReason.options).toEqual([
      ...LabelClearTrigger.options,
      'pr_merged',
      'approval',
      'open_question',
    ]);
    const data: TimelineEventData['task_labels_changed'] = {
      added: [],
      removed: ['code-review-ok'],
      reason: LabelChangeReason.parse('moved_back'),
    };
    expect(data.reason).toBe('moved_back');
    expect(LabelChangeReason.safeParse('group').success).toBe(false);
  });
});
