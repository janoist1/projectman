import type { Session, SessionStop } from '@projectman/shared';
import { SESSION_IDLE_CLOSE_MINUTES } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

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

  /** dev-1 works AR-1 in development, its session started. */
  async function setup() {
    now = new Date('2026-10-04T08:00:00.000Z');
    h = await createDomainHarness({ now: () => now });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    const session = h.repos.sessions.findByWorkItem('AR', 'dev-1', task)!;
    // Its first turn started (a session that still awaits it counts as at work).
    h.runner.setState(session.id, 'working');
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

    it('does not close a session whose message is on its way in', async () => {
      const dev = await setup();
      h.runner.setState(dev.id, 'idle');
      h.runner.pendingInput.add(dev.id);
      await handOver();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h.runner.isRunning(dev.id)).toBe(true);
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

  describe('the reason of the other stops', () => {
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
      expect(fresh(dev.id).lastStop).toEqual({ kind: 'task_cancelled', taskKey: 'AR-1' });
      expect(endedStop(dev.id)).toEqual({ kind: 'task_cancelled', taskKey: 'AR-1' });
    });

    it('records no reason for a process that exited on its own (the contract has the kind for PM-274)', async () => {
      const dev = await setup();
      h.runner.emit({ type: 'exit', sessionId: dev.id, exitCode: 0, signal: null });
      await vi.waitFor(() => expect(fresh(dev.id).state).toBe('exited'));
      expect(fresh(dev.id).lastStop).toBeUndefined();
    });

    it('leaves no reason on a session that runs', async () => {
      const dev = await setup();
      expect(dev.lastStop).toBeUndefined();
    });
  });
});
