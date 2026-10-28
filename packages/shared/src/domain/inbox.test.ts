import { describe, expect, it } from 'vitest';
import {
  canSeeInboxItem,
  AnswerDelivery,
  gateRequestOf,
  InboxItem,
  InboxOption,
  InboxResolutionRule,
  InboxState,
  isPendingQuestion,
  PENDING_INBOX_STATES,
  QUESTION_SCREENING_MINUTES,
  QUESTION_SCREENING_MS,
  QuestionCloseRule,
  QuestionScreening,
  QuestionTodo,
  ScreeningOutcome,
  screeningDeadline,
  screeningFrozenRemainingMs,
  superDecisionRefusal,
  questionAttachmentsOf,
  questionChoices,
  questionPayloadOf,
  withQuestionAttachmentGone,
} from './inbox';
import { MessageOrigin } from './involvement';

describe('superDecisionRefusal', () => {
  const item = { kind: 'question' as const, source: 'dev', payload: {} };
  it('reserves a permission to a person', () => {
    expect(superDecisionRefusal({ ...item, kind: 'permission' }, { operatorHandle: 'operator' })).toBe(
      'owner_approval_required',
    );
  });
  it.each(['superOperation', 'operatorApproval', 'operatorKnowledge'])('protects the raw %s key', (key) => {
    expect(superDecisionRefusal({ ...item, payload: { [key]: null } }, { operatorHandle: 'operator' })).toBe(
      'owner_approval_required',
    );
  });
  it('protects Operator proposals in the existing approval payload', () => {
    expect(
      superDecisionRefusal(
        { ...item, kind: 'approval', payload: { operator: {} } },
        { operatorHandle: 'operator' },
      ),
    ).toBe('owner_approval_required');
  });
  it('refuses the Operator as the source', () => {
    expect(superDecisionRefusal({ ...item, source: 'operator' }, { operatorHandle: 'operator' })).toBe(
      'owner_approval_required',
    );
  });
  it('refuses the Operator as the session member', () => {
    expect(superDecisionRefusal(item, { operatorHandle: 'operator', sessionMember: 'operator' })).toBe(
      'owner_approval_required',
    );
  });
  it('requires a configured Operator', () => {
    expect(superDecisionRefusal(item, { operatorHandle: null })).toBe('owner_approval_required');
  });
  it('allows another member’s question', () => {
    expect(superDecisionRefusal(item, { operatorHandle: 'operator' })).toBeNull();
  });
});

const request = {
  requestId: 'gat_1',
  taskKey: 'AR-1',
  fromStageId: 'code_review',
  toStageId: 'merge',
  stageId: 'merge',
  label: 'merge-ok',
  requestedBy: { kind: 'ai', handle: 'dev-1' },
};

describe('gateRequestOf', () => {
  it.each<[string, Record<string, unknown>, unknown]>([
    ['reads a gate request', { gate: request }, request],
    [
      'reads a request from before labels (no label)',
      { gate: { ...request, label: undefined, conditionIndex: 0 } },
      { ...request, label: undefined },
    ],
    ['has none on other items', { toolName: 'Bash' }, null],
    ['refuses a malformed request', { gate: { ...request, taskKey: 'not a key' } }, null],
  ])('%s', (_name, payload, expected) => {
    expect(gateRequestOf({ payload })).toEqual(expected);
  });
});

describe('questionPayloadOf', () => {
  it('reads a question from before the plain-language fields as it was stored', () => {
    const payload = { question: 'Inline or toast?', options: ['Inline', 'Toast'] };
    expect(questionPayloadOf({ payload })).toEqual(payload);
  });

  it('reads the recommendation, its reason and the details', () => {
    const payload = {
      question: 'Inline or toast?',
      options: ['Inline', 'Toast'],
      recommended: 'option_1',
      recommendationReason: 'It stays visible until the email is fixed.',
      details: '`EmailField` already shows inline errors.',
    };
    expect(questionPayloadOf({ payload })).toEqual(payload);
  });

  it('has none on other items, and refuses an unreadable one', () => {
    expect(questionPayloadOf({ payload: { toolName: 'Bash' } })).toBeNull();
    expect(questionPayloadOf({ payload: { question: 'Ok?', details: 42 } })).toBeNull();
  });
});

