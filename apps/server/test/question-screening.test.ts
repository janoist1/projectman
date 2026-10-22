import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_SCREENING_MINUTES, questionPayloadOf, routes } from '@projectman/shared';
import type { ProjectConfig, ScreenedQuestionsResponse, Session } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { conflict, DomainError } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { rejection } from './helpers/errors';
import { settle } from './helpers/fakes';

const START = new Date('2026-10-13T10:00:00.000Z');
const PAUSE_BY = { userId: null, source: 'system' } as const;
const owner = { handle: 'owner', access: 'owner' as const };

/** A person who is no owner, and a client, for the guest conversation and the endpoint's access check. */
function withPeople(config: ProjectConfig): void {
  const pm = config.team.members.find((m) => m.handle === 'pm')!;
  if (pm.kind === 'ai') pm.onLeave = false;
  for (const [handle, access] of [
    ['dana', 'developer'],
    ['cleo', 'client'],
  ] as const)
    config.team.members.push({
      kind: 'human',
      handle,
      displayName: handle,
      email: `${handle}@example.test`,
      access,
      roles: [],
    });
}

/**
 * The Operator screens the questions of AI members before a person sees them (PM-558, PM-556): the five
 * outcomes, the fallback to the people, the re-ask and the endpoint.
 */
