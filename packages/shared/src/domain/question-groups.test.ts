import { describe, expect, it } from 'vitest';
import {
  CombineQuestionsRequest,
  questionGroupCompatible,
  questionPayloadOf,
  visibleQuestionItem,
} from './inbox';
import type { InboxItem } from './inbox';

const item: InboxItem = {
  id: 'q1',
  projectKey: 'AR',
  taskKey: 'AR-1',
  source: 'dev',
  assignees: ['owner'],
  kind: 'question',
  sessionId: null,
  state: 'screening',
  title: 'First?',
  body: null,
  resolution: null,
  createdAt: '2026-10-16T08:00:00.000Z',
  payload: { question: 'First?', recommended: 'yes' },
  options: [{ id: 'yes', label: 'Yes', consequence: 'Proceed', style: 'primary' }],
};
describe('question grouping rules', () => {
  it('keeps historical question payloads valid', () => {
    expect(questionPayloadOf(item)?.question).toBe('First?');
    expect(questionPayloadOf(item)?.group).toBeUndefined();
  });
  it('requires unique bounded ids and a nonempty question and reason', () => {
    const input = { itemIds: ['q1', 'q2'], question: 'Both?', note: 'Same decision' };
    expect(CombineQuestionsRequest.safeParse(input).success).toBe(true);
    for (const patch of [{ itemIds: ['q1', 'q1'] }, { itemIds: ['q1'] }, { question: ' ' }, { note: ' ' }])
      expect(CombineQuestionsRequest.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it('compares decision choices, consequences, recommendation, recipients and attachment sets', () => {
    expect(questionGroupCompatible(item, { ...item, id: 'q2', title: 'Second?' })).toBe(true);
    for (const other of [
      { ...item, projectKey: 'OTHER' },
      { ...item, assignees: ['other'] },
      { ...item, options: [{ ...item.options[0]!, consequence: 'Stop' }] },
      { ...item, payload: { ...item.payload, recommended: 'no' } },
    ])
      expect(questionGroupCompatible(item, other)).toBe(false);
  });
  it('redacts hidden source keys, titles and text and gives guests no cross-card group data', () => {
    const grouped: InboxItem = {
      ...item,
      title: 'Combined secret?',
      payload: {
        ...item.payload,
        group: {
          primaryItemId: 'q1',
          primaryTaskKey: 'AR-1',
          itemIds: ['q1', 'q2'],
          combinedQuestion: 'Combined secret?',
          originalQuestion: 'First?',
          note: 'Internal reason',
          answeredCount: 2,
          sources: [
            {
              itemId: 'q2',
              taskKey: 'AR-2',
              taskTitle: 'Secret title',
              asker: 'dev',
              question: 'Secret original',
              createdAt: item.createdAt,
              state: 'live',
            },
          ],
        },
      },
    };
    const internal = visibleQuestionItem(
      { access: 'developer', handle: 'dev' },
      grouped,
      (key) => key === 'AR-1',
    );
    expect(questionPayloadOf(internal)?.group?.sources?.[0]).toMatchObject({
      taskKey: null,
      taskTitle: null,
      question: null,
    });
    const guest = visibleQuestionItem({ access: 'client', handle: 'guest' }, grouped, () => true);
    const serialized = JSON.stringify(guest);
    for (const secret of ['AR-2', 'Secret', 'Internal reason', 'Combined secret'])
      expect(serialized).not.toContain(secret);
    expect(questionPayloadOf(guest)?.group).toEqual({
      primaryItemId: 'q1',
      itemIds: [],
      combinedQuestion: '',
      originalQuestion: '',
      primaryTaskKey: null,
    });
    expect(
      questionPayloadOf(
        visibleQuestionItem({ access: 'developer', handle: 'dev' }, { ...grouped, id: 'q2' }, () => true),
      )?.group,
    ).not.toHaveProperty('answeredCount');
  });
});
