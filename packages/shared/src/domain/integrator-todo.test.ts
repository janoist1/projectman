import { describe, expect, it } from 'vitest';
import {
  InboxItem,
  QuestionTodo,
  ScreeningTodo,
  TODO_DONE_OPTION,
  TODO_CANNOT_OPTION,
  canSeeInboxItem,
  fallbackIntegratorTodo,
  humanInboxAssignment,
  inboxRecipientOf,
  isIntegratorFixLimitDecision,
  isIntegratorInboxItem,
  isIntegratorTodo,
  isDelegableFixLimitDecision,
  isUndelegableQuestion,
  planIntegratorPassOn,
  wasIntegratorInboxItem,
  questionRecipientOf,
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
  describe('fallbackIntegratorTodo (PM-1243)', () => {
    const asked = (payload: Record<string, unknown>): InboxItem => ({
      ...todo(),
      state: 'screening',
      options: [{ id: 'option_1', label: 'Deploy now', style: 'primary' }],
      payload: {
        question: 'Deploy the hub?',
        requestedRecipient: 'integrator',
        recommended: 'option_1',
        ...payload,
      },
    });

    it('makes a todo of a question that asked for the integrator, expecting the recommended option', () => {
      expect(fallbackIntegratorTodo(asked({}))).toEqual({
        what: 'Deploy the hub?',
        where: 'AR-1',
        expected: 'Deploy now',
        recipient: 'integrator',
      });
      expect(fallbackIntegratorTodo(asked({ recommended: undefined }))?.expected).toBe('Deploy the hub?');
    });
    it.each([
      { requestedRecipient: 'owner' },
      { approvalLabel: null },
      { group: null },
      { ownerTopic: 'risk_acceptance' },
    ])('makes none when the question has %j', (payload) => {
      expect(fallbackIntegratorTodo(asked(payload))).toBeNull();
    });
  });
  it.each([
    'approvalLabel',
    'superOperation',
    'gate',
    'release',
    'permission',
    'approval',
    'operatorApproval',
    'operatorKnowledge',
    'group',
  ])('fails closed on the raw protected %s field, even when null', (key) => {
    const item = todo();
    item.payload[key] = null;
    expect(isUndelegableQuestion(item)).toBe(true);
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
  it('gives the todo to the owners when the integrator passes it on, and only once', () => {
    const item = todo();
    const now = '2026-10-17T10:05:00.000Z';
    const patch = planIntegratorPassOn(item, now, ['new-owner'])!;
    const moved = { ...item, ...patch };
    expect(moved.assignees).toEqual(['new-owner']);
    expect(moved.payload).toMatchObject({
      recipient: 'owner',
      integratorOpenedAt: opened,
      integratorEscalatedAt: now,
      integratorEscalationReason: 'integrator_passed_on',
    });
    expect(wasIntegratorTodo(moved)).toBe(true);
    expect(humanInboxAssignment(moved, 'new-owner')).toBe(true);
    expect(planIntegratorPassOn(moved, now, ['owner'])).toBeNull();
    expect(planIntegratorPassOn({ ...item, state: 'resolved' }, now, ['owner'])).toBeNull();
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

  it('delegates only the narrow decision shape', () => {
    const { payload: _payload, ...shape } = decision();
    const item = { ...shape, payload: { fixLimit } };
    expect(isDelegableFixLimitDecision(item)).toBe(true);
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
      expect(isDelegableFixLimitDecision(broken)).toBe(false);
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
    const early = planIntegratorPassOn(item, '2026-10-17T11:00:00.000Z', ['owner'])!;
    expect(early.payload).toMatchObject({ recipient: 'owner', integratorOpenedAt: opened });
    expect(planIntegratorPassOn({ ...item, ...early }, '2026-10-19T00:00:00.000Z', ['owner'])).toBeNull();
    expect(
      planIntegratorPassOn({ ...item, state: 'resolved' }, '2026-10-19T00:00:00.000Z', ['owner']),
    ).toBeNull();
  });
});
