import { describe, expect, it } from 'vitest';
import { gateRequestOf, InboxOption, questionChoices, questionPayloadOf } from './inbox';

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
