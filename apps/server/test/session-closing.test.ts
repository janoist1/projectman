import type { ProjectConfig, Session, SessionStop } from '@projectman/shared';
import { SESSION_IDLE_CLOSE_MINUTES } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiActor } from '../src/kernel';
import { stopStageReviewers } from '../src/core/projects';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/*
 * PM-295: a session closes by itself when its member's step on the card is done, or after a quarter of
 * an hour of silence. It never closes while it works, and never a meeting's. The conversation stays:
 * the next message or hand-over resumes it. Every stop records its reason on the session (`lastStop`)
 * and on the `session_ended` event.
 */

const task = { type: 'task', taskKey: 'AR-1' } as const;
const MINUTE = 60_000;

describe('closing finished and idle sessions', () => {
  let h: DomainHarness;
  let now: Date;
  afterEach(async () => {
    await h.cleanup();
  });

  /**
   * dev-1 works AR-1 in development, its session started and (unless `firstTurn` is false: it still
   * awaits its first turn) went working.
   */
  async function setup(
    opts: {
      firstTurn?: boolean;
      adjust?: (config: ProjectConfig) => void;
      heavyRunSessions?: () => Promise<string[]>;
    } = {},
  ) {
    now = new Date('2026-10-04T08:00:00.000Z');
    h = await createDomainHarness({
      now: () => now,
      adjust: opts.adjust,
      heavyRunSessions: opts.heavyRunSessions,
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    const session = h.repos.sessions.findByWorkItem('AR', 'dev-1', task)!;
    // Its first turn started (a session that still awaits it counts as at work).
    if (opts.firstTurn !== false) h.runner.setState(session.id, 'working');
    // It has a conversation to resume.
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: `/tmp/${session.id}.jsonl` });
    return session;
  }
  const handOver = () => h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
  const back = () => h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
  const fresh = (id: string): Session => h.repos.sessions.get(id)!;
  const endedStop = (id: string): SessionStop | undefined =>
    h.domain.timeline
      .list('AR', { taskKey: 'AR-1' })
      .filter((e) => e.type === 'session_ended' && e.sessionId === id)
      .map((e) => e.data.stop as SessionStop | undefined)
      .at(-1);
  const advance = (minutes: number) => {
    now = new Date(now.getTime() + minutes * MINUTE);
  };

  describe('when the step is done', () => {
    it('closes the idle session of the member the card left, with the reason, and keeps the conversation', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      await handOver();
      await vi.waitFor(() => expect(h.runner.isRunning(dev.id)).toBe(false));
      const closed = fresh(dev.id);
      expect(closed.state).toBe('exited');
      expect(closed.lastStop).toEqual({ kind: 'step_done', taskKey: 'AR-1', stageId: 'code_review' });
      expect(endedStop(dev.id)).toEqual(closed.lastStop);
      expect(closed.claudeSessionId).toBe(dev.claudeSessionId);
      // The reviewer, whose step it is now, keeps working.
      await vi.waitFor(() => expect(h.runner.started.some((s) => s.member === 'cr')).toBe(true));
      const reviewer = h.repos.sessions.findByWorkItem('AR', 'cr', task)!;
      expect(h.runner.isRunning(reviewer.id)).toBe(true);
    });

    it('does not close a session that works; it closes when the turn ends', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'working');
      await handOver();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.runner.isRunning(dev.id)).toBe(true);
      expect(h.runner.stopped).not.toContain(dev.id);

      h.runner.setState(dev.id, 'idle');
      await vi.waitFor(() => expect(h.runner.isRunning(dev.id)).toBe(false));
      expect(fresh(dev.id).lastStop).toMatchObject({ kind: 'step_done', stageId: 'code_review' });
    });

    it('keeps the session open when the card comes back to its member before the turn ends', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'working');
      await handOver();
      await back();
      h.runner.setState(dev.id, 'idle');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.runner.isRunning(dev.id)).toBe(true);
      expect(fresh(dev.id).lastStop).toBeUndefined();
    });

    it('records that the card was sent back for the reviewer whose work it left', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      await handOver();
      await vi.waitFor(() => expect(h.runner.started.some((s) => s.member === 'cr')).toBe(true));
      const reviewer = h.repos.sessions.findByWorkItem('AR', 'cr', task)!;
      h.runner.setState(reviewer.id, 'working');
      h.runner.setState(reviewer.id, 'idle');
      await back();
      await vi.waitFor(() => expect(h.runner.isRunning(reviewer.id)).toBe(false));
      expect(fresh(reviewer.id).lastStop).toEqual({
        kind: 'sent_back',
        taskKey: 'AR-1',
        stageId: 'development',
      });
      expect(endedStop(reviewer.id)).toEqual(fresh(reviewer.id).lastStop);
    });

    it('does not close a session whose input is on its way into the process', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      h.runner.pendingInput.add(dev.id);
      await handOver();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.runner.isRunning(dev.id)).toBe(true);
    });

    /** A message for dev-1 that was not typed in (typing it failed once): it waits, not held back. */
    async function waitingMessage(dev: Session) {
      const typeInto = h.domain.sessions.typeInto.bind(h.domain.sessions);
      let failed = false;
      vi.spyOn(h.domain.sessions, 'typeInto').mockImplementation(async (session, text) => {
        if (!failed && text.includes('Mind the edge')) {
          failed = true;
          throw new Error('typing failed');
        }
        return typeInto(session, text);
      });
      await h.domain.messaging.send(
        'AR',
        'owner',
        { to: ['dev-1'], taskKey: 'AR-1', text: 'Mind the edge case.' },
        { actor: OWNER_ACTOR },
      );
      await flush();
      expect(h.repos.messages.pending('AR', dev.member)).toHaveLength(1);
    }

    it('does not close a session a message waits for, but types the message in; it closes after that', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      await waitingMessage(dev);
      await handOver();
      await vi.waitFor(() =>
        expect(
          h.runner.messages.some((m) => m.sessionId === dev.id && m.text.includes('Mind the edge')),
        ).toBe(true),
      );
      expect(h.runner.isRunning(dev.id)).toBe(true);

      // The message is in; the next round of the sweep closes the marked session.
      await vi.waitFor(async () => {
        await h.domain.sessionCloser.sweep();
        expect(h.runner.isRunning(dev.id)).toBe(false);
      });
      expect(fresh(dev.id).lastStop).toMatchObject({ kind: 'step_done', stageId: 'code_review' });
    });

    it('closes a session whose waiting message the card holds back, and does not wake it', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      await waitingMessage(dev);
      vi.spyOn(h.domain.messaging, 'holdsMessagesOf').mockResolvedValue(true);
      await handOver();
      await vi.waitFor(() => expect(h.runner.isRunning(dev.id)).toBe(false));
      await flush();
      expect(h.runner.started.filter((s) => s.sessionId === dev.id)).toHaveLength(1);
      expect(h.repos.messages.pending('AR', dev.member)).toHaveLength(1);
    });

    it('wakes the same conversation for a message that came while the session closed', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      const stop = h.runner.stop.bind(h.runner);
      vi.spyOn(h.runner, 'stop').mockImplementation(async (id) => {
        // The message comes after the closing began: nothing is typed into the session any more.
        if (id === dev.id)
          await h.domain.messaging.send(
            'AR',
            'owner',
            { to: ['dev-1'], taskKey: 'AR-1', text: 'Came as you closed.' },
            { actor: OWNER_ACTOR },
          );
        return stop(id);
      });
      advance(SESSION_IDLE_CLOSE_MINUTES);
      await h.domain.sessionCloser.sweep();
      await vi.waitFor(() => expect(h.runner.started.filter((s) => s.sessionId === dev.id)).toHaveLength(2));
      expect(h.runner.messages.filter((m) => m.text.includes('Came as you closed'))).toEqual([]);
      expect(h.runner.started.filter((s) => s.sessionId === dev.id).at(-1)).toMatchObject({
        claudeSessionId: dev.claudeSessionId,
        resume: true,
        initialMessage: expect.stringContaining('Came as you closed.'),
      });
    });

    it('does not close in a permission wait', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'waiting_permission');
      await handOver();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.runner.isRunning(dev.id)).toBe(true);
      expect(await h.domain.sessions.close('AR', dev.id, { kind: 'step_done' })).toBeNull();
    });

    it('does not close while the session awaits its first turn, and closes once it has run', async () => {
      const dev = await setup({ firstTurn: false });
      h.runner.setState(dev.id, 'idle');
      await handOver();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.runner.isRunning(dev.id)).toBe(true);
      expect(await h.domain.sessions.close('AR', dev.id, { kind: 'step_done' })).toBeNull();
      advance(2 * SESSION_IDLE_CLOSE_MINUTES);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(true);

      h.runner.setState(dev.id, 'working');
      h.runner.setState(dev.id, 'idle');
      await vi.waitFor(() => expect(h.runner.isRunning(dev.id)).toBe(false));
    });

    it('does not close a marked session the card came back to, also at a sweep', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      // A pause keeps the close from happening, the mark stays; the card is back before the pause ends.
      const by = { userId: null, source: 'system' } as const;
      const project = { scope: 'project', projectKey: 'AR' } as const;
      await h.domain.pauses.pause(project, by);
      await handOver();
      expect(h.domain.sessions.pendingClose(dev.id)).toBeDefined();
      await back();
      await h.domain.pauses.resume(project, by);
      await h.domain.sessionCloser.sweep();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.runner.isRunning(dev.id)).toBe(true);
      expect(fresh(dev.id).lastStop).toBeUndefined();
      expect(h.domain.sessions.pendingClose(dev.id)).toBeUndefined();
    });

    it('lets the sweep look at the step again for a mark that was left behind', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      h.domain.sessions.closeWhenIdle(dev, { kind: 'step_done', taskKey: 'AR-1', stageId: 'code_review' });
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(true);
      expect(h.domain.sessions.pendingClose(dev.id)).toBeUndefined();
    });

    it('resumes the same conversation on the next hand-over', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      await handOver();
      await vi.waitFor(() => expect(h.runner.isRunning(dev.id)).toBe(false));

      await back();
      const resumed = await h.domain.sessions.ensureSession('AR', 'dev-1', task, {
        messages: ['Please fix the findings.'],
      });
      expect(resumed).toMatchObject({ created: false, resumed: true, started: true });
      expect(resumed.session.id).toBe(dev.id);
      expect(h.runner.started.filter((s) => s.sessionId === dev.id).at(-1)).toMatchObject({
        claudeSessionId: dev.claudeSessionId,
        resume: true,
      });
      // The reason of the earlier stop is over once the session runs again.
      expect(fresh(dev.id).lastStop).toBeUndefined();
    });
  });

  describe('after a quarter of an hour of silence', () => {
    it('keeps a heavy run open and grants an idle interval after its last sighting', async () => {
      const runs = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
      const dev = await setup({ heavyRunSessions: runs });
      h.runner.setState(dev.id, 'idle');
      advance(14);
      await h.domain.sessionCloser.sweep();
      expect(runs).not.toHaveBeenCalled();
      runs.mockResolvedValue([dev.id]);
      advance(2);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(true);
      runs.mockResolvedValue([]);
      advance(14);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(true);
      advance(1);
      await h.domain.sessionCloser.sweep();
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'idle', idleMinutes: 31 });
    });

    it('closes at 120 minutes even when a heavy run is still present', async () => {
      const runs = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
      const dev = await setup({ heavyRunSessions: runs });
      runs.mockResolvedValue([dev.id]);
      h.runner.setState(dev.id, 'idle');
      advance(119);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(true);
      advance(1);
      await h.domain.sessionCloser.sweep();
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'idle', idleMinutes: 120 });
    });

    it('closes normally when the heavy-run reader fails', async () => {
      const dev = await setup({
        heavyRunSessions: async () => {
          throw new Error('unavailable');
        },
      });
      h.runner.setState(dev.id, 'idle');
      advance(16);
      await h.domain.sessionCloser.sweep();
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'idle', idleMinutes: 16 });
    });

    it('closes normally when the session engine is missing', async () => {
      const runs = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
      const dev = await setup({ heavyRunSessions: runs });
      h.runner.setState(dev.id, 'idle');
      await flush();
      h.repos.sessions.update(dev.id, { engineId: 'eng_000000000000' as never });
      expect(fresh(dev.id).engineId).toBe('eng_000000000000');
      advance(16);
      await h.domain.sessionCloser.sweep();
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'idle', idleMinutes: 16 });
      expect(runs).not.toHaveBeenCalled();
    });

    it('closes a finished step even with a heavy run present', async () => {
      const runs = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
      const dev = await setup({ heavyRunSessions: runs });
      runs.mockResolvedValue([dev.id]);
      h.runner.setState(dev.id, 'idle');
      advance(16);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(true);
      await handOver();
      await vi.waitFor(() => expect(h.runner.isRunning(dev.id)).toBe(false));
      expect(fresh(dev.id).lastStop).toMatchObject({ kind: 'step_done' });
    });

    it('queries an engine only once per sweep for multiple idle sessions', async () => {
      const runs = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
      const dev = await setup({ heavyRunSessions: runs });
      const { session: general } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      for (const id of [dev.id, general.id]) {
        h.runner.setState(id, 'working');
        h.runner.setState(id, 'idle');
      }
      runs.mockResolvedValue([dev.id, general.id]);
      advance(16);
      await h.domain.sessionCloser.sweep();
      expect(runs).toHaveBeenCalledTimes(1);
      expect(h.runner.isRunning(dev.id)).toBe(true);
      expect(h.runner.isRunning(general.id)).toBe(true);
    });

    it('closes an idle session that has been silent that long, with the reason', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      advance(SESSION_IDLE_CLOSE_MINUTES - 1);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(true);

      advance(1);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(false);
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'idle', idleMinutes: SESSION_IDLE_CLOSE_MINUTES });
      expect(endedStop(dev.id)).toEqual(fresh(dev.id).lastStop);
    });

    it('does not close a session that works, however long the turn takes', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'working');
      advance(3 * 60);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(true);
    });

    it('does not close a session that waits for an answer to its question before its turn ended', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'waiting_input');
      advance(2 * SESSION_IDLE_CLOSE_MINUTES);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(true);
    });

    it('never closes a meeting session', async () => {
      const dev = await setup();
      const { session: meeting } = await h.domain.sessions.ensureSession('AR', 'dev-1', {
        type: 'meeting',
        meetingId: 'M-1',
      });
      h.runner.setState(meeting.id, 'working');
      h.runner.setState(meeting.id, 'idle');
      h.runner.setState(dev.id, 'idle');
      advance(2 * SESSION_IDLE_CLOSE_MINUTES);
      await h.domain.sessionCloser.sweep();
      // The card's session closes (it was silent), the meeting's stays.
      expect(h.runner.isRunning(dev.id)).toBe(false);
      expect(h.runner.isRunning(meeting.id)).toBe(true);
      expect(fresh(meeting.id).lastStop).toBeUndefined();
    });

    it('counts from the stored last activity, so a restart of the server counts right', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      h.repos.sessions.update(dev.id, {
        lastActivityAt: new Date(now.getTime() - 40 * MINUTE).toISOString(),
      });
      await h.domain.sessionCloser.sweep();
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'idle', idleMinutes: 40 });
    });

    it('wakes a message that came as the session closed, in the same conversation', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      advance(SESSION_IDLE_CLOSE_MINUTES);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(false);

      await h.domain.messaging.send(
        'AR',
        'owner',
        { to: ['dev-1'], taskKey: 'AR-1', text: 'Are you there?' },
        { actor: OWNER_ACTOR },
      );
      await vi.waitFor(() => expect(h.runner.started).toHaveLength(2));
      expect(h.runner.lastStarted()).toMatchObject({
        sessionId: dev.id,
        claudeSessionId: dev.claudeSessionId,
        resume: true,
        initialMessage: expect.stringContaining('Are you there?'),
      });
    });
  });

  describe('the other sessions that fall silent', () => {
    it('closes the idle general session of a member, with the reason', async () => {
      await setup();
      const { session: general } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      h.runner.setState(general.id, 'working');
      h.runner.setState(general.id, 'idle');
      advance(SESSION_IDLE_CLOSE_MINUTES);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(general.id)).toBe(false);
      expect(fresh(general.id).lastStop).toEqual({ kind: 'idle', idleMinutes: SESSION_IDLE_CLOSE_MINUTES });
    });

    it('closes the idle session of a scheduled run, and the run is done', async () => {
      now = new Date('2026-10-04T08:00:00.000Z');
      h = await createDomainHarness({
        now: () => now,
        adjust: (config) => {
          const member = config.team.members.find((m) => m.handle === 'dev-1')!;
          if (member.kind === 'ai') member.schedule = { cron: '30 10 * * *', prompt: 'Inspect.' };
        },
      });
      expect(await h.domain.schedules.runNow('AR', 'dev-1')).toMatchObject({ status: 'started' });
      const run = h.repos.schedules.list('AR')[0]!;
      const id = run.sessionId!;
      h.runner.setState(id, 'working');
      h.runner.setState(id, 'idle');
      advance(SESSION_IDLE_CLOSE_MINUTES);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(id)).toBe(false);
      expect(fresh(id).lastStop).toMatchObject({ kind: 'idle' });
      expect(h.repos.schedules.get(run.id)?.status).toBe('done');
    });

    it('closes a session that waits for an answer, and the answer resumes the conversation', async () => {
      const dev = await setup();
      const { inboxItemId } = await h.domain.teamTools.askHuman(
        { sessionId: dev.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' },
        { question: 'Which font?', options: ['Yes', 'No'] },
      );
      h.runner.setState(dev.id, 'idle');
      advance(SESSION_IDLE_CLOSE_MINUTES);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(false);
      expect(fresh(dev.id).lastStop).toMatchObject({ kind: 'idle' });

      await h.domain.inbox.resolve(
        'AR',
        inboxItemId,
        { optionId: 'option_1' },
        { handle: 'owner', access: 'owner' },
      );
      await vi.waitFor(() => expect(h.runner.started.filter((s) => s.sessionId === dev.id)).toHaveLength(2));
      expect(h.runner.started.filter((s) => s.sessionId === dev.id).at(-1)).toMatchObject({
        claudeSessionId: dev.claudeSessionId,
        resume: true,
        initialMessage: expect.stringContaining('Answer to your question'),
      });
    });

    it('starts a card that waited for the capacity of a member once its idle session closes', async () => {
      const dev = await setup({
        adjust: (config) => {
          for (const member of config.team.members)
            if (member.kind === 'ai' && member.handle === 'dev-1') member.capacity = 1;
        },
      });
      await h.domain.tasks.create('AR', { title: 'Second page' }, OWNER_ACTOR);
      await h.domain.messaging.send(
        'AR',
        'owner',
        { to: ['dev-1'], taskKey: 'AR-2', text: 'Please look at the second page.' },
        { actor: OWNER_ACTOR },
      );
      await vi.waitFor(() =>
        expect(h.domain.tasks.get('AR', 'AR-2').startWaiting).toMatchObject({ reason: 'member_at_capacity' }),
      );
      h.runner.setState(dev.id, 'idle');
      advance(SESSION_IDLE_CLOSE_MINUTES);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(dev.id)).toBe(false);

      await vi.waitFor(() => expect(h.runner.started.some((s) => s.sessionId !== dev.id)).toBe(true));
      expect(h.runner.lastStarted().initialMessage).toContain('Please look at the second page.');
      expect(h.domain.tasks.get('AR', 'AR-2').startWaiting).toBeUndefined();
    });
  });

  describe("while the reviewer waits for the developer's fix", () => {
    const awaitingFix: SessionStop = { kind: 'awaiting_fix', taskKey: 'AR-1' };
    const changes = { addLabels: ['code-review-changes'], note: 'Please fix the edge case.' };

    /** AR-1 is handed over to code review and the reviewer cr works its round. */
    async function reviewing() {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      await handOver();
      await vi.waitFor(() => expect(h.runner.started.some((s) => s.member === 'cr')).toBe(true));
      const cr = h.repos.sessions.findByWorkItem('AR', 'cr', task)!;
      h.runner.setState(cr.id, 'working');
      h.runner.emit({ type: 'transcript_path', sessionId: cr.id, path: `/tmp/${cr.id}.jsonl` });
      return cr;
    }
    /** The reviewer's own `update_task` call from its session. */
    const verdict = (cr: Session, args: Record<string, unknown>) =>
      h.domain.teamTools.updateTask(
        { projectKey: 'AR', member: 'cr', taskKey: 'AR-1', sessionId: cr.id },
        { taskKey: 'AR-1', ...args },
      );
    const askNewRound = (text: string) =>
      h.domain.messaging.send(
        'AR',
        'dev-1',
        { to: ['cr'], taskKey: 'AR-1', text },
        { actor: aiActor('dev-1') },
      );

    it('closes at the idle moment after the verdict, not while the round goes on, and keeps the conversation', async () => {
      const cr = await reviewing();
      await verdict(cr, changes);
      expect(h.domain.sessions.pendingClose(cr.id)).toEqual(awaitingFix);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.runner.isRunning(cr.id)).toBe(true);

      h.runner.setState(cr.id, 'idle');
      await vi.waitFor(() => expect(h.runner.isRunning(cr.id)).toBe(false));
      expect(fresh(cr.id).lastStop).toEqual(awaitingFix);
      expect(endedStop(cr.id)).toEqual(awaitingFix);
      expect(fresh(cr.id).claudeSessionId).toBe(cr.claudeSessionId);
    });

    it('is woken in the same conversation by the developer asking a new round, and closes again after the second verdict', async () => {
      const cr = await reviewing();
      await verdict(cr, changes);
      h.runner.setState(cr.id, 'idle');
      await vi.waitFor(() => expect(h.runner.isRunning(cr.id)).toBe(false));

      await askNewRound('Fixed, please look again.');
      await vi.waitFor(() => expect(h.runner.started.filter((s) => s.sessionId === cr.id)).toHaveLength(2));
      expect(h.runner.lastStarted()).toMatchObject({
        sessionId: cr.id,
        resume: true,
        claudeSessionId: cr.claudeSessionId,
        initialMessage: expect.stringContaining('Fixed, please look again.'),
      });
      expect(h.domain.sessions.pendingClose(cr.id)).toBeUndefined();

      // The label is up from the first round: asking it again is the second round's verdict.
      h.runner.setState(cr.id, 'working');
      await verdict(cr, changes);
      expect(h.domain.sessions.pendingClose(cr.id)).toEqual(awaitingFix);
      h.runner.setState(cr.id, 'idle');
      await vi.waitFor(() => expect(h.runner.isRunning(cr.id)).toBe(false));
      expect(fresh(cr.id).lastStop).toEqual(awaitingFix);
    });

    it('stays open when the developer asks a new round before the reviewer went idle', async () => {
      const cr = await reviewing();
      await verdict(cr, changes);
      expect(h.domain.sessions.pendingClose(cr.id)).toEqual(awaitingFix);
      await askNewRound('Already fixed, once more please.');
      expect(h.domain.sessions.pendingClose(cr.id)).toBeUndefined();

      h.runner.setState(cr.id, 'idle');
      await vi.waitFor(() =>
        expect(h.runner.messages.some((m) => m.text.includes('Already fixed, once more please.'))).toBe(true),
      );
      expect(h.runner.isRunning(cr.id)).toBe(true);
      expect(fresh(cr.id).lastStop).toBeUndefined();
    });

    it('does not mark a session for an approval', async () => {
      const cr = await reviewing();
      await verdict(cr, { addLabels: ['code-review-ok'] });
      expect(h.domain.sessions.pendingClose(cr.id)).toBeUndefined();
      h.runner.setState(cr.id, 'idle');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.runner.isRunning(cr.id)).toBe(true);
    });

    it('stays open when the verdict is an approval after all in the same round', async () => {
      const cr = await reviewing();
      await verdict(cr, changes);
      await verdict(cr, { addLabels: ['code-review-ok'], removeLabels: ['code-review-changes'] });
      expect(h.domain.tasks.get('AR', 'AR-1').labels).not.toContain('code-review-changes');
      h.runner.setState(cr.id, 'idle');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.runner.isRunning(cr.id)).toBe(true);
      expect(h.domain.sessions.pendingClose(cr.id)).toBeUndefined();
    });

    it('does not mark a session that runs on another work item', async () => {
      await reviewing();
      const { session: general } = await h.domain.sessions.ensureSession('AR', 'cr', { type: 'general' });
      h.runner.setState(general.id, 'working');
      await verdict(general, changes);
      expect(h.domain.sessions.pendingClose(general.id)).toBeUndefined();
    });

    it('lets the sweep close a marked idle session whose idle event was missed', async () => {
      const cr = await reviewing();
      // The session is idle already when the verdict marks it: no idle event follows.
      h.runner.setState(cr.id, 'idle');
      await verdict(cr, changes);
      expect(h.domain.sessions.pendingClose(cr.id)).toEqual(awaitingFix);
      expect(h.runner.isRunning(cr.id)).toBe(true);
      await h.domain.sessionCloser.sweep();
      expect(h.runner.isRunning(cr.id)).toBe(false);
      expect(fresh(cr.id).lastStop).toEqual(awaitingFix);
    });

    it('starts a card that waited for the capacity of the reviewer once its session closes', async () => {
      const dev = await setup({
        adjust: (config) => {
          for (const member of config.team.members)
            if (member.kind === 'ai' && member.handle === 'cr') member.capacity = 1;
        },
      });
      h.runner.setState(dev.id, 'idle');
      await handOver();
      await vi.waitFor(() => expect(h.runner.started.some((s) => s.member === 'cr')).toBe(true));
      const cr = h.repos.sessions.findByWorkItem('AR', 'cr', task)!;
      h.runner.setState(cr.id, 'working');
      await h.domain.tasks.create('AR', { title: 'Second page' }, OWNER_ACTOR);
      await h.domain.messaging.send(
        'AR',
        'owner',
        { to: ['cr'], taskKey: 'AR-2', text: 'Please look at the second page.' },
        { actor: OWNER_ACTOR },
      );
      await vi.waitFor(() =>
        expect(h.domain.tasks.get('AR', 'AR-2').startWaiting).toMatchObject({ reason: 'member_at_capacity' }),
      );

      await verdict(cr, changes);
      h.runner.setState(cr.id, 'idle');
      await vi.waitFor(() => expect(h.runner.isRunning(cr.id)).toBe(false));
      await vi.waitFor(() => expect(h.runner.lastStarted().initialMessage).toContain('second page'));
      expect(h.domain.tasks.get('AR', 'AR-2').startWaiting).toBeUndefined();
    });

    it('keeps the reason of a send-back made in the same call', async () => {
      const cr = await reviewing();
      await verdict(cr, { ...changes, stageId: 'development' });
      h.runner.setState(cr.id, 'idle');
      await vi.waitFor(() => expect(h.runner.isRunning(cr.id)).toBe(false));
      expect(fresh(cr.id).lastStop).toEqual({ kind: 'sent_back', taskKey: 'AR-1', stageId: 'development' });
    });
  });

  describe('the reason of the other stops', () => {
    it('records a finished card on the session it stops', async () => {
      const dev = await setup();
      h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { status: 'done' });
      await h.domain.sessions.cleanupDoneTask('AR', 'AR-1');
      expect(h.runner.isRunning(dev.id)).toBe(false);
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'card_done', taskKey: 'AR-1' });
      expect(endedStop(dev.id)).toEqual({ kind: 'card_done', taskKey: 'AR-1' });
    });

    it('records the stage a card was sent back to on the reviewer that is stopped', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      await handOver();
      await vi.waitFor(() => expect(h.runner.started.some((s) => s.member === 'cr')).toBe(true));
      const reviewer = h.repos.sessions.findByWorkItem('AR', 'cr', task)!;
      // Mid-turn: the card going back only marks it; the stop of the reviewers ends it at once.
      h.runner.setState(reviewer.id, 'working');
      const config = await h.domain.projects.config('AR');
      const stage = config.pipeline.stages.find((s) => s.id === 'code_review')!;
      const backTo = config.pipeline.stages.find((s) => s.id === 'development')!;
      await stopStageReviewers(h.domain.sessions, config, h.domain.tasks.get('AR', 'AR-1'), stage, backTo);
      expect(h.runner.isRunning(reviewer.id)).toBe(false);
      expect(fresh(reviewer.id).lastStop).toEqual({
        kind: 'sent_back',
        taskKey: 'AR-1',
        stageId: 'development',
      });
      expect(endedStop(reviewer.id)).toEqual(fresh(reviewer.id).lastStop);
    });

    it('records a pause on the session whose process ended while the team was paused', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
      h.runner.emit({ type: 'exit', sessionId: dev.id, exitCode: 0, signal: null });
      await vi.waitFor(() => expect(fresh(dev.id).state).toBe('exited'));
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'pause' });
      expect(endedStop(dev.id)).toEqual({ kind: 'pause' });
    });

    it('reads a row without a stored reason, or with a broken one, as a session without a reason', async () => {
      const dev = await setup();
      const store = (value: string | null) =>
        h.repos.db.prepare('UPDATE sessions SET last_stop = ? WHERE id = ?').run(value, dev.id);
      store(null);
      expect(fresh(dev.id).lastStop).toBeUndefined();
      store('{not json');
      expect(fresh(dev.id).lastStop).toBeUndefined();
      store(JSON.stringify({ kind: 'unheard_of' }));
      expect(fresh(dev.id).lastStop).toBeUndefined();
      store(JSON.stringify({ kind: 'idle', idleMinutes: 20 }));
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'idle', idleMinutes: 20 });
    });

    it('records a stop of a person', async () => {
      const dev = await setup();
      await h.domain.sessions.stop('AR', dev.id, { kind: 'manual', by: OWNER_ACTOR });
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'manual', by: OWNER_ACTOR });
      expect(endedStop(dev.id)).toEqual({ kind: 'manual', by: OWNER_ACTOR });
    });

    it('records a cancelled card', async () => {
      const dev = await setup();
      await h.domain.tasks.cancel('AR', 'AR-1', { reason: 'Fictional' }, OWNER_ACTOR);
      await vi.waitFor(() => expect(h.runner.isRunning(dev.id)).toBe(false));
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'task_cancelled', taskKey: 'AR-1', by: OWNER_ACTOR });
      expect(endedStop(dev.id)).toEqual({ kind: 'task_cancelled', taskKey: 'AR-1', by: OWNER_ACTOR });
    });

    it('records an exit reason for a process that exited on its own', async () => {
      const dev = await setup();
      h.runner.emit({ type: 'exit', sessionId: dev.id, exitCode: 0, signal: null });
      await vi.waitFor(() => expect(fresh(dev.id).state).toBe('exited'));
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'exited' });
      expect(endedStop(dev.id)).toEqual({ kind: 'exited' });
    });

    it('leaves no reason on a session that runs', async () => {
      const dev = await setup();
      expect(dev.lastStop).toBeUndefined();
    });
  });
});
