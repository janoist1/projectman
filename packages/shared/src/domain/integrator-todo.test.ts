import { describe, expect, it } from 'vitest';
import {
  InboxItem,
  QuestionTodo,
  ScreeningTodo,
  TODO_DONE_OPTION,
  TODO_CANNOT_OPTION,
  canSeeInboxItem,
  humanInboxAssignment,
  isIntegratorTodo,
  questionRecipientOf,
  selectTodoRecipient,
  planIntegratorTodoEscalation,
  wasIntegratorTodo,
} from './inbox';

const opened = '2026-10-17T10:00:00.000Z';
function todo(): InboxItem {
  return {
    id: 'inb_todo',
    projectKey: 'AR',
    kind: 'question',
    assignees: ['owner'],
    source: 'dev',
    taskKey: 'AR-1',
    sessionId: null,
    title: 'Measure',
    body: null,
    createdAt: '2026-10-16T10:00:00.000Z',
    state: 'open',
    resolution: null,
    options: [TODO_DONE_OPTION, TODO_CANNOT_OPTION],
    payload: {
      question: 'Measure',
      requestedRecipient: 'owner',
      recipient: 'integrator',
      integratorOpenedAt: opened,
      screening: {
        until: opened,
        outcome: 'todo',
        todo: { what: 'Measure', where: 'Hub', expected: 'Result', recipient: 'integrator' },
      },
    },
  };
}

describe('durable integrator todo rules', () => {
  it('keeps old stored todos valid and requires a recipient on new screening inputs', () => {
    const old = { what: 'Measure', where: 'Hub', expected: 'Result' };
    expect(QuestionTodo.safeParse(old).success).toBe(true);
    expect(ScreeningTodo.safeParse(old).success).toBe(false);
    expect(ScreeningTodo.safeParse({ ...old, recipient: 'integrator' }).success).toBe(true);
    expect(questionRecipientOf({ ...todo(), payload: { question: 'Old' } })).toBe('owner');
  });
  it('excludes an integrator todo from every human assignment, independently of state and handle', () => {
    for (const state of ['open', 'resolved'] as const) {
      const item = { ...todo(), state };
      expect(isIntegratorTodo(item)).toBe(true);
      expect(humanInboxAssignment(item, 'owner')).toBe(false);
      expect(humanInboxAssignment(item, null)).toBe(false);
    }
  });
  it('allows screening to override the proposal in either direction', () => {
    expect(selectTodoRecipient(todo(), 'owner', true)).toEqual({ recipient: 'owner' });
    expect(selectTodoRecipient(todo(), 'integrator', true)).toEqual({ recipient: 'integrator' });
    expect(selectTodoRecipient(todo(), 'integrator', false)).toEqual({
      recipient: 'owner',
      recipientRefusal: 'integrator_unavailable',
    });
  });
  it.each([
    'approvalLabel',
    'superOperation',
    'gate',
    'release',
    'permission',
    'boundary',
    'approval',
    'operatorApproval',
    'operatorKnowledge',
    'group',
  ])('fails closed on the raw protected %s field, even when null', (key) => {
    const item = todo();
    item.payload[key] = null;
    expect(selectTodoRecipient(item, 'integrator', true)).toEqual({
      recipient: 'owner',
      recipientRefusal: 'protected_question',
    });
    expect(isIntegratorTodo(item)).toBe(false);
    expect(questionRecipientOf(item)).toBe('owner');
    expect(humanInboxAssignment(item, 'owner')).toBe(true);
  });
  it('never hides malformed options or dates as valid integrator work', () => {
    for (const item of [
      { ...todo(), options: [TODO_DONE_OPTION] },
      { ...todo(), payload: { ...todo().payload, integratorOpenedAt: 'bad' } },
    ])
      expect(questionRecipientOf(item)).toBe('owner');
  });
  it('restricts even malformed integrator-origin data to owners', () => {
    for (const payload of [
      { recipient: 'integrator' },
      { integratorOpenedAt: null },
      { integratorEscalatedAt: 'bad' },
    ])
      for (const access of ['owner', 'admin', 'developer', 'client', 'viewer'] as const)
        expect(canSeeInboxItem({ access, handle: 'owner' }, { ...todo(), payload })).toBe(access === 'owner');
  });
  it('uses the integrator opening time and escalates at exactly 24 hours, once', () => {
    const item = todo();
    expect(planIntegratorTodoEscalation(item, '2026-10-18T09:59:59.999Z', ['new-owner'])).toBeNull();
    const patch = planIntegratorTodoEscalation(item, '2026-10-18T10:00:00.000Z', ['new-owner'])!;
    const moved = { ...item, ...patch };
    expect(moved.assignees).toEqual(['new-owner']);
    expect(moved.payload).toMatchObject({
      recipient: 'owner',
      integratorOpenedAt: opened,
      integratorEscalatedAt: '2026-10-18T10:00:00.000Z',
    });
    expect(wasIntegratorTodo(moved)).toBe(true);
    expect(humanInboxAssignment(moved, 'new-owner')).toBe(true);
    expect(planIntegratorTodoEscalation(moved, '2026-10-19T10:00:00.000Z', ['owner'])).toBeNull();
    expect(
      planIntegratorTodoEscalation({ ...item, state: 'resolved' }, '2026-10-19T10:00:00.000Z', ['owner']),
    ).toBeNull();
  });
});
