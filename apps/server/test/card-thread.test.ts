import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUESTION_LIMIT } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * The card's shared thread (PM-249 part 1): a member who joins a card, or returns to it, is told who
 * else works on it and which questions were asked on it.
 */
describe('the card’s thread: workers and questions', () => {
  let h: DomainHarness;
  const task = { type: 'task', taskKey: 'AR-1' } as const;
  const OWNER_RESOLVER = { handle: 'owner', access: 'owner' } as const;

  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(() => h.cleanup());

  /** Timestamps have millisecond resolution: lets the next event be told apart from the last. */
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

  /** `member` asks `question` on AR-1 through the real ask_human tool. */
  async function ask(sessionId: string, member: string, question: string, options?: string[]) {
    const { inboxItemId } = await h.domain.teamTools.askHuman(
      { sessionId, projectKey: 'AR', member, taskKey: 'AR-1' },
      { question, ...(options ? { options } : {}) },
    );
    return inboxItemId;
  }

  /** dev-1 works on AR-1 and has asked one answered and one open question. */
  async function workerWithQuestions() {
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    h.runner.setState(session.id, 'working');
    await h.domain.teamTools.setCurrentWork(
      { sessionId: session.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' },
      { summary: 'The form is being built' },
    );
    const answered = await ask(session.id, 'dev-1', 'Which export format?', ['CSV', 'JSON']);
    await h.domain.inbox.resolve('AR', answered, { optionId: 'option_1' }, OWNER_RESOLVER);
    const open = await ask(session.id, 'dev-1', 'Keep the draft of the form?');
    return { session, answered, open };
  }

  it('names the member who works on the card, with role and sentence, and the card’s questions in the brief of the member who starts', async () => {
    const { session, answered, open } = await workerWithQuestions();
    // Nothing to say at dev-1's own start: the fields are left out.
    expect(h.contextBuilder.inputs[0]).not.toHaveProperty('cardWorkers');
    expect(h.contextBuilder.inputs[0]).not.toHaveProperty('cardQuestions');

    await h.domain.sessions.ensureSession('AR', 'cr', task);
    const input = h.contextBuilder.inputs.at(-1)!;
    expect(input.member.handle).toBe('cr');
    expect(input.cardWorkers).toEqual([
      expect.objectContaining({
        handle: 'dev-1',
        role: 'developer',
        state: 'working',
        doing: { summary: 'The form is being built' },
      }),
    ]);
    expect(input.cardWorkers!.map((w) => w.handle)).not.toContain('cr');
    expect(input.cardQuestions).toEqual([
      expect.objectContaining({
        inboxItemId: answered,
        asker: 'dev-1',
        question: 'Which export format?',
        state: 'answered',
        answer: expect.objectContaining({ by: 'owner', text: expect.stringContaining('CSV') }),
      }),
      expect.objectContaining({ inboxItemId: open, asker: 'dev-1', state: 'open' }),
    ]);
    const events = h.domain.timeline.list('AR', { taskKey: 'AR-1' });
    expect(input.cardQuestions![0]!.askedEventId).toBe(
      events.find((e) => e.type === 'question_asked' && e.data.inboxItemId === answered)?.id,
    );
    expect(input.cardQuestions![0]!.answer!.eventId).toBe(
      events.find((e) => e.type === 'question_answered' && e.data.inboxItemId === answered)?.id,
    );
    expect(session.member).toBe('dev-1');
  });

  it('puts the standing first in the input of a resumed session, and leaves it out of the other restarts', async () => {
    const { session: first } = await workerWithQuestions();
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fake/transcript.jsonl' });
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });

    // cr returns to the card: dev-1 still works on it, and asked a question while cr was away (the
    // two questions from before cr's start are not repeated to it).
    await pause();
    await ask(first.id, 'dev-1', 'Which colour for the button?');
    await h.domain.sessions.ensureSession('AR', 'cr', task);
    const resumed = h.runner.lastStarted();
    expect(resumed).toMatchObject({ sessionId: session.id, resume: true });
    expect(resumed.initialMessage).toMatch(/^Standing AR-1: workers dev-1; questions 1\n\n/);
    const input = h.contextBuilder.inputs.at(-1)!;
    expect(input.cardWorkers?.map((w) => w.handle)).toEqual(['dev-1']);

    // A restart with messages, and a restart for new permissions, are the same turn going on.
    h.runner.setState(session.id, 'idle');
    await expect(
      h.domain.sessions.restartWithMessages('AR', session.id, ['Read the new description']),
    ).resolves.toBe(true);
    const afterMessages = h.runner.lastStarted();
    expect(afterMessages).toMatchObject({ sessionId: session.id, resume: true });
    expect(afterMessages.initialMessage).toContain('Read the new description');
    expect(afterMessages.initialMessage).not.toContain('Standing');

    h.runner.setState(session.id, 'idle');
    await h.domain.sessions.updatePermissions('AR', session.id, { permissionMode: 'plan' }, OWNER_ACTOR);
    await flush();
    const afterPermissions = h.runner.lastStarted();
    expect(h.runner.started.length).toBeGreaterThan(3);
    expect(afterPermissions).toMatchObject({ sessionId: session.id, resume: true });
    expect(afterPermissions.initialMessage ?? '').not.toContain('Standing');
    expect(first.id).not.toBe(session.id);
  });

  it('has no standing when nobody else works on the card and no question was asked', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fake/transcript.jsonl' });
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(h.runner.lastStarted().initialMessage ?? '').not.toContain('Standing');
  });

  it('does not leak a private waking message into another worker’s joined notice', async () => {
    const { session: worker } = await workerWithQuestions();
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    await h.domain.messaging.sendToSession(
      'AR',
      session.id,
      'Private review instructions.',
      'owner',
      OWNER_ACTOR,
    );
    await flush();
    const notices = h.runner.messages.filter((message) => message.sessionId === worker.id);
    expect(JSON.stringify(notices)).toContain('woken by a team message');
    expect(JSON.stringify(notices)).not.toContain('Private review instructions.');
    expect(worker.member).toBe('dev-1');
  });

  it('lists the sessions that work on the card now', async () => {
    const config = await h.domain.projects.config('AR');
    const card = h.domain.tasks.get('AR', 'AR-1');
    expect(h.domain.sessions.cardWorkers('AR', card, config)).toEqual([]);

    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    h.runner.setState(session.id, 'working');
    expect(h.domain.sessions.cardWorkers('AR', card, config).map((s) => s.id)).toEqual([session.id]);
    h.runner.setState(session.id, 'idle');
    expect(h.domain.sessions.cardWorkers('AR', card, config).map((s) => s.id)).not.toContain(session.id);
  });

  describe('CardQuestions.list', () => {
    it('lists every open question and the latest answered ones, oldest first, within the limit', async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
      const ids: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const id = await ask(session.id, 'dev-1', `Answered ${i}?`, ['Yes', 'No']);
        await h.domain.inbox.resolve('AR', id, { optionId: 'option_1' }, OWNER_RESOLVER);
        ids.push(id);
      }
      const open = [await ask(session.id, 'dev-1', 'Open one?'), await ask(session.id, 'dev-1', 'Open two?')];

      const list = h.domain.cardQuestions.list('AR', 'AR-1', { limit: 4 });
      expect(list.map((q) => q.inboxItemId)).toEqual([ids[2], ids[3], ...open]);
      expect(h.domain.cardQuestions.list('AR', 'AR-1', { limit: 1 }).map((q) => q.inboxItemId)).toEqual([
        open[1],
      ]);
      expect(h.domain.cardQuestions.list('AR', 'AR-1', { limit: QUESTION_LIMIT })).toHaveLength(6);
      expect(h.domain.cardQuestions.list('AR', 'AR-2', { limit: QUESTION_LIMIT })).toEqual([]);
    });

    it('leaves out cancelled questions and keeps only what is newer than `since`', async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
      const old = await ask(session.id, 'dev-1', 'Old question?', ['Yes', 'No']);
      await h.domain.inbox.resolve('AR', old, { optionId: 'option_1' }, OWNER_RESOLVER);
      const gone = await ask(session.id, 'dev-1', 'Withdrawn question?');
      h.domain.inbox.cancel(gone);
      await pause();
      const fresh = await ask(session.id, 'dev-1', 'Fresh question?');

      expect(
        h.domain.cardQuestions.list('AR', 'AR-1', { limit: QUESTION_LIMIT }).map((q) => q.inboxItemId),
      ).toEqual([old, fresh]);
      const since = h.domain.inbox.get('AR', old).resolution!.at;
      expect(
        h.domain.cardQuestions.list('AR', 'AR-1', { limit: QUESTION_LIMIT, since }).map((q) => q.inboxItemId),
      ).toEqual([fresh]);
    });
  });

  it('puts the working sessions and the card’s questions into get_task', async () => {
    const { session, answered } = await workerWithQuestions();
    const detail = await h.domain.teamTools.getTask(
      { sessionId: session.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' },
      { taskKey: 'AR-1' },
    );
    expect(detail.workingSessionIds).toEqual([session.id]);
    expect(detail.cardQuestions?.map((q) => q.inboxItemId)).toContain(answered);
    expect(detail.cardQuestions).toHaveLength(2);
  });
});