const shot = {
  id: 'att_abcdefghij1',
  taskKey: 'AR-1',
  fileName: 'shot.png',
  size: 120,
  mediaType: 'image/png',
  preview: 'image',
};
const spec = { ...shot, id: 'att_abcdefghij2', taskKey: 'AR-9', fileName: 'spec.pdf', preview: 'pdf' };

describe('knowledge approval visibility', () => {
  it('keeps every state private to owners and admins using their own login, even with malformed payloads', () => {
    for (const state of ['open', 'resolved', 'cancelled', 'expired', 'screening'] as const)
      for (const access of ['owner', 'admin', 'developer', 'viewer', 'client', 'ai'] as const)
        for (const via of [undefined, 'integrator'] as const)
          for (const operatorKnowledge of [null, { change: { agreement: { summary: 'PRIVATE' } } }])
            expect(
              canSeeInboxItem(
                { handle: 'reader', access, via },
                {
                  state,
                  assignees: ['reader'],
                  payload: { operatorKnowledge },
                },
              ),
            ).toBe(via === undefined && ['owner', 'admin'].includes(access));
  });
});

describe('questionAttachmentsOf', () => {
  const question = (payload: Record<string, unknown>, kind = 'question') =>
    questionAttachmentsOf({ kind, payload } as never);

  it('reads the files of a question in order, with the deletion mark', () => {
    const gone = { ...spec, goneAt: '2026-10-11T10:00:00.000Z' };
    expect(question({ question: 'Ok?', attachments: [shot, gone] })).toEqual([shot, gone]);
  });

  it('has none on an older question, on another kind of item, and when the field is unreadable', () => {
    expect(question({ question: 'Ok?', options: ['Yes'] })).toEqual([]);
    expect(question({ question: 'Ok?', attachments: [shot] }, 'alert')).toEqual([]);
    expect(question({ question: 'Ok?', attachments: 'shot.png' })).toEqual([]);
    expect(question({ question: 'Ok?', attachments: [shot, { id: 'nope' }] })).toEqual([]);
  });

  it('does not make the question itself unreadable when a file entry is bad', () => {
    const payload = { question: 'Ok?', attachments: [{ id: 'nope' }] };
    expect(questionPayloadOf({ payload })).toBeNull();
    expect(question(payload)).toEqual([]);
  });
});

describe('withQuestionAttachmentGone', () => {
  const at = '2026-10-11T10:00:00.000Z';
  const payload = { question: 'Ok?', attachments: [shot, spec] };

  it('marks the named file only and leaves the original untouched', () => {
    const next = withQuestionAttachmentGone(payload, shot.id, at);
    expect(next).toEqual({ question: 'Ok?', attachments: [{ ...shot, goneAt: at }, spec] });
    expect(payload.attachments[0]).toEqual(shot);
  });

  it('gives null for a file the question does not name, or one that is marked already', () => {
    expect(withQuestionAttachmentGone(payload, 'att_zzzzzzzzzz9', at)).toBeNull();
    expect(withQuestionAttachmentGone({ question: 'Ok?' }, shot.id, at)).toBeNull();
    const marked = withQuestionAttachmentGone(payload, shot.id, at)!;
    expect(withQuestionAttachmentGone(marked, shot.id, '2026-10-12T00:00:00.000Z')).toBeNull();
  });
});

describe('questionChoices', () => {
  it('reads plain labels and labels with a consequence alike', () => {
    expect(
      questionChoices([' Inline ', { label: 'Toast', consequence: ' It disappears after a few seconds. ' }]),
    ).toEqual([{ label: 'Inline' }, { label: 'Toast', consequence: 'It disappears after a few seconds.' }]);
  });

  it('leaves out empty and repeated labels, keeping the first occurrence', () => {
    expect(
      questionChoices([
        'Yes',
        '  ',
        { label: 'Yes', consequence: 'Ignored: Yes is already there.' },
        { label: 'No', consequence: '   ' },
      ]),
    ).toEqual([{ label: 'Yes' }, { label: 'No' }]);
  });

  it('has no choices without options', () => {
    expect(questionChoices(undefined)).toEqual([]);
    expect(questionChoices([])).toEqual([]);
  });
});

