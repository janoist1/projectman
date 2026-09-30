import type { TimelineEvent } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { formatQuestionAsked, formatSentMessage, formatTaskDetail, questionHint } from './format';
import { sampleTaskDetail } from './testing';

function note(minute: number, text: string): TimelineEvent {
  return {
    id: `evt_note_${minute}`,
    projectKey: 'AR',
    taskKey: 'AR-21',
    sessionId: null,
    actor: { kind: 'ai', handle: 'qa' },
    type: 'task_note',
    data: { text },
    createdAt: `2026-09-29T11:${String(minute).padStart(2, '0')}:00.000Z`,
  };
}

describe('formatTaskDetail', () => {
  it('names the repository the work happens in, not only the task’s own', () => {
    const repoLine = (detail: Parameters<typeof formatTaskDetail>[0]) =>
      formatTaskDetail(detail)
        .split('\n')
        .find((line) => line.startsWith('Repo: '));
    const detail = sampleTaskDetail();
    detail.task.repo = null;
    // A handler that does not say falls back to the task's own repository.
    expect(repoLine(detail)).toBe('Repo: the workspace root · Visibility: internal · Priority: 2');
    // A task of a one-repository project works in that repository.
    expect(repoLine({ ...detail, effectiveRepo: 'web', repoChoiceNeeded: false })).toBe(
      'Repo: web · Visibility: internal · Priority: 2',
    );
    // Several repositories and none chosen: the agent is told why there is none.
    expect(repoLine({ ...detail, effectiveRepo: null, repoChoiceNeeded: true })).toBe(
      'Repo: none chosen yet (the project has several repositories; ask a human which one if you need to know) · ' +
        'Visibility: internal · Priority: 2',
    );
    // No repositories at all: the workspace root.
    expect(repoLine({ ...detail, effectiveRepo: null, repoChoiceNeeded: false })).toBe(
      'Repo: the workspace root · Visibility: internal · Priority: 2',
    );
  });

  it('lists the labels once, on the status line', () => {
    const detail = sampleTaskDetail();
    detail.task.labels = ['frontend', 'qa-ok'];
    const out = formatTaskDetail(detail);
    expect(out.split('\n').slice(1, 3)).toEqual([
      'Stage: dev · Status: active · Assignee: fe-1 · Labels: frontend, qa-ok',
      'Repo: web · Visibility: internal · Priority: 2',
    ]);
    expect(out.match(/Labels:/g)).toHaveLength(1);
  });

  it('shows the most recent timeline events, oldest first', () => {
    const detail = sampleTaskDetail();
    // Out of order on purpose: the formatter sorts by time.
    detail.timeline = Array.from({ length: 25 }, (_, i) => note(i, `note ${i}`)).reverse();

    const out = formatTaskDetail(detail);

    expect(out).toContain('Recent timeline (last 20 of 25, oldest first):');
    expect(out).not.toContain('note 4\n');
    expect(out.indexOf('note 5')).toBeLessThan(out.indexOf('note 24'));
    expect(out.trimEnd().endsWith('- 2026-09-29 11:24 UTC · qa: note: note 24')).toBe(true);
  });

  it('keeps long free text short', () => {
    const detail = sampleTaskDetail();
    detail.task.description = 'x'.repeat(10_000);
    detail.timeline = [note(0, `multi\nline   ${'y'.repeat(1000)}`)];

    const out = formatTaskDetail(detail);

    expect(out).toContain(`${'x'.repeat(5999)}…`);
    expect(out).not.toContain('x'.repeat(6000));
    expect(out).toContain('note: multi line yyy');
    expect(out.split('\n').find((l) => l.includes('note: multi'))!.length).toBeLessThan(400);
  });

  it('renders unknown event types generically', () => {
    const detail = sampleTaskDetail();
    detail.timeline = [
      { ...note(0, ''), type: 'permission_resolved', data: { inboxItemId: 'inbox_7', decision: 'allow' } },
    ];

    expect(formatTaskDetail(detail)).toContain(
      'qa: permission_resolved (inboxItemId=inbox_7, decision=allow)',
    );
  });
});

describe('formatSentMessage', () => {
  it('reports recipients the message did not reach', () => {
    expect(
      formatSentMessage({ messageId: 'msg_1', requested: ['qa', 'cr'], deliveredTo: ['qa'], taskKey: null }),
    ).toBe('Message msg_1 sent to qa. Not delivered to: cr.');
  });
});

describe('questionHint', () => {
  const MOVE_DETAIL = 'Consider moving detail into details.';
  const RECOMMEND =
    'Consider adding a recommendation with a one-sentence reason (recommended, recommendation_reason).';

  it('has no hint for a short question with a recommendation', () => {
    expect(questionHint({ question: 'x'.repeat(300), recommended: 'Yes' })).toBeNull();
  });

  it('suggests moving detail into details above 300 characters', () => {
    expect(questionHint({ question: 'x'.repeat(301), recommended: 'Yes' })).toBe(MOVE_DETAIL);
  });

  it('suggests a recommendation when there is none', () => {
    expect(questionHint({ question: 'Ship it?' })).toBe(RECOMMEND);
    expect(questionHint({ question: 'Ship it?', recommended: undefined })).toBe(RECOMMEND);
  });

  it('gives both as one line', () => {
    expect(questionHint({ question: 'x'.repeat(301) })).toBe(`${MOVE_DETAIL} ${RECOMMEND}`);
  });
});

describe('formatQuestionAsked', () => {
  it('says where the question is, for whom, and adds the hint on its own line, meant for the next one', () => {
    expect(formatQuestionAsked('inb_1', undefined, { question: 'Ship it?', recommended: 'Yes' })).toBe(
      'Question inb_1 is waiting in the inbox.',
    );
    expect(formatQuestionAsked('inb_1', ['owner', 'anna'], { question: 'Ship it?' })).toBe(
      'Question inb_1 is waiting in the inbox of owner, anna.\n' +
        'Tip for your next question: Consider adding a recommendation with a one-sentence reason ' +
        '(recommended, recommendation_reason).',
    );
  });
});

describe('related task formatting', () => {
  it('includes parent and subtasks with key, title, stage and status', () => {
    const detail = sampleTaskDetail();
    detail.parent = {
      ...detail.task,
      key: 'AR-20',
      title: 'Example parent',
      stageId: 'ready',
      status: 'waiting',
    };
    detail.subtasks = [
      { ...detail.task, key: 'AR-22', title: 'Example child', stageId: 'qa', status: 'done' },
    ];
    const out = formatTaskDetail(detail);
    expect(out).toContain('Parent: AR-20 — Example parent · Stage: ready · Status: waiting');
    expect(out).toContain('- AR-22 — Example child · Stage: qa · Status: done');
  });
});