describe('the Operator screens AI members’ questions', () => {
  let h: DomainHarness;
  let now: Date;
  let dev: ToolContext;
  let devSession: string;
  beforeEach(async () => {
    now = new Date(START);
    h = await createDomainHarness({ screenQuestions: true, now: () => now, adjust: withPeople });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    devSession = started.session!.id;
    dev = { sessionId: devSession, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
    await settle();
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const item = (id: string) => h.domain.inbox.get('AR', id);
  const sessionsOf = (member: string): Session[] => h.domain.sessions.list('AR', { member });
  const operatorTool = (): ToolContext => ({
    projectKey: 'AR',
    member: 'pm',
    sessionId: sessionsOf('pm')[0]!.id,
    taskKey: null,
  });
  /** What a session got: its first input and the messages typed into it later. */
  const typedInto = (sessionId: string) => [
    ...h.runner.started.filter((s) => s.sessionId === sessionId).map((s) => s.initialMessage ?? ''),
    ...h.runner.messages.filter((m) => m.sessionId === sessionId).map((m) => m.text),
  ];
  /** The owner has a request open with the Operator, as every write of the Operator needs (PM-463). */
  async function ownerAsksOperator(): Promise<ToolContext> {
    // A screening round in progress takes the message only when its turn ends.
    for (const running of sessionsOf('pm')) h.runner.setState(running.id, 'idle');
    await h.domain.messaging.sendReporting('AR', 'owner', { to: ['pm'], text: 'Please help' });
    await vi.waitFor(() => expect(h.repos.operatorRequests.latest('AR', 1)).toHaveLength(1), {
      timeout: 5000,
    });
    const [request] = h.repos.operatorRequests.latest('AR', 1);
    return { projectKey: 'AR', member: 'pm', sessionId: request!.sessionId, taskKey: null };
  }
  /** The asking member's turn ended: an answer is typed into its session now. */
  const askerIdle = () => h.runner.setState(devSession, 'idle');
  const timelineOf = (type: string) =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((event) => event.type === type);
  const refusal = async (promise: Promise<unknown>) => await rejection(promise, TeamToolError);
  const humanQueue = () => h.domain.inbox.list('AR', { state: 'open', kind: 'question' });

  /** `dev-1` asks; the call returns at once, the Operator is woken behind it. */
  async function ask(question = 'Which font?', as: ToolContext = dev) {
    const result = await h.domain.teamTools.askHuman(as, { question, options: ['Yes', 'No'] });
    await settle();
    return result;
  }
  const screen = (args: Parameters<typeof h.domain.teamTools.screenQuestion>[1]) =>
    h.domain.teamTools.screenQuestion(operatorTool(), args);

  const todo = {
    what: 'Sign in',
    where: 'Vendor console',
    expected: 'Access enabled',
    recipient: 'owner' as const,
  };
  function feedback(projectKey = 'AR') {
    if (projectKey !== 'AR') h.repos.projects.insert({ ...h.repos.projects.get('AR')!, key: projectKey });
    h.repos.systemFeedback.insert({
      id: 'fb_gap',
      projectKey,
      title: 'Missing tool',
      what: 'A member needed a person',
      workaround: 'Sent a todo',
      fix: 'Add the tool',
      createdAt: now.toISOString(),
      version: 'dev',
      sessionId: null,
    });
    return 'fb_gap';
  }

  it('stores a todo feedback reference in the payload and timeline', async () => {
    const { inboxItemId } = await ask();
    const { id: feedbackId } = await h.domain.teamTools.recordSystemFeedback(operatorTool(), {
      title: 'Missing tool',
      what: 'A member needed a person',
      workaround: 'Sent a todo to the owner',
      fix: 'Add the tool',
    });
    expect((await h.domain.teamTools.listSystemFeedback(operatorTool())).items).toEqual([
      expect.objectContaining({ id: feedbackId }),
    ]);
    await screen({ itemId: inboxItemId, outcome: 'todo', todo, note: 'Missing tool', feedbackId });
    expect(item(inboxItemId).state).toBe('open');
    expect(questionPayloadOf(item(inboxItemId))?.screening).toMatchObject({ feedbackId, outcome: 'todo' });
    expect(timelineOf('question_screened')[0]?.data).toMatchObject({
      inboxItemId,
      feedbackId,
      outcome: 'todo',
    });
  });

  it.each(['guest', 'task', 'approval'])('refuses system feedback in the PM %s context', async (variant) => {
    await ask();
    const ctx = operatorTool();
    if (variant === 'approval') {
      h.repos.operatorRequests.insert({
        id: 'opr_pm_approval',
        projectKey: 'AR',
        sessionId: ctx.sessionId,
        source: 'approval',
        messageId: null,
        inboxItemId: null,
        fromHandle: 'owner',
        quote: 'Approved',
        openedAt: now.toISOString(),
      });
    } else {
      const session = h.repos.sessions.get(ctx.sessionId)!;
      h.repos.sessions.insert({
        ...session,
        id: 'ses_pm_other',
        workItem: variant === 'guest' ? { type: 'general', with: 'dana' } : { type: 'task', taskKey: 'AR-1' },
      });
      ctx.sessionId = 'ses_pm_other';
    }
    await expect(h.domain.teamTools.listSystemFeedback(ctx)).rejects.toBeInstanceOf(TeamToolError);
    await expect(
      h.domain.teamTools.recordSystemFeedback(ctx, {
        title: 'Missing tool',
        what: 'Needs a person',
        workaround: 'Todo',
        fix: 'Add a tool',
      }),
    ).rejects.toBeInstanceOf(TeamToolError);
    expect(h.repos.systemFeedback.list({ projectKey: 'AR', limit: 50 })).toEqual([]);
  });

  it.each(['foreign', 'missing', 'empty', 'other outcome'])(
    'refuses %s feedback without changing the inbox or timeline',
    async (variant) => {
      const { inboxItemId } = await ask();
      const feedbackId =
        variant === 'empty'
          ? ''
          : variant === 'missing'
            ? 'fb_missing'
            : feedback(variant === 'foreign' ? 'BR' : 'AR');
      const before = item(inboxItemId);
      const timeline = h.domain.timeline.list('AR', { taskKey: 'AR-1' });
      const err = await refusal(
        screen({
          itemId: inboxItemId,
          note: 'Missing tool',
          feedbackId,
          ...(variant === 'other outcome'
            ? { outcome: 'decision' as const }
            : { outcome: 'todo' as const, todo }),
        }),
      );
      expect(err.code).toBe('invalid');
      expect(err.message).toContain('invalid_outcome_fields');
      expect(item(inboxItemId)).toEqual(before);
      expect(h.domain.timeline.list('AR', { taskKey: 'AR-1' })).toEqual(timeline);
    },
  );

  it('rolls back the feedback reference and release if the timeline write fails', async () => {
    const { inboxItemId } = await ask();
    const feedbackId = feedback();
    const before = item(inboxItemId);
    const append = vi.spyOn(h.domain.timeline, 'append').mockImplementation(() => {
      throw new Error('Timeline unavailable');
    });
    try {
      await expect(
        screen({ itemId: inboxItemId, outcome: 'todo', todo, note: 'Missing tool', feedbackId }),
      ).rejects.toThrow();
      expect(item(inboxItemId)).toEqual(before);
    } finally {
      append.mockRestore();
    }
    expect(timelineOf('question_screened')).toEqual([]);
  });

  it('does not attach feedback to a question already released', async () => {
    const { inboxItemId } = await ask();
    const feedbackId = feedback();
    await screen({ itemId: inboxItemId, outcome: 'decision', note: 'Owner decides' });
    const before = item(inboxItemId);
    const err = await refusal(
      screen({ itemId: inboxItemId, outcome: 'todo', todo, note: 'Missing tool', feedbackId }),
    );
    expect(err.message).toContain('question_not_screening');
    expect(item(inboxItemId)).toEqual(before);
    expect(timelineOf('question_screened')).toHaveLength(1);
  });

  it('refuses a new todo without a recipient at the direct handler boundary without writing', async () => {
    const { inboxItemId } = await ask();
    const before = item(inboxItemId);
    const error = await refusal(
      screen({
        itemId: inboxItemId,
        outcome: 'todo',
        note: 'Technical step',
        todo: { what: 'Measure', where: 'Hub', expected: 'Report' } as never,
      }),
    );
    expect(error.code).toBe('invalid');
    expect(error.message).toContain('invalid_outcome_fields');
    expect(item(inboxItemId)).toEqual(before);
  });

  describe('who is screened', () => {
    it('puts a question of an AI member into screening, hidden from the people, and wakes the Operator', async () => {
      const { inboxItemId, screening } = await ask();

      expect(screening).toBe(true);
      expect(item(inboxItemId)).toMatchObject({ state: 'screening', source: 'dev-1', assignees: ['owner'] });
      const until = questionPayloadOf(item(inboxItemId))?.screening?.until;
      expect(until).toBe(new Date(START.getTime() + QUESTION_SCREENING_MINUTES * 60_000).toISOString());
      expect(humanQueue()).toEqual([]);
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
      expect(timelineOf('question_asked')[0]?.data).toMatchObject({ inboxItemId, screening: true });
      expect(questionPayloadOf(item(inboxItemId))).toMatchObject({
        requestedRecipient: 'owner',
        recipient: 'owner',
      });

      const [operator] = sessionsOf('pm');
      expect(operator).toBeDefined();
      const notice = typedInto(operator!.id).join('\n');
      expect(notice).toContain('Projectman question screening');
      expect(notice).toContain(inboxItemId);
      expect(questionPayloadOf(item(inboxItemId))?.screening?.deliveredAt).toBeTruthy();
    });

    it('sends the PM own question directly to the people', async () => {
      const { inboxItemId } = await h.domain.teamTools.askHuman(
        { projectKey: 'AR', member: 'pm', sessionId: devSession, taskKey: null },
        { question: 'Which card first?' },
      );
      expect(item(inboxItemId).state).toBe('open');
    });

    it('does not screen the Operator’s own question or a human’s', async () => {
      const asking = await ownerAsksOperator();
      const own = await h.domain.teamTools.askHuman(asking, { question: 'May I hire a reviewer?' });
      expect(own.screening).toBeUndefined();
      expect(item(own.inboxItemId)).toMatchObject({ state: 'open', assignees: ['owner'] });
      expect(questionPayloadOf(item(own.inboxItemId))?.screening).toBeUndefined();

      // A human has no ask_human: the inbox creates their kind of item open.
      const human = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        assignees: ['owner'],
        source: 'dana',
        sessionId: null,
        taskKey: null,
        title: 'Can you look?',
        payload: { question: 'Can you look?', options: [] },
        options: [],
      });
      expect(human.state).toBe('open');
    });
  });

  describe('screening delivery acknowledgements', () => {
    it('admits other work and delivers concurrent questions once', async () => {
      const questions = await Promise.all([ask('Which font?'), ask('Which colour?')]);
      await vi.waitFor(() => expect(sessionsOf('pm')).toHaveLength(1));
      const operator = sessionsOf('pm')[0]!;

      // An unrelated automatic message start is admitted next to the screening.
      await h.domain.messaging.sendReporting(
        'AR',
        'owner',
        { to: ['dev-2'], text: 'Please look at the open cards.' },
        { awaitWake: true },
      );
      expect(sessionsOf('dev-2')).toHaveLength(1);

      await vi.waitFor(() => {
        for (const { inboxItemId } of questions)
          expect(questionPayloadOf(item(inboxItemId))?.screening?.deliveredAt).toBeTruthy();
      });
      const notices = typedInto(operator.id).join('\n');
      for (const { inboxItemId } of questions) expect(notices.split(inboxItemId)).toHaveLength(2);
      expect(h.runner.started.filter((start) => start.member === 'pm')).toHaveLength(1);
      expect(humanQueue()).toEqual([]);
    });

    it('keeps the question as the project manager’s queue item until the screening is settled', async () => {
      const { inboxItemId } = await ask();
      const source = { type: 'inbox', id: inboxItemId } as const;
      expect(h.repos.memberQueue.findBySource('AR', 'pm', source)).toMatchObject({
        kind: 'screening',
        state: 'processing',
      });

      await screen({ itemId: inboxItemId, outcome: 'decision', note: 'The owner decides.' });

      expect(h.repos.memberQueue.findBySource('AR', 'pm', source)).toMatchObject({
        state: 'done',
        closeReason: 'resolved',
      });
    });
  });

  describe('the five outcomes', () => {
    it('answered: the asking member gets the answer, no person sees the question', async () => {
      const { inboxItemId } = await ask('Which font?');
      askerIdle();
      const before = typedInto(devSession).length;

      const settled = await screen({
        itemId: inboxItemId,
        outcome: 'answered',
        answer: 'Use Inter.',
        note: 'The style guide says so.',
      });
      await settle();

      expect(settled).toEqual({ inboxItemId, outcome: 'answered' });
      expect(item(inboxItemId)).toMatchObject({
        state: 'resolved',
        resolution: { by: 'pm', rule: 'operator_answered', note: 'Use Inter.' },
      });
      expect(questionPayloadOf(item(inboxItemId))?.screening).toMatchObject({
        outcome: 'answered',
        by: 'pm',
        note: 'The style guide says so.',
      });
      expect(humanQueue()).toEqual([]);
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
      const added = typedInto(devSession).slice(before).join('\n');
      expect(added).toContain('Use Inter.');
      expect(added).toContain('reask_of');
      expect(timelineOf('question_screened')[0]?.data).toMatchObject({
        inboxItemId,
        outcome: 'answered',
        answer: 'Use Inter.',
      });
    });

    it('forwarded: the recipient with no role on the card is woken, the asker is told, no person sees it', async () => {
      const { inboxItemId } = await ask('Which font?');
      expect(sessionsOf('dev-2')).toEqual([]);
      askerIdle();
      const before = typedInto(devSession).length;

      await screen({
        itemId: inboxItemId,
        outcome: 'forwarded',
        forwardTo: 'dev-2',
        note: 'Fonts are dev-2’s part.',
      });
      await settle();

      expect(item(inboxItemId)).toMatchObject({
        state: 'resolved',
        resolution: { by: 'pm', rule: 'operator_forwarded' },
      });
      expect(questionPayloadOf(item(inboxItemId))?.screening).toMatchObject({
        outcome: 'forwarded',
        forwardedTo: 'dev-2',
      });
      expect(humanQueue()).toEqual([]);

      // dev-2 has no role on the card, yet the forward starts a session for it.
      const [recipient] = sessionsOf('dev-2');
      expect(recipient).toBeDefined();
      const woken = typedInto(recipient!.id).join('\n');
      expect(woken).toContain('Which font?');
      expect(woken).toContain('Fonts are dev-2’s part.');
      const told = typedInto(devSession).slice(before).join('\n');
      expect(told).toContain('went to `dev-2`');
      expect(told).toContain('reask_of');
    });

    it('moot: closes the question for good without a person', async () => {
      const { inboxItemId } = await ask();
      await screen({ itemId: inboxItemId, outcome: 'moot', note: 'The card is done already.' });
      await settle();

      expect(item(inboxItemId)).toMatchObject({
        state: 'cancelled',
        resolution: { by: 'pm', rule: 'operator_moot', note: 'The card is done already.' },
      });
      expect(questionPayloadOf(item(inboxItemId))?.screening?.outcome).toBe('moot');
      expect(humanQueue()).toEqual([]);
      expect(timelineOf('question_screened')[0]?.data).toMatchObject({ outcome: 'moot' });
    });

    it('decision: the question opens for the people as it was asked, with the Operator’s note', async () => {
      const { inboxItemId } = await ask();
      const original = item(inboxItemId).options;

      await screen({ itemId: inboxItemId, outcome: 'decision', note: 'Only the owner can pick a brand.' });

      expect(item(inboxItemId)).toMatchObject({ state: 'open', options: original });
      expect(questionPayloadOf(item(inboxItemId))?.screening).toMatchObject({
        outcome: 'decision',
        note: 'Only the owner can pick a brand.',
      });
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
      expect(timelineOf('question_screened')[0]?.data).toMatchObject({ outcome: 'decision' });
    });

    it('todo: opens with Done and Cannot do it, and Cannot do it needs a reason', async () => {
      const { inboxItemId } = await ask('Please create the API key');
      const todo = {
        recipient: 'owner' as const,
        what: 'Create the API key',
        where: 'The vendor console',
        expected: 'The key in the vault',
      };

      await screen({ itemId: inboxItemId, outcome: 'todo', todo, note: 'Only a person can sign in there.' });

      expect(item(inboxItemId).state).toBe('open');
      expect(item(inboxItemId).options.map((o) => o.id)).toEqual(['todo_done', 'todo_cannot']);
      expect(questionPayloadOf(item(inboxItemId))?.screening).toMatchObject({ outcome: 'todo', todo });

      const err = await rejection(
        h.domain.inbox.resolve('AR', inboxItemId, { optionId: 'todo_cannot' }, owner),
        DomainError,
      );
      expect(err.code).toBe('todo_reason_required');
      expect(item(inboxItemId).state).toBe('open');

      await h.domain.inbox.resolve('AR', inboxItemId, { optionId: 'todo_cannot', note: 'No access.' }, owner);
      expect(item(inboxItemId)).toMatchObject({ state: 'resolved', resolution: { optionId: 'todo_cannot' } });
    });
  });

  describe('what the Operator may not do', () => {
    it('refuses a member who is not the Operator', async () => {
      const { inboxItemId } = await ask();
      const err = await refusal(
        h.domain.teamTools.screenQuestion(dev, { itemId: inboxItemId, outcome: 'moot', note: 'Mine.' }),
      );
      expect(err.code).toBe('forbidden');
      expect(err.message).toContain('project_manager_only');
      expect(item(inboxItemId).state).toBe('screening');
    });

    it('refuses the Operator from a conversation with a guest', async () => {
      const { inboxItemId } = await ask();
      await h.domain.messaging.sendReporting('AR', 'dana', { to: ['pm'], text: 'Hello' });
      await settle();
      const guest = {
        ...sessionsOf('pm')[0]!,
        id: 'ses_pm_guest',
        workItem: { type: 'general', with: 'dana' } as const,
      };
      h.repos.sessions.insert(guest);

      const err = await refusal(
        h.domain.teamTools.screenQuestion(
          { projectKey: 'AR', member: 'pm', sessionId: guest!.id, taskKey: null },
          { itemId: inboxItemId, outcome: 'moot', note: 'Not for a guest.' },
        ),
      );
      expect(err.code).toBe('forbidden');
      expect(err.message).toContain('project_manager_only');
      expect(item(inboxItemId).state).toBe('screening');
    });

    it('refuses fields that do not fit the outcome, and a note-less call', async () => {
      const { inboxItemId } = await ask();
      const todo = { what: 'a', where: 'b', expected: 'c', recipient: 'owner' as const };
      const bad = [
        { outcome: 'answered' as const, note: 'x' },
        { outcome: 'moot' as const, note: 'x', answer: 'No.' },
        { outcome: 'forwarded' as const, note: 'x' },
        { outcome: 'decision' as const, note: 'x', forwardTo: 'dev-2' },
        { outcome: 'todo' as const, note: 'x' },
        { outcome: 'decision' as const, note: 'x', todo },
        { outcome: 'moot' as const, note: '  ' },
        { outcome: 'forwarded' as const, note: 'x', forwardTo: 'owner' },
        { outcome: 'forwarded' as const, note: 'x', forwardTo: 'pm' },
        { outcome: 'forwarded' as const, note: 'x', forwardTo: 'dev-1' },
      ];
      for (const fields of bad) {
        const err = await refusal(screen({ itemId: inboxItemId, ...fields }));
        expect(err.code).toBe('invalid');
        expect(err.message).toContain('invalid_outcome_fields');
      }
      expect(item(inboxItemId).state).toBe('screening');
    });

    it('does not find a question of another kind or one that does not exist', async () => {
      await ask();
      const err = await refusal(screen({ itemId: 'inb_nope', outcome: 'moot', note: 'x' }));
      expect(err.code).toBe('not_found');
    });

    it('refuses a question that is no longer in screening', async () => {
      const { inboxItemId } = await ask();
      await screen({ itemId: inboxItemId, outcome: 'decision', note: 'A person decides.' });
      const err = await refusal(screen({ itemId: inboxItemId, outcome: 'answered', answer: 'x', note: 'x' }));
      expect(err.code).toBe('invalid');
      expect(err.message).toContain('question_not_screening');
      // A moot call does not close one a person already holds if it is not an AI member's.
      const asking = await ownerAsksOperator();
      const own = await h.domain.teamTools.askHuman(asking, { question: 'May I?' });
      const refused = await refusal(screen({ itemId: own.inboxItemId, outcome: 'moot', note: 'x' }));
      expect(refused.message).toContain('the PM cannot screen its own question');
    });
  });

  describe('when the Operator does not settle it', () => {
    it('gives the question to the people when the ten minutes pass, and the Operator can still call it moot', async () => {
      const { inboxItemId } = await ask();
      now = new Date(START.getTime() + (QUESTION_SCREENING_MINUTES - 1) * 60_000);
      await h.domain.questionScreening.sweep();
      expect(item(inboxItemId).state).toBe('screening');

      now = new Date(START.getTime() + QUESTION_SCREENING_MINUTES * 60_000);
      await h.domain.questionScreening.sweep();

      expect(item(inboxItemId).state).toBe('open');
      expect(questionPayloadOf(item(inboxItemId))?.screening?.fallback).toBe('timeout');
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
      expect(timelineOf('question_screening_skipped')[0]?.data).toMatchObject({
        inboxItemId,
        reason: 'timeout',
      });

      // Too late to answer or forward, but a question that is obsolete may still be closed.
      for (const args of [
        { outcome: 'answered' as const, answer: 'x', note: 'x' },
        { outcome: 'forwarded' as const, forwardTo: 'dev-2', note: 'x' },
        { outcome: 'decision' as const, note: 'x' },
      ]) {
        const err = await refusal(screen({ itemId: inboxItemId, ...args }));
        expect(err.message).toContain('question_not_screening');
      }
      await screen({ itemId: inboxItemId, outcome: 'moot', note: 'The card closed meanwhile.' });
      expect(item(inboxItemId)).toMatchObject({ state: 'cancelled', resolution: { rule: 'operator_moot' } });
    });
  });

  describe('asking again', () => {
    it('refuses moot for a human question or a question that already closed', async () => {
      const closed = await ask('No longer needed?');
      await screen({ itemId: closed.inboxItemId, outcome: 'moot', note: 'No longer needed.' });
      const resolved = await ask('Already answered?');
      await screen({ itemId: resolved.inboxItemId, outcome: 'answered', answer: 'Yes.', note: 'Known.' });
      const human = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        assignees: ['owner'],
        source: 'dana',
        title: 'A human question',
        payload: { question: 'A human question' },
        options: [],
      });
      for (const id of [closed.inboxItemId, resolved.inboxItemId, human.id]) {
        const before = item(id);
        const error = await refusal(screen({ itemId: id, outcome: 'moot', note: 'Not allowed.' }));
        expect(error.message).toContain('question_not_screening');
        expect(item(id)).toEqual(before);
      }
    });

    async function answered(question = 'Which font?') {
      const { inboxItemId } = await ask(question);
      await screen({ itemId: inboxItemId, outcome: 'answered', answer: 'Use Inter.', note: 'Style guide.' });
      await settle();
      return inboxItemId;
    }
    const reask = (previous: string | undefined, reason: string | undefined, as: ToolContext = dev) =>
      h.domain.teamTools.askHuman(as, {
        question: 'Really Inter?',
        recipient: 'integrator',
        ...(previous !== undefined ? { reaskOf: previous } : {}),
        ...(reason !== undefined ? { reaskReason: reason } : {}),
      });

    it('goes to the people unscreened after an answered, forwarded or moot question, once', async () => {
      const first = await answered();
      const again = await reask(first, 'The brand guide is out of date.');

      expect(again.screening).toBeUndefined();
      expect(item(again.inboxItemId)).toMatchObject({ state: 'open', source: 'dev-1', assignees: ['owner'] });
      expect(questionPayloadOf(item(again.inboxItemId))?.unscreened).toEqual({
        reason: 'The brand guide is out of date.',
        previousItemId: first,
      });
      expect(questionPayloadOf(item(again.inboxItemId))?.screening).toBeUndefined();
      expect(questionPayloadOf(item(again.inboxItemId))).toMatchObject({
        requestedRecipient: 'integrator',
        recipient: 'owner',
      });
      expect(questionPayloadOf(item(again.inboxItemId))?.integratorOpenedAt).toBeUndefined();
      expect(timelineOf('question_asked').at(-1)?.data).toMatchObject({
        inboxItemId: again.inboxItemId,
        unscreened: { previousItemId: first },
      });

      const forwarded = await ask('Who owns CI?');
      await screen({
        itemId: forwarded.inboxItemId,
        outcome: 'forwarded',
        forwardTo: 'dev-2',
        note: 'dev-2.',
      });
      expect((await reask(forwarded.inboxItemId, 'It is not dev-2’s.')).inboxItemId).toBeTruthy();

      const moot = await ask('Still needed?');
      await screen({ itemId: moot.inboxItemId, outcome: 'moot', note: 'Closed.' });
      expect((await reask(moot.inboxItemId, 'It is still needed.')).inboxItemId).toBeTruthy();
    });

    it('is refused when the pair is incomplete or the earlier question is not the asker’s own', async () => {
      const first = await answered();
      for (const [previous, reason] of [
        [first, undefined],
        [undefined, 'Because.'],
        [first, '   '],
        ['inb_nope', 'Because.'],
      ] as const) {
        const err = await refusal(reask(previous, reason));
        expect(err.code).toBe('invalid');
        expect(err.message).toContain('reask_not_allowed');
      }
      // Another member cannot ask again for dev-1.
      const other = await refusal(
        reask(first, 'Because.', { projectKey: 'AR', member: 'dev-2', sessionId: devSession, taskKey: null }),
      );
      expect(other.message).toContain('reask_not_allowed');
      expect(humanQueue()).toEqual([]);
    });

    it('is refused when the Operator did not settle the earlier question without a person', async () => {
      const decision = await ask('Brand?');
      await screen({ itemId: decision.inboxItemId, outcome: 'decision', note: 'A person decides.' });
      const timedOut = await ask('Slow?');
      now = new Date(START.getTime() + QUESTION_SCREENING_MINUTES * 60_000);
      await h.domain.questionScreening.sweep();

      for (const previous of [decision.inboxItemId, timedOut.inboxItemId]) {
        const err = await refusal(reask(previous, 'Because.'));
        expect(err.message).toContain('reask_not_allowed');
      }
    });

    it('is refused when the question was already asked again', async () => {
      const first = await answered();
      await reask(first, 'The brand guide is out of date.');
      const err = await refusal(reask(first, 'Once more.'));
      expect(err.code).toBe('invalid');
      expect(err.message).toContain('reask_not_allowed');
      expect(humanQueue()).toHaveLength(1);
    });
  });

  describe('when the Operator cannot take the question', () => {
    async function askAtOnce() {
      const result = await h.domain.teamTools.askHuman(dev, { question: 'Which font?' });
      return { ...result, stored: item(result.inboxItemId) };
    }

    it('opens it for the people before the call returns while the team is paused', async () => {
      await h.domain.pauses.pause({ scope: 'instance' }, PAUSE_BY);
      const { screening, stored } = await askAtOnce();

      expect(screening).toBeUndefined();
      expect(stored.state).toBe('open');
      expect(questionPayloadOf(stored)?.screening?.fallback).toBe('unavailable');
      expect(sessionsOf('pm')).toEqual([]);
      expect(timelineOf('question_screening_skipped')[0]?.data).toMatchObject({ reason: 'unavailable' });
    });

    it('opens it for the people when AI work is off', async () => {
      await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
        draft.team.limits.aiEnabled = false;
        return 'Switch AI work off';
      });
      const { stored } = await askAtOnce();
      expect(stored.state).toBe('open');
      expect(questionPayloadOf(stored)?.screening?.fallback).toBe('unavailable');
    });

    it('opens it for the people when the admission defers the Operator’s start', async () => {
      // Whatever holds the start back (capacity, plan usage, a full disk): only that it defers matters here.
      vi.spyOn(h.domain.admission, 'start').mockRejectedValue(conflict('ai_limit_reached', 'limit'));

      const { screening, stored } = await askAtOnce();
      await settle();

      expect(screening).toBe(true);
      expect(item(stored.id).state).toBe('open');
      expect(questionPayloadOf(item(stored.id))?.screening?.fallback).toBe('unavailable');
      expect(sessionsOf('pm')).toEqual([]);
    });
  });
});

