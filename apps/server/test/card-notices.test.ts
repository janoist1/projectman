import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * The signals to the members working on a card (PM-249 part 2): who joined and why, and what a person
 * answered to a question asked on the card. Neither starts a session or a turn.
 */
describe('notices to the members working on a card', () => {
  let h: DomainHarness;
  const task = { type: 'task', taskKey: 'AR-1' } as const;
  const OWNER_RESOLVER = { handle: 'owner', access: 'owner' } as const;
  const PAUSE_BY = { userId: null, source: 'system' } as const;
  const TAIL =
    "Coordinate by send_message with the members it concerns, and do not overwrite each other's part.";

  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  /** What was typed into the session after it started. */
  const baseline = new Map<string, number>();
  const typedInto = (session: Session) =>
    h.runner.messages
      .filter((m) => m.sessionId === session.id)
      .map((m) => m.text)
      .slice(baseline.get(session.id) ?? 0);
  const notice = (text: string) => `[team message from projectman about AR-1]\n${text}`;

  /** dev-1 works on AR-1 in the development stage (its assignee), in the given state. */
  async function developer(state: 'working' | 'idle'): Promise<Session> {
    const { session } = await h.domain.taskStarts.start('AR', 'AR-1', {
      assignee: 'dev-1',
      actor: OWNER_ACTOR,
      author: OWNER,
    });
    h.runner.setState(session!.id, state);
    // The hand-over notice of the start is not what these tests look at.
    await flush();
    baseline.set(session!.id, h.runner.messages.filter((m) => m.sessionId === session!.id).length);
    return session!;
  }

  /** The owner writes to dev-2 about the card: its session starts for the message. */
  async function dev2WokenByOwner(): Promise<Session> {
    await h.domain.messaging.send('AR', 'owner', { to: ['dev-2'], text: 'Please help', taskKey: 'AR-1' });
    await vi.waitFor(() => expect(h.domain.sessions.findRunning('AR', 'dev-2', task)).toBeTruthy());
    await flush();
    return h.domain.sessions.findRunning('AR', 'dev-2', task)!;
  }

  async function ask(session: Session, question: string, taskKey?: string) {
    const { inboxItemId } = await h.domain.teamTools.askHuman(
      { sessionId: session.id, projectKey: 'AR', member: session.member, taskKey: taskKey ?? 'AR-1' },
      { question },
    );
    return inboxItemId;
  }

  describe('a member joins', () => {
    it('tells a working member who came, in which role and why, without a stored message or a session', async () => {
      const dev1 = await developer('working');
      const started = h.runner.started.length;

      const dev2 = await dev2WokenByOwner();

      expect(h.runner.started).toHaveLength(started + 1);
      expect(typedInto(dev1)).toEqual([
        notice(
          `\`dev-2\` (developer) started working on AR-1 too (woken by a team message from \`owner\`). ${TAIL}`,
        ),
      ]);
      // The joining member is not told about itself, and nothing was stored.
      expect(typedInto(dev2)).toEqual([]);
      expect(h.repos.messages.pending('AR', 'dev-1')).toEqual([]);
      expect(h.runner.started).toHaveLength(started + 1);
    });

    it('keeps the notice for an idle member and types it in front of its next input, once', async () => {
      const dev1 = await developer('idle');
      await dev2WokenByOwner();
      expect(typedInto(dev1)).toEqual([]);

      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Status?', taskKey: 'AR-1' });
      await flush();
      expect(typedInto(dev1)).toEqual([
        `${notice(`\`dev-2\` (developer) started working on AR-1 too (woken by a team message from \`owner\`). ${TAIL}`)}\n\n[team message from owner about AR-1]\nStatus?`,
      ]);

      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Again?', taskKey: 'AR-1' });
      await flush();
      expect(typedInto(dev1)[1]).toBe('[team message from owner about AR-1]\nAgain?');
    });

    it('loses the notice kept for a session that ended', async () => {
      const dev1 = await developer('idle');
      await dev2WokenByOwner();
      h.runner.emit({ type: 'transcript_path', sessionId: dev1.id, path: '/fake/transcript.jsonl' });
      h.runner.emit({ type: 'exit', sessionId: dev1.id, exitCode: 0, signal: null });
      await flush();

      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
      h.runner.setState(session.id, 'idle');
      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Back?', taskKey: 'AR-1' });
      await flush();
      expect(typedInto(session)).toEqual(['[team message from owner about AR-1]\nBack?']);
    });

    it('says nothing for a restart or a next turn, and “again” for a resumed conversation', async () => {
      const dev1 = await developer('working');
      const dev2 = await dev2WokenByOwner();
      expect(typedInto(dev1)).toHaveLength(1);

      // A restart with messages and one for new permissions are the same turn going on.
      h.runner.setState(dev2.id, 'idle');
      await h.domain.sessions.restartWithMessages('AR', dev2.id, ['Read the new description']);
      h.runner.setState(dev2.id, 'idle');
      await h.domain.sessions.updatePermissions('AR', dev2.id, { permissionMode: 'plan' }, OWNER_ACTOR);
      await flush();
      // The next turns of dev-2 are not joinings.
      h.runner.setState(dev2.id, 'working');
      h.runner.setState(dev2.id, 'idle');
      await flush();
      expect(typedInto(dev1)).toHaveLength(1);

      // It leaves and comes back: the conversation resumes, without a known cause.
      h.runner.emit({ type: 'transcript_path', sessionId: dev2.id, path: '/fake/transcript.jsonl' });
      h.runner.emit({ type: 'exit', sessionId: dev2.id, exitCode: 0, signal: null });
      await flush();
      await h.domain.sessions.ensureSession('AR', 'dev-2', task);
      await vi.waitFor(() => expect(typedInto(dev1)).toHaveLength(2));
      expect(typedInto(dev1)[1]).toBe(notice(`\`dev-2\` (developer) is working on AR-1 again. ${TAIL}`));
    });

    it('names the stage and who moved the card when a hand-over starts the member', async () => {
      const dev1 = await developer('working');

      await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
      await vi.waitFor(() => expect(h.domain.sessions.findRunning('AR', 'cr', task)).toBeTruthy());

      await vi.waitFor(() =>
        expect(typedInto(dev1)).toContain(
          notice(
            `\`cr\` (code reviewer) started working on AR-1 too (the card entered Code review, moved by \`owner\`). ${TAIL}`,
          ),
        ),
      );
    });

    it('names who started the task', async () => {
      const dev1 = await developer('working');
      // Clearing the assignee leaves nothing to hand over, so the start is not held for a handoff note (PM-342).
      h.domain.tasks.assign('AR', 'AR-1', null, OWNER_ACTOR);

      await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-2', actor: OWNER_ACTOR, author: OWNER });

      await vi.waitFor(() =>
        expect(typedInto(dev1)).toContain(
          notice(`\`dev-2\` (developer) started working on AR-1 too (started by \`owner\`). ${TAIL}`),
        ),
      );
    });

    it('names a person who writes into a stopped session', async () => {
      const dev1 = await developer('working');
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-2', task);
      h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fake/transcript.jsonl' });
      h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
      await flush();
      const before = typedInto(dev1).length;

      await h.domain.messaging.sendToSession('AR', session.id, 'Are you there?', 'owner');

      await vi.waitFor(() => expect(typedInto(dev1)).toHaveLength(before + 1));
      expect(typedInto(dev1).at(-1)).toBe(
        notice(
          `\`dev-2\` (developer) is working on AR-1 again (woken by a team message from \`owner\`). ${TAIL}`,
        ),
      );
    });

    it('tells nothing about a general chat or when nobody else works on the card', async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      await h.domain.sessions.ensureSession('AR', 'dev-2', task);
      await flush();
      expect(typedInto(session)).toEqual([]);
    });
  });

  describe('a question is answered', () => {
    /** dev-1 asks, dev-2 and cr work on the card too. */
    async function threeWorkers() {
      const dev1 = await developer('working');
      const dev2 = (await h.domain.sessions.ensureSession('AR', 'dev-2', task)).session;
      const cr = (await h.domain.sessions.ensureSession('AR', 'cr', task)).session;
      h.runner.setState(dev2.id, 'working');
      h.runner.setState(cr.id, 'working');
      return { dev1, dev2, cr };
    }

    it('gives the asker the answer it had, and the other workers the question and the answer once', async () => {
      const { dev1, dev2, cr } = await threeWorkers();
      const id = await ask(dev1, 'Which export format?');
      const before = { dev1: typedInto(dev1).length, dev2: typedInto(dev2).length, cr: typedInto(cr).length };

      await h.domain.inbox.resolve('AR', id, { optionId: 'answer', note: 'CSV, please' }, OWNER_RESOLVER);
      await flush();

      const expected = notice(
        'On AR-1, `dev-1` asked a person: "Which export format?" `owner` answered: "CSV, please". Do not ask it again.',
      );
      expect(typedInto(dev2).slice(before.dev2)).toEqual([expected]);
      expect(typedInto(cr).slice(before.cr)).toEqual([expected]);
      const asker = typedInto(dev1).slice(before.dev1);
      expect(asker).toHaveLength(1);
      expect(asker[0]).toContain('Answer to your question "Which export format?"');
      expect(asker[0]).not.toContain('Do not ask it again');
      expect(h.repos.messages.pending('AR', 'dev-2')).toEqual([]);
    });

    it('marks the answer message with the question and the answer, in the record and in the event', async () => {
      const dev1 = await developer('working');
      const id = await ask(dev1, 'Which export format?');
      const events: Array<{ id: string; answer?: unknown }> = [];
      h.domain.bus.subscribe((event) => {
        if (event.type === 'team_message') events.push(event.message);
      });

      await h.domain.inbox.resolve('AR', id, { optionId: 'answer', note: 'CSV, please' }, OWNER_RESOLVER);
      await flush();

      const marked = { inboxItemId: id, question: 'Which export format?', answer: 'CSV, please' };
      const stored = h.repos.messages.list('AR', { taskKey: 'AR-1' }).filter((m) => m.answer);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ from: 'owner', to: ['dev-1'], answer: marked });
      expect(stored[0]!.body).toContain('Answer to your question "Which export format?"');
      expect(events.filter((m) => m.id === stored[0]!.id).map((m) => m.answer)).toContainEqual(marked);
    });

    it('cuts a long question and answer, and names the event that has them whole', async () => {
      const { dev1, dev2 } = await threeWorkers();
      const question = `Q${'x'.repeat(250)}`;
      const answer = `A${'y'.repeat(600)}`;
      const id = await ask(dev1, question);
      const before = typedInto(dev2).length;

      await h.domain.inbox.resolve('AR', id, { optionId: 'answer', note: answer }, OWNER_RESOLVER);
      await flush();

      const eventId = h.domain.timeline
        .list('AR', { taskKey: 'AR-1' })
        .find((e) => e.type === 'question_answered' && e.data.inboxItemId === id)!.id;
      expect(typedInto(dev2).slice(before)).toEqual([
        notice(
          `On AR-1, \`dev-1\` asked a person: "Q${'x'.repeat(198)}…" \`owner\` answered: "A${'y'.repeat(498)}…". ` +
            `Do not ask it again. If it is cut, read it whole: get_task task_key AR-1, event_id ${eventId}.`,
        ),
      ]);
    });

    it('keeps the notice for an idle worker until its next input', async () => {
      const dev1 = await developer('idle');
      const dev2 = (await h.domain.sessions.ensureSession('AR', 'dev-2', task)).session;
      h.runner.setState(dev2.id, 'working');
      const id = await ask(dev2, 'Which export format?');

      await h.domain.inbox.resolve('AR', id, { optionId: 'answer', note: 'CSV' }, OWNER_RESOLVER);
      await flush();
      expect(typedInto(dev1)).toEqual([]);

      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Status?', taskKey: 'AR-1' });
      await flush();
      // The notices kept meanwhile (dev-2 joining, the answer) go in one input, in front of the message.
      expect(typedInto(dev1)).toEqual([
        [
          notice(`\`dev-2\` (developer) started working on AR-1 too. ${TAIL}`),
          notice(
            'On AR-1, `dev-2` asked a person: "Which export format?" `owner` answered: "CSV". Do not ask it again.',
          ),
          '[team message from owner about AR-1]\nStatus?',
        ].join('\n\n'),
      ]);
    });

    it('says nothing when a session starts again after a pause that cut it mid-turn', async () => {
      const { dev1, dev2 } = await threeWorkers();
      const before = typedInto(dev1).length;
      const started = h.runner.started.length;
      h.runner.pauseOutcomes.set(dev2.id, { point: 'before_tool', tool: 'Bash' });
      await h.domain.pauses.pause({ scope: 'instance' }, PAUSE_BY);
      // Its process leaves with the pause, as at a shutdown.
      h.runner.emit({ type: 'transcript_path', sessionId: dev2.id, path: '/fake/transcript.jsonl' });
      h.runner.emit({ type: 'exit', sessionId: dev2.id, exitCode: 0, signal: null });
      await flush();

      await h.domain.pauses.resume({ scope: 'instance' }, PAUSE_BY);
      await flush();

      expect(h.runner.started).toHaveLength(started + 1);
      expect(h.runner.lastStarted()).toMatchObject({ sessionId: dev2.id, resume: true });
      expect(
        typedInto(dev1)
          .slice(before)
          .filter((text) => text.includes(TAIL)),
      ).toEqual([]);
    });

    it('says nothing for a question without a card or on a closed card', async () => {
      const { dev1, dev2 } = await threeWorkers();
      const general = await h.domain.teamTools.askHuman(
        { sessionId: dev1.id, projectKey: 'AR', member: 'dev-1', taskKey: null },
        { question: 'Is the office open?' },
      );
      await h.domain.inbox.resolve(
        'AR',
        general.inboxItemId,
        { optionId: 'answer', note: 'Yes' },
        OWNER_RESOLVER,
      );
      await flush();

      const closed = await ask(dev1, 'Anything else?');
      h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { status: 'done' });
      await h.domain.inbox.resolve('AR', closed, { optionId: 'answer', note: 'No' }, OWNER_RESOLVER);
      await flush();

      expect(typedInto(dev2).filter((text) => text.includes('Do not ask it again'))).toEqual([]);
    });
  });
});