describe('InboxOption', () => {
  it('keeps the consequence optional, so stored options stay valid', () => {
    const plain = { id: 'option_1', label: 'Inline', style: 'primary' };
    expect(InboxOption.parse(plain)).toEqual(plain);
    expect(InboxOption.parse({ ...plain, consequence: 'It stays visible.' }).consequence).toBe(
      'It stays visible.',
    );
  });
});

describe('screening contract (PM-556)', () => {
  const stored = {
    id: 'inb_1',
    projectKey: 'PM',
    kind: 'question',
    assignees: ['owner'],
    source: 'dev',
    sessionId: null,
    taskKey: 'PM-1',
    title: 'Which one?',
    body: null,
    payload: { question: 'Which one?' },
    options: [],
    state: 'resolved',
    resolution: { optionId: 'answer', by: 'owner', at: '2026-01-01T00:00:00.000Z', note: 'A' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('reads stored rows and payloads without the new fields', () => {
    expect(InboxItem.parse(stored).askerStart).toBeUndefined();
    expect(questionPayloadOf(stored)).toEqual({ question: 'Which one?' });
  });

  it('knows the new state, rules and outcomes', () => {
    expect(InboxState.parse('screening')).toBe('screening');
    for (const rule of [
      'operator_answered',
      'operator_forwarded',
      'operator_moot',
      'task_done',
      'task_cancelled',
      'handed_off',
      'assignee_changed',
      'withdrawn',
    ])
      expect(InboxResolutionRule.parse(rule)).toBe(rule);
    expect(QuestionCloseRule.options).toEqual([
      'task_done',
      'task_cancelled',
      'handed_off',
      'assignee_changed',
      'withdrawn',
      'group_withdrawn',
      'operator_moot',
      'obligation_closed',
      'signal_resolved',
    ]);
    expect(() => QuestionCloseRule.parse('operator_answered')).toThrow();
    for (const outcome of ['answered', 'forwarded', 'moot', 'decision', 'todo'])
      expect(ScreeningOutcome.parse(outcome)).toBe(outcome);
    expect(QUESTION_SCREENING_MINUTES).toBe(10);
  });

  it('reads the screening, unscreened and delivery fields of a question', () => {
    const todo = { what: 'Check the server', where: 'prod', expected: 'It runs' };
    const payload = {
      question: 'Which one?',
      screening: {
        until: '2026-01-01T00:10:00.000Z',
        deliveredAt: '2026-01-01T00:00:01.000Z',
        outcome: 'todo',
        by: 'operator',
        at: '2026-01-01T00:02:00.000Z',
        note: 'Needs a person',
        todo,
        feedbackId: 'fb_1',
      },
      unscreened: { reason: 'The answer is urgent', previousItemId: 'inb_0' },
      answerDelivery: { state: 'waiting', reason: 'member_at_capacity', since: '2026-01-01T00:03:00.000Z' },
    };
    expect(questionPayloadOf({ payload })).toEqual(payload);
    expect(QuestionScreening.parse({ until: 'x', fallback: 'timeout' }).fallback).toBe('timeout');
    expect(AnswerDelivery.parse({ state: 'delivered', at: 'x' }).state).toBe('delivered');
    expect(() => AnswerDelivery.parse({ state: 'delivered' })).toThrow();
    expect(() => QuestionTodo.parse({ ...todo, expected: '' })).toThrow();
  });

  it('reads the queue of a question that waits for an offline machine (PM-708)', () => {
    const queue = { reason: 'engine_offline', since: '2026-01-01T00:00:00.000Z', remainingMs: 600_000 };
    expect(QuestionScreening.parse({ until: 'x', queue }).queue).toEqual(queue);
    // An old row has none; a wrong reason or an out-of-range time is no queue.
    expect(QuestionScreening.parse({ until: 'x' }).queue).toBeUndefined();
    for (const bad of [
      { ...queue, reason: 'other' },
      { ...queue, remainingMs: 600_001 },
      { ...queue, remainingMs: -1 },
    ])
      expect(() => QuestionScreening.parse({ until: 'x', queue: bad })).toThrow();
  });

  describe('screeningDeadline (PM-708)', () => {
    const now = '2026-01-01T01:00:00.000Z';
    const base = {
      until: '2026-01-01T01:05:00.000Z',
      deliveredAt: '2026-01-01T00:55:00.000Z',
      queue: null,
      now,
      engineOnline: true,
    };

    it('counts down a delivered question while its machine is online', () => {
      expect(screeningDeadline(base)).toEqual({ timeout: false, remainingMs: 5 * 60_000 });
      expect(screeningDeadline({ ...base, now: base.until })).toEqual({ timeout: true, remainingMs: 0 });
      expect(screeningDeadline({ ...base, now: '2026-01-01T02:00:00.000Z' })).toEqual({
        timeout: true,
        remainingMs: 0,
      });
    });

    it('never times out in a queue, and reports what the queue holds', () => {
      expect(
        screeningDeadline({ ...base, queue: { remainingMs: 0 }, now: '2026-02-01T00:00:00.000Z' }),
      ).toEqual({
        timeout: false,
        remainingMs: 0,
      });
      expect(screeningDeadline({ ...base, queue: { remainingMs: 1234 } })).toEqual({
        timeout: false,
        remainingMs: 1234,
      });
    });

    it('does not start the clock before the delivery', () => {
      expect(screeningDeadline({ ...base, deliveredAt: null, now: '2027-01-01T00:00:00.000Z' })).toEqual({
        timeout: false,
        remainingMs: QUESTION_SCREENING_MS,
      });
    });

    it('stops the clock while the machine is offline, even before a queue is written', () => {
      expect(screeningDeadline({ ...base, engineOnline: false, now: '2026-01-01T05:00:00.000Z' })).toEqual({
        timeout: false,
        remainingMs: 0,
      });
    });

    it('counts an unreadable time as none left', () => {
      expect(screeningDeadline({ ...base, until: 'not a time' })).toEqual({ timeout: true, remainingMs: 0 });
    });

    it('freezes the time up to `until` from the last online moment, clamped to the window', () => {
      const until = '2026-01-01T00:10:00.000Z';
      expect(screeningFrozenRemainingMs(until, '2026-01-01T00:04:00.000Z')).toBe(6 * 60_000);
      expect(screeningFrozenRemainingMs(until, '2026-01-01T00:11:00.000Z')).toBe(0);
      expect(screeningFrozenRemainingMs(until, '2025-12-31T00:00:00.000Z')).toBe(QUESTION_SCREENING_MS);
      expect(screeningFrozenRemainingMs(until, null)).toBe(0);
      expect(screeningFrozenRemainingMs('broken', '2026-01-01T00:04:00.000Z')).toBe(0);
    });
  });

  it('a question is pending while it is open or screened', () => {
    expect(PENDING_INBOX_STATES).toEqual(['open', 'screening']);
    expect(isPendingQuestion({ kind: 'question', state: 'open' })).toBe(true);
    expect(isPendingQuestion({ kind: 'question', state: 'screening' })).toBe(true);
    for (const state of ['resolved', 'expired', 'cancelled'] as const)
      expect(isPendingQuestion({ kind: 'question', state })).toBe(false);
    expect(isPendingQuestion({ kind: 'decision', state: 'open' })).toBe(false);
  });

  it('a forwarded question is a message origin', () => {
    expect(MessageOrigin.parse({ kind: 'question_forward', inboxItemId: 'inb_1' }).kind).toBe(
      'question_forward',
    );
  });
});
