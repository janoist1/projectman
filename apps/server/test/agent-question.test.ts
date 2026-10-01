import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { agentQuestionsOf } from '../src/domain/agent-question';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * A question an AI member puts at its terminal (Claude Code's AskUserQuestion) reaches the humans'
 * inbox like an ask_human call, and a session that waits for input unseen is reported (PM-199).
 */

const task = { type: 'task' as const, taskKey: 'AR-1' };
const toolInput = {
  questions: [
    {
      question: 'Which option?',
      header: 'Pick',
      multiSelect: false,
      options: [{ label: 'One', description: 'The first way' }, { label: 'Two' }],
    },
  ],
};

describe('agentQuestionsOf', () => {
  it('reads the questions, options and their descriptions', () => {
    expect(agentQuestionsOf('AskUserQuestion', toolInput)).toEqual([
      {
        question: 'Which option?',
        options: [{ label: 'One', consequence: 'The first way' }, 'Two'],
        details: expect.stringContaining('Topic: Pick'),
      },
    ]);
  });

  it('skips empty questions and options, caps the count, and reads nothing from other shapes', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}`, options: [] }));
    expect(agentQuestionsOf('AskUserQuestion', { questions: many })).toHaveLength(4);
    expect(agentQuestionsOf('AskUserQuestion', { questions: [{ question: '  ' }, ...many] })).toHaveLength(3);
    expect(
      agentQuestionsOf('AskUserQuestion', {
        questions: [{ question: 'Q', options: [{ label: '' }, 'A'] }],
      })[0]?.options,
    ).toEqual(['A']);
    for (const bad of [null, 'text', {}, { questions: 'no' }]) {
      expect(agentQuestionsOf('AskUserQuestion', bad)).toEqual([]);
    }
  });
});

describe('a question at the terminal of an AI member', () => {
  let h: DomainHarness;

  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(() => h.cleanup());

  const questions = (): InboxItem[] => h.domain.inbox.list('AR', { kind: 'question' });

  it('shows in the inbox like ask_human, and the answer is typed into the session', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.setState(session.id, 'working');

    await expect(
      h.runnerModule.broker().forwardQuestion!({
        sessionId: session.id,
        toolName: 'AskUserQuestion',
        toolInput,
      }),
    ).resolves.toBe(true);

    const [item, ...more] = questions();
    expect(more).toEqual([]);
    expect(item).toMatchObject({
      kind: 'question',
      state: 'open',
      assignees: ['owner'],
      source: 'cr',
      sessionId: session.id,
      taskKey: 'AR-1',
      title: 'Which option?',
      payload: { question: 'Which option?', options: ['One', 'Two'] },
    });
    expect(item!.options.map((o) => o.id)).toEqual(['option_1', 'option_2', expect.any(String)]);
    // The session is working, not waiting: nothing about it is held back.
    expect(h.domain.sessions.get('AR', session.id).state).toBe('working');

    await h.domain.inbox.resolve(
      'AR',
      item!.id,
      { optionId: 'option_2' },
      { handle: 'owner', access: 'owner' },
    );
    h.runner.setState(session.id, 'idle');
    await flush();
    const delivered = h.runner.messages.filter((m) => m.sessionId === session.id).pop();
    expect(delivered?.text).toBe(
      '[team message from owner about AR-1]\nAnswer to your question "Which option?":\n\nTwo',
    );
  });

  it('asks one inbox question for each question of the call', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    const input = { questions: [{ question: 'First?', options: [] }, { question: 'Second?' }] };
    await h.runnerModule.broker().forwardQuestion!({
      sessionId: session.id,
      toolName: 'AskUserQuestion',
      toolInput: input,
    });
    expect(
      questions()
        .map((q) => q.title)
        .sort(),
    ).toEqual(['First?', 'Second?']);
  });

  it('takes nothing from an unknown session or a call without questions', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    const { forwardQuestion } = h.runnerModule.broker();
    await expect(
      forwardQuestion!({ sessionId: 'ses_nope', toolName: 'AskUserQuestion', toolInput }),
    ).resolves.toBe(false);
    await expect(
      forwardQuestion!({ sessionId: session.id, toolName: 'AskUserQuestion', toolInput: {} }),
    ).resolves.toBe(false);
    expect(questions()).toEqual([]);
  });
});

describe('a session that waits for input unseen', () => {
  let h: DomainHarness;
  const STALL_MS = 10 * 60_000;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
    h = await createDomainHarness({ inputStallMs: STALL_MS });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.cleanup();
    vi.useRealTimers();
  });

  const alerts = (): InboxItem[] => h.domain.inbox.list('AR', { kind: 'alert' });

  it('tells the owners once after the limit, naming the session and what it waits on', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.setState(session.id, 'waiting_input', 'AskUserQuestion');

    await vi.advanceTimersByTimeAsync(STALL_MS - 1);
    expect(alerts()).toEqual([]);
    // A second state event of the same wait (a new activity) does not restart the clock.
    h.runner.setState(session.id, 'waiting_input', 'Dialog');
    await vi.advanceTimersByTimeAsync(1);

    const [alert, ...more] = alerts();
    expect(more).toEqual([]);
    expect(alert).toMatchObject({
      kind: 'alert',
      state: 'open',
      assignees: ['owner'],
      source: 'cr',
      sessionId: session.id,
      taskKey: 'AR-1',
      payload: {
        alert: 'session_input',
        workItem: task,
        since: '2026-10-01T12:00:00.000Z',
        minutes: 10,
        activity: 'Dialog',
      },
      options: [{ id: 'seen', label: 'seen', style: 'primary' }],
    });
    // Nothing is touched: the session still waits, and no second alert follows.
    expect(h.domain.sessions.get('AR', session.id).state).toBe('waiting_input');
    await vi.advanceTimersByTimeAsync(STALL_MS * 3);
    expect(alerts()).toHaveLength(1);
  });

  it('says nothing when the wait ends in time, or the session ends', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.setState(session.id, 'waiting_input', 'Dialog');
    await vi.advanceTimersByTimeAsync(STALL_MS - 1000);
    h.runner.setState(session.id, 'working');
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(alerts()).toEqual([]);

    h.runner.setState(session.id, 'waiting_input', 'Dialog');
    await vi.advanceTimersByTimeAsync(STALL_MS - 1000);
    await h.domain.sessions.stop('AR', session.id);
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(alerts()).toEqual([]);
  });

  it('leaves a wait alone that an open question of the session already shows', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    await h.runnerModule.broker().forwardQuestion!({
      sessionId: session.id,
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Which?' }] },
    });
    h.runner.setState(session.id, 'waiting_input', 'Dialog');
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(alerts()).toEqual([]);
  });
});
