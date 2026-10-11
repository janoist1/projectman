import { describe, expect, it } from 'vitest';
import {
  gateRequestOf,
  InboxOption,
  questionAttachmentsOf,
  questionChoices,
  questionPayloadOf,
  withQuestionAttachmentGone,
} from './inbox';

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