describe('a team without an Operator', () => {
  let h: DomainHarness;
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  it('opens the question for the people at once', async () => {
    h = await createDomainHarness({ screenQuestions: true });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    // The configuration refuses to lose its Operator, so the loaded one is edited.
    const config = h.domain.projects.cachedConfig('AR')!;
    config.team.members = config.team.members.filter((member) => member.handle !== 'pm');
    const dev = { sessionId: started.session!.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };

    const { inboxItemId, screening } = await h.domain.teamTools.askHuman(dev, { question: 'Which font?' });

    expect(screening).toBeUndefined();
    const stored = h.domain.inbox.get('AR', inboxItemId);
    expect(stored.state).toBe('open');
    expect(questionPayloadOf(stored)?.screening?.fallback).toBe('unavailable');
  });
});

describe('GET /api/projects/:key/inbox/screened (PM-558)', () => {
  let app: AppHarness;
  afterEach(() => app.close());

  async function setup() {
    app = await createAppHarness({ app: { screenQuestions: true } });
    const cookie = await setupOwner(app.app);
    await createProject(app, cookie);
    await app.app.projectman.domain.members.update(
      'AR',
      'pm',
      { onLeave: false },
      { actor: OWNER_ACTOR, author: OWNER },
    );
    return cookie;
  }
  const get = (cookie: string, query: string) =>
    app.app.inject({ url: `${routes.screenedQuestions('AR')}${query}`, headers: { cookie } });

  it('answers the owner and an admin, and refuses anyone else', async () => {
    const owner = await setup();
    const since = encodeURIComponent('2026-10-13T00:00:00.000Z');
    expect((await get(owner, `?since=${since}`)).statusCode).toBe(200);
    const admin = await addHumanAndLogin(app.app, { handle: 'boss', access: 'admin' });
    expect((await get(admin, `?since=${since}`)).statusCode).toBe(200);
    for (const access of ['developer', 'client', 'viewer'] as const) {
      const cookie = await addHumanAndLogin(app.app, { handle: `user-${access}`, access });
      expect((await get(cookie, `?since=${since}`)).statusCode).toBe(403);
    }
    expect(
      (await app.app.inject({ url: `${routes.screenedQuestions('AR')}?since=${since}` })).statusCode,
    ).toBe(401);
  });

  it('refuses a missing or malformed since', async () => {
    const owner = await setup();
    for (const query of ['', '?since=yesterday']) {
      const res = await get(owner, query);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
  });

  it('lists the questions in screening and those the Operator settled, newest first, and counts today’s', async () => {
    const cookie = await setup();
    const { domain } = app.app.projectman;
    const ctx = { projectKey: 'AR', member: 'dev-1', sessionId: 'ses_none', taskKey: null };
    const ask = async (question: string) => (await domain.teamTools.askHuman(ctx, { question })).inboxItemId;
    const screening = await ask('Still screened?');
    const answered = await ask('Answered?');
    const moot = await ask('Moot?');
    const decision = await ask('Decision?');
    // The Operator's settled questions come in with the screening record the domain wrote.
    await domain.inbox.settleScreened(answered, {
      outcome: 'answered',
      by: 'pm',
      note: 'Yes.',
      answer: 'Yes.',
    });
    await domain.inbox.settleScreened(moot, { outcome: 'moot', by: 'pm', note: 'Gone.' });
    await domain.inbox.releaseScreened(decision, { outcome: 'decision', by: 'pm', note: 'A person.' });

    const res = await get(cookie, `?since=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ScreenedQuestionsResponse;
    expect(body.items.map((i) => i.id).sort()).toEqual([screening, answered, moot].sort());
    expect(body.today).toBe(3);

    const none = await get(cookie, `?since=${encodeURIComponent('2999-01-01T00:00:00.000Z')}`);
    expect((none.json() as ScreenedQuestionsResponse).today).toBe(0);
  });
});
