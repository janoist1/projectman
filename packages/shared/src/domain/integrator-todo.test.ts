import { describe, expect, it } from 'vitest';
import {
  InboxItem,
  QuestionTodo,
  ScreeningTodo,
  TODO_DONE_OPTION,
  TODO_CANNOT_OPTION,
  canSeeInboxItem,
  humanInboxAssignment,
  inboxRecipientOf,
  isIntegratorFixLimitDecision,
  isIntegratorInboxItem,
  isIntegratorTodo,
  isOperatorAnswerableTodo,
  operatorOwesInboxItem,
  planIntegratorInboxEscalation,
  selectFixLimitRecipient,
  wasIntegratorInboxItem,
  questionRecipientOf,
  selectTodoRecipient,
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

describe('the todos the Operator may answer as a member question', () => {
  const facts = { operatorHandle: 'operator', askerIsAi: true };
  it('accepts an open screened todo of an AI member', () => {
    expect(isOperatorAnswerableTodo(todo(), facts)).toBe(true);
  });
  it.each([
    { name: 'a system obligation', change: (i: InboxItem) => void (i.payload.obligation = { id: 'obl_1' }) },
    { name: 'a closed item', change: (i: InboxItem) => void (i.state = 'resolved') },
    { name: 'its own todo', change: (i: InboxItem) => void (i.source = 'operator') },
    { name: 'an external question', change: (i: InboxItem) => void (i.payload.externalQuestion = {}) },
    {
      name: 'a protected payload',
      change: (i: InboxItem) => void (i.payload.approvalLabel = 'code-review-ok'),
    },
  ])('refuses $name', ({ change }) => {
    const item = todo();
    change(item);
    expect(isOperatorAnswerableTodo(item, facts)).toBe(false);
  });
  it('refuses a question that did not come from an AI member', () => {
    expect(isOperatorAnswerableTodo(todo(), { ...facts, askerIsAi: false })).toBe(false);
  });
});

describe('durable integrator todo rules', () => {
  it.each([
    { state: 'open' as const, handed: false, expected: true },
    { state: 'open' as const, handed: true, expected: false },
    { state: 'resolved' as const, handed: false, expected: false },
  ])('owes the Operator work for $state, handed=$handed: $expected', ({ state, handed, expected }) => {
    const item = todo();
    item.state = state;
    if (handed) item.payload.operatorHandoff = {};
    expect(operatorOwesInboxItem(item)).toBe(expected);
  });
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
  it('gives the todo to the owners at once with the reason, and only once', () => {
    const item = todo();
    const now = '2026-10-17T10:05:00.000Z';
    const patch = planIntegratorInboxEscalation(item, now, ['new-owner'], 'integrator_unavailable')!;
    const moved = { ...item, ...patch };
    expect(moved.assignees).toEqual(['new-owner']);
    expect(moved.payload).toMatchObject({
      recipient: 'owner',
      integratorOpenedAt: opened,
      integratorEscalatedAt: now,
      integratorEscalationReason: 'integrator_unavailable',
    });
    expect(wasIntegratorTodo(moved)).toBe(true);
    expect(humanInboxAssignment(moved, 'new-owner')).toBe(true);
    expect(planIntegratorInboxEscalation(moved, now, ['owner'], 'integrator_unavailable')).toBeNull();
    expect(
      planIntegratorInboxEscalation({ ...item, state: 'resolved' }, now, ['owner'], 'integrator_unavailable'),
    ).toBeNull();
  });
});

describe('integrator fix limit decision rules (PM-714)', () => {
  const fixLimit = {
    taskKey: 'AR-1',
    rounds: 3,
    limit: 3,
    changeRequests: 3,
    designChangeRequests: 0,
    sendBacks: 0,
    reason: 'passed_on',
    decider: 'lead',
    note: null,
  };
  const options = [
    { id: 'reassign', label: 'reassign', style: 'secondary' as const },
    { id: 'another_round', label: 'another_round', style: 'primary' as const },
  ];
  function decision(payload: Record<string, unknown> = {}): InboxItem {
    return {
      ...todo(),
      kind: 'decision',
      source: 'system',
      title: 'Fix limit',
      options,
      payload: { fixLimit, recipient: 'integrator', integratorOpenedAt: opened, ...payload },
    };
  }

  it('addresses only the narrow decision shape to the integrator, else to the owners with the reason', () => {
    const { payload: _payload, ...shape } = decision();
    const item = { ...shape, payload: { fixLimit } };
    expect(selectFixLimitRecipient(item, true)).toEqual({ recipient: 'integrator' });
    expect(selectFixLimitRecipient(item, false)).toEqual({
      recipient: 'owner',
      recipientRefusal: 'integrator_unavailable',
    });
    for (const broken of [
      { ...item, source: 'dev-1' },
      { ...item, taskKey: 'AR-2' },
      { ...item, taskKey: null },
      { ...item, payload: { fixLimit, release: {} } },
      { ...item, payload: {} },
      { ...item, options: [] },
      { ...item, options: [...options, { id: 'approve', label: 'Approve', style: 'primary' as const }] },
      { ...item, options: [options[0]!, options[0]!] },
      { ...item, kind: 'question' as const },
    ])
      expect(selectFixLimitRecipient(broken, true)).toEqual({
        recipient: 'owner',
        recipientRefusal: 'protected_question',
      });
  });

  it('is the integrator’s while open and unescalated, and hidden from every non-owner', () => {
    const item = decision();
    expect(isIntegratorFixLimitDecision(item)).toBe(true);
    expect(isIntegratorInboxItem(item)).toBe(true);
    expect(inboxRecipientOf(item)).toBe('integrator');
    expect(humanInboxAssignment(item, 'owner')).toBe(false);
    expect(humanInboxAssignment(item, null)).toBe(false);
    for (const access of ['owner', 'admin', 'developer', 'client', 'viewer'] as const)
      expect(canSeeInboxItem({ access, handle: 'owner' }, item)).toBe(access === 'owner');
    for (const payload of [
      { integratorEscalatedAt: opened },
      { recipient: 'owner' },
      { integratorOpenedAt: 'bad' },
      { release: {} },
    ])
      expect(isIntegratorFixLimitDecision(decision(payload))).toBe(false);
    expect(wasIntegratorInboxItem(decision({ recipient: 'owner', integratorEscalatedAt: opened }))).toBe(
      true,
    );
    expect(wasIntegratorInboxItem({ ...decision(), payload: { fixLimit } })).toBe(false);
  });

  it('gives the item to the owners at once when the integrator passes it on, and only once', () => {
    const item = decision();
    const early = planIntegratorInboxEscalation(
      item,
      '2026-10-17T11:00:00.000Z',
      ['owner'],
      'integrator_passed_on',
    )!;
    expect(early.payload).toMatchObject({ recipient: 'owner', integratorOpenedAt: opened });
    expect(
      planIntegratorInboxEscalation(
        { ...item, ...early },
        '2026-10-19T00:00:00.000Z',
        ['owner'],
        'integrator_passed_on',
      ),
    ).toBeNull();
    expect(
      planIntegratorInboxEscalation(
        { ...item, state: 'resolved' },
        '2026-10-19T00:00:00.000Z',
        ['owner'],
        'integrator_passed_on',
      ),
    ).toBeNull();
    // The Operator hands a todo on at once (PM-885).
    expect(
      planIntegratorInboxEscalation(todo(), '2026-10-17T11:00:00.000Z', ['owner'], 'integrator_passed_on')
        ?.payload,
    ).toMatchObject({ recipient: 'owner', integratorEscalationReason: 'integrator_passed_on' });
  });
});
