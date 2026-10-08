import { HANDOFF_TIMEOUT_MS } from '@projectman/shared';
import type { HandoffSummary, ProjectConfig, Session } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { planUsage, settle } from './helpers/fakes';

/*
 * PM-342 2/3: the handoff of a card's assignee. The old AI member's session is stopped at a safe point
 * and asked for a `hand_off` note within ten minutes; when that is not possible or too slow, the summary
 * of its transcript stands in. The receiver's start waits for it. AR-1 is carried by `dev-1`; the card
 * goes to `dev-2`.
 */

const TASK = { type: 'task', taskKey: 'AR-1' } as const;
const MINUTE = 60_000;
const summary: HandoffSummary = { source: 'last_replies', text: 'Login form is done.', at: null };

describe('the handoff of a card changing its assignee', () => {
  let h: DomainHarness;
  let now: Date;
  afterEach(() => h?.cleanup());

  /** dev-1 works AR-1 (its session idle, with a conversation to resume or summarize). */
  async function setup(
    opts: { adjust?: (config: ProjectConfig) => void; persistent?: boolean; transcript?: boolean } = {},
  ): Promise<Session> {
    now = new Date('2026-10-05T08:00:00.000Z');
    h = await createDomainHarness({ now: () => now, adjust: opts.adjust, persistent: opts.persistent });
    h.runner.idleOnStart = true;
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    await settle();
    const session = h.repos.sessions.findByWorkItem('AR', 'dev-1', TASK)!;
    if (opts.transcript !== false) {
      h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: `/tmp/${session.id}.jsonl` });
      h.runnerModule.summaries.set(`/tmp/${session.id}.jsonl`, summary);
    }
    return session;
  }

  const reassign = (to: string | null) => h.domain.tasks.update('AR', 'AR-1', { assignee: to }, OWNER_ACTOR);
  const task = () => h.domain.tasks.get('AR', 'AR-1');
  const open = () => h.repos.taskHandoffs.open('AR-1') ?? undefined;
  const row = () => h.repos.taskHandoffs.latestClosed('AR-1') ?? undefined;
  const phases = () =>
    h.repos.timeline
      .list('AR', { taskKey: 'AR-1' })
      .filter((e) => e.type === 'task_handoff')
      .map((e) => e.data.phase as string);
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const startedFor = (member: string) => h.runner.started.filter((s) => s.member === member);
  const note = (session: Session, text = 'Form is done; the API call is missing.') =>
    h.domain.handoffs.recordNote({ projectKey: 'AR', member: 'dev-1', sessionId: session.id }, 'AR-1', text);
  const ended = (session: Session) =>
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });

  describe('a live handoff', () => {
    it('stops the running session at a safe point, tells it to write, and the receiver starts with the note', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');
      h.runner.pauseOutcomes.set(dev1.id, { point: 'after_tool', tool: 'Bash' });

      const response = await reassign('dev-2');
      expect(response.handoffStart).toEqual({ mode: 'live', from: 'dev-1' });
      expect(response.assignee).toBe('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));

      expect(h.runner.pauses.map((p) => p.sessionId)).toEqual([dev1.id]);
      expect(h.runner.releases).toEqual([{ sessionId: dev1.id, nudge: 'Hand off AR-1 to dev-2' }]);
      expect(task().handoff).toMatchObject({ from: 'dev-1', to: 'dev-2', step: 'writing', reason: 'manual' });
      expect(task().handoff?.deadlineAt).toBe(new Date(now.getTime() + HANDOFF_TIMEOUT_MS).toISOString());
      // The receiver waits for the note.
      expect(startedFor('dev-2')).toHaveLength(0);
      await expect(h.domain.sessions.ensureSession('AR', 'dev-2', TASK)).rejects.toMatchObject({
        code: 'task_handoff_open',
      });

      await note(dev1);
      expect(open()?.step).toBe('closing');
      // The old session closes at its next idle moment, which ends the handoff.
      h.runner.setState(dev1.id, 'idle');
      await vi.waitFor(() => expect(open()).toBeUndefined());
      await vi.waitFor(() => expect(startedFor('dev-2')).toHaveLength(1));

      expect(row()).toMatchObject({ outcome: 'note', note: 'Form is done; the API call is missing.' });
      const input = h.contextBuilder.inputs.filter((i) => i.member.handle === 'dev-2').at(-1)!;
      expect(input.handoff).toMatchObject({
        from: 'dev-1',
        outcome: 'note',
        note: 'Form is done; the API call is missing.',
      });
      expect(phases()).toEqual(['started', 'note', 'taken_over']);
      expect(task().handoff).toBeUndefined();
      expect(task().lastHandoff).toMatchObject({ outcome: 'note', to: 'dev-2' });
      const stop = h.domain.timeline
        .list('AR', { taskKey: 'AR-1' })
        .filter((e) => e.type === 'session_ended' && e.sessionId === dev1.id)
        .map((e) => e.data.stop);
      expect(stop).toEqual([{ kind: 'handed_off', taskKey: 'AR-1' }]);
    });

    it('types the instruction into an idle session that was stopped at its idle moment', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'idle');

      await reassign('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));

      expect(h.runner.releases).toEqual([{ sessionId: dev1.id, nudge: undefined }]);
      await vi.waitFor(() =>
        expect(h.runner.messages.map((m) => m.text)).toContain('Hand off AR-1 to dev-2'),
      );
    });

    it('resumes a stopped session of the old member to ask it', async () => {
      const dev1 = await setup();
      await h.domain.sessions.stop('AR', dev1.id);
      await settle();
      expect(startedFor('dev-1')).toHaveLength(1);

      await reassign('dev-2');
      await vi.waitFor(() => expect(startedFor('dev-1')).toHaveLength(2));

      expect(h.runner.lastStarted()).toMatchObject({ member: 'dev-1', resume: true });
      expect(open()?.step).toBe('writing');
      expect(startedFor('dev-2')).toHaveLength(0);
    });

    it('takes the note through the hand_off team tool, once, and refuses a second one after the time ran out', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');
      await reassign('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));
      const ctx = { sessionId: dev1.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };

      await expect(h.domain.teamTools.handOff(ctx, { taskKey: 'AR-1', note: 'All set.' })).resolves.toEqual({
        recorded: true,
      });
      expect(open()).toMatchObject({ step: 'closing', note: 'All set.' });
      // A repeat of the same call after it is recorded is harmless.
      await expect(h.domain.teamTools.handOff(ctx, { taskKey: 'AR-1', note: 'Again.' })).resolves.toEqual({
        recorded: true,
      });
      expect(open()?.note).toBe('All set.');
      expect(
        h.domain.timeline
          .list('AR', { taskKey: 'AR-1' })
          .filter((e) => e.type === 'task_handoff' && e.data.phase === 'note')
          .map((e) => ({ actor: e.actor, note: e.data.note, sessionId: e.sessionId })),
      ).toEqual([{ actor: { kind: 'ai', handle: 'dev-1' }, note: 'All set.', sessionId: dev1.id }]);
    });

    it('refuses a note from anyone but the member the card is handed over from, or when nothing is open', async () => {
      const dev1 = await setup();
      await expect(note(dev1)).rejects.toMatchObject({ code: 'handoff_not_open' });
      await reassign('dev-2');
      await expect(
        h.domain.handoffs.recordNote({ projectKey: 'AR', member: 'dev-2', sessionId: 'x' }, 'AR-1', 'mine'),
      ).rejects.toMatchObject({ code: 'handoff_not_open' });
    });

    it('hands a card to a person too: the note is kept for them and no session starts', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');

      const response = await reassign('owner');
      expect(response.handoffStart).toEqual({ mode: 'live', from: 'dev-1' });
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));
      await note(dev1);
      h.runner.setState(dev1.id, 'idle');
      await vi.waitFor(() => expect(open()).toBeUndefined());
      await settle();

      expect(row()).toMatchObject({ outcome: 'note', to: 'owner', toProvider: null });
      expect(startedFor('owner')).toHaveLength(0);
      expect(h.runner.started).toHaveLength(1);
    });

    it('asks nothing of a person who hands a card over: they have no session to ask', async () => {
      await setup();
      await h.domain.tasks.update('AR', 'AR-1', { assignee: 'owner' }, OWNER_ACTOR);
      h.repos.taskHandoffs.save({ ...open()!, outcome: 'cancelled', endedAt: now.toISOString() });
      const pauses = h.runner.pauses.length;

      const response = await reassign('dev-2');

      expect(response.handoffStart).toBeUndefined();
      expect(open()).toBeUndefined();
      expect(h.runner.pauses).toHaveLength(pauses);
    });
  });

  describe('the fallback', () => {
    it('takes the transcript summary when the note is not written within ten minutes', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');
      await reassign('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));

      advance(HANDOFF_TIMEOUT_MS - 1000);
      await h.domain.handoffs.sweep();
      expect(open()?.step).toBe('writing');

      advance(2000);
      await h.domain.handoffs.sweep();
      await vi.waitFor(() => expect(open()).toBeUndefined());

      expect(row()).toMatchObject({ outcome: 'fallback', fallbackReason: 'timeout', summary });
      expect(
        h.domain.timeline
          .list('AR', { taskKey: 'AR-1' })
          .filter((e) => e.type === 'session_ended' && e.sessionId === dev1.id)
          .map((e) => e.data.stop),
      ).toEqual([{ kind: 'handoff_timeout', taskKey: 'AR-1' }]);
      await vi.waitFor(() => expect(startedFor('dev-2')).toHaveLength(1));
      const input = h.contextBuilder.inputs.filter((i) => i.member.handle === 'dev-2').at(-1)!;
      expect(input.handoff).toMatchObject({
        outcome: 'fallback',
        fallbackReason: 'timeout',
        summary,
        note: null,
      });
      expect(phases()).toEqual(['started', 'fallback', 'taken_over']);
    });

    it('is immediate for a member on leave', async () => {
      await setup();
      await h.domain.members.update('AR', 'dev-1', { onLeave: true }, { actor: OWNER_ACTOR, author: OWNER });

      const response = await reassign('dev-2');

      expect(response.handoffStart).toEqual({ mode: 'fallback', from: 'dev-1', reason: 'on_leave' });
      await vi.waitFor(() => expect(open()).toBeUndefined());
      expect(row()).toMatchObject({ outcome: 'fallback', fallbackReason: 'on_leave', summary });
      expect(h.runner.pauses).toHaveLength(0);
      await vi.waitFor(() => expect(startedFor('dev-2')).toHaveLength(1));
    });

    it('is immediate when the old conversation has no transcript, with no summary to hand over', async () => {
      await setup({ transcript: false });

      const response = await reassign('dev-2');

      expect(response.handoffStart).toEqual({ mode: 'fallback', from: 'dev-1', reason: 'no_conversation' });
      await vi.waitFor(() => expect(open()).toBeUndefined());
      expect(row()).toMatchObject({ outcome: 'fallback', fallbackReason: 'no_conversation', summary: null });
      expect(h.runner.pauses).toHaveLength(0);
    });

    it('falls back when the transcript of a stopped session turns out to be empty', async () => {
      const dev1 = await setup();
      await h.domain.sessions.stop('AR', dev1.id);
      await settle();
      h.runnerModule.emptyTranscripts.add(`/tmp/${dev1.id}.jsonl`);

      const response = await reassign('dev-2');
      expect(response.handoffStart).toEqual({ mode: 'live', from: 'dev-1' });
      await vi.waitFor(() => expect(open()).toBeUndefined());

      expect(row()).toMatchObject({ outcome: 'fallback', fallbackReason: 'no_conversation' });
      expect(startedFor('dev-1')).toHaveLength(1);
    });

    it('is immediate when the old member changed provider since', async () => {
      await setup();
      await h.domain.members.update(
        'AR',
        'dev-1',
        { provider: 'codex' },
        { actor: OWNER_ACTOR, author: OWNER },
      );

      const response = await reassign('dev-2');

      expect(response.handoffStart).toEqual({ mode: 'fallback', from: 'dev-1', reason: 'provider_changed' });
      await vi.waitFor(() => expect(open()).toBeUndefined());
      expect(row()).toMatchObject({ outcome: 'fallback', fallbackReason: 'provider_changed' });
    });

    it('is immediate for a member removed from the team, with the card handed to another', async () => {
      await setup();

      await h.domain.projects.update(
        'AR',
        { actor: OWNER_ACTOR, author: OWNER, handovers: { 'dev-1': 'dev-2' } },
        (draft) => {
          draft.team.members = draft.team.members.filter((m) => m.handle !== 'dev-1');
          for (const stage of draft.pipeline.stages)
            stage.owners = (stage.owners ?? []).filter((o) => o !== 'dev-1');
          return 'Remove dev-1';
        },
      );

      await vi.waitFor(() =>
        expect(row()).toMatchObject({ outcome: 'fallback', fallbackReason: 'member_removed' }),
      );
      expect(row()).toMatchObject({ from: 'dev-1', to: 'dev-2', reason: 'member_removed', summary });
      expect(task().assignee).toBe('dev-2');
    });

    it('falls back with provider_limited when the old member cannot be started for the plan usage', async () => {
      const dev1 = await setup();
      await h.domain.sessions.stop('AR', dev1.id);
      await settle();
      h.runnerModule.planUsage.value = planUsage(95);

      await reassign('dev-2');
      await vi.waitFor(() => expect(open()).toBeUndefined());

      expect(row()).toMatchObject({ outcome: 'fallback', fallbackReason: 'provider_limited', summary });
    });
  });

  describe('pause, retarget, cancel and restart', () => {
    it('holds the deadline while the team is paused, and counts ten minutes from the resume', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');
      await reassign('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));
      const by = { userId: null, source: 'system' } as const;

      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, by);
      expect(open()).toMatchObject({ step: 'paused', deadlineAt: null });

      advance(HANDOFF_TIMEOUT_MS * 3);
      await h.domain.handoffs.sweep();
      expect(open()?.step).toBe('paused');

      await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, by);
      await vi.waitFor(() => expect(open()?.deadlineAt).not.toBeNull());
      expect(open()?.deadlineAt).toBe(new Date(now.getTime() + HANDOFF_TIMEOUT_MS).toISOString());
      advance(HANDOFF_TIMEOUT_MS + 1000);
      await h.domain.handoffs.sweep();
      await vi.waitFor(() => expect(row()).toMatchObject({ outcome: 'fallback', fallbackReason: 'timeout' }));
    });

    it('starts paused when the team is already paused', async () => {
      await setup();
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
      const pauses = h.runner.pauses.length;

      await reassign('dev-2');
      await settle();

      expect(open()).toMatchObject({ step: 'paused', deadlineAt: null });
      expect(h.runner.pauses).toHaveLength(pauses);
    });

    it('redirects the open handoff to another receiver, the old session still writes one note', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');
      await reassign('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));
      const id = open()!.id;

      const response = await reassign('cr');

      expect(response.handoffStart).toEqual({ mode: 'live', from: 'dev-1' });
      expect(open()).toMatchObject({ id, to: 'cr', step: 'writing' });
      expect(phases()).toEqual(['started', 'retargeted']);
      await note(dev1, 'Over to cr.');
      h.runner.setState(dev1.id, 'idle');
      await vi.waitFor(() => expect(startedFor('cr')).toHaveLength(1));
      expect(startedFor('dev-2')).toHaveLength(0);
    });

    it('is called off when the card goes back to the old member: the session is told and keeps working', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');
      await reassign('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));

      const response = await reassign('dev-1');

      expect(response.handoffStart).toBeUndefined();
      expect(open()).toBeUndefined();
      expect(phases()).toEqual(['started', 'cancelled']);
      await vi.waitFor(() =>
        expect([...h.runner.releases.map((r) => r.nudge), ...h.runner.messages.map((m) => m.text)]).toContain(
          'Handoff of AR-1 cancelled',
        ),
      );
      await expect(note(dev1)).rejects.toMatchObject({ code: 'handoff_not_open' });
      expect(startedFor('dev-2')).toHaveLength(0);
    });

    it('is called off when the card is cancelled', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');
      await reassign('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));

      await h.domain.tasks.cancel('AR', 'AR-1', { reason: 'not needed' }, OWNER_ACTOR);

      expect(open()).toBeUndefined();
      expect(phases()).toContain('cancelled');
    });

    it('goes on after a restart of the server: the old session is asked again, and the deadline stays', async () => {
      const dev1 = await setup({ persistent: true });
      h.runner.setState(dev1.id, 'working');
      await reassign('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));
      const { deadlineAt, id } = open()!;

      h = await restartDomainHarness(h, { now: () => now });
      h.runner.idleOnStart = true;

      await vi.waitFor(() => expect(h.runner.started.filter((s) => s.member === 'dev-1')).toHaveLength(1));
      expect(h.repos.taskHandoffs.open('AR-1')).toMatchObject({ id, deadlineAt });
      advance(HANDOFF_TIMEOUT_MS + 1000);
      await h.domain.handoffs.sweep();
      await vi.waitFor(() => expect(h.repos.taskHandoffs.open('AR-1')).toBeNull());
      expect(h.repos.taskHandoffs.latestClosed('AR-1')).toMatchObject({
        outcome: 'fallback',
        fallbackReason: 'timeout',
      });
    });
  });

  describe('what waits for the receiver', () => {
    it('hands the card over when a person starts it with another assignee, and starts the receiver after the note', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');

      await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-2', actor: OWNER_ACTOR, author: OWNER });
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));

      expect(open()).toMatchObject({ from: 'dev-1', to: 'dev-2', reason: 'auto_assign' });
      await settle();
      expect(startedFor('dev-2')).toHaveLength(0);
      await note(dev1);
      h.runner.setState(dev1.id, 'idle');
      await vi.waitFor(() => expect(startedFor('dev-2')).toHaveLength(1));
      expect(phases()).toEqual(['started', 'note', 'taken_over']);
    });

    it('does not start the receiver on a message or a lock-step start while the handoff is open', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');
      await reassign('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));

      await h.domain.messaging.send('AR', 'owner', { to: ['dev-2'], text: 'Please hurry', taskKey: 'AR-1' });
      await settle();

      expect(startedFor('dev-2')).toHaveLength(0);
      expect(open()).toBeDefined();
    });

    it('forwards the messages that waited for the old member to the receiver', async () => {
      const dev1 = await setup();
      h.runner.setState(dev1.id, 'working');
      await reassign('dev-2');
      await vi.waitFor(() => expect(open()?.step).toBe('writing'));
      await h.domain.messaging.send('AR', 'cr', { to: ['dev-1'], text: 'Use the new API', taskKey: 'AR-1' });

      await note(dev1);
      h.runner.setState(dev1.id, 'idle');
      await vi.waitFor(() => expect(startedFor('dev-2')).toHaveLength(1));

      expect(h.domain.messages.waiting('AR', 'dev-1', TASK)).toEqual([]);
      const first = startedFor('dev-2')[0]!;
      const texts = [
        first.initialMessage ?? '',
        ...h.runner.messages.filter((m) => m.sessionId === first.sessionId).map((m) => m.text),
      ];
      expect(texts.join('\n')).toContain('Use the new API');
    });
  });
});
