import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { waitFor } from '../src/runner/test-helpers';
import type { ScheduleTimer } from '../src/domain/schedules';

const paused = { code: 'team_paused', status: 409 };
const BY = { userId: null, source: 'system' } as const;
const PROJECT = { scope: 'project', projectKey: 'AR' } as const;
const INSTANCE = { scope: 'instance' } as const;
const general = { type: 'general' } as const;

describe('pause of the team', () => {
  let h: DomainHarness;
  afterEach(() => {
    vi.restoreAllMocks();
    h?.cleanup();
  });

  it('holds the running sessions of the project and asks the runner to stop them', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    h.runner.pauseOutcomes.set(session.id, { point: 'after_tool', tool: 'Bash' });
    await h.domain.pauses.pause(PROJECT, BY, { forceAfterMs: 1234 });
    expect(h.runner.pauses).toEqual([{ sessionId: session.id, opts: { forceAfterMs: 1234 } }]);
    await waitFor(() => h.domain.sessions.get('AR', session.id).pause?.point);
    expect(h.domain.sessions.get('AR', session.id).pause).toMatchObject({
      point: 'after_tool',
      tool: 'Bash',
    });
    const view = h.domain.pauses.projectView('AR');
    expect(view.instance).toBeNull();
    expect(view.project).toMatchObject({
      scope: 'project',
      kind: 'manual',
      state: 'paused',
      source: 'system',
      sessions: [{ sessionId: session.id, point: 'after_tool', tool: 'Bash', stopped: false }],
    });
    expect(h.repos.pauses.openSession(session.id)).toMatchObject({ needsRestart: true });
  });

  it('writes the pause and the resume to the timeline, but not a shutdown pause', async () => {
    h = await createDomainHarness();
    await h.domain.pauses.pause(PROJECT, BY, { reason: 'Fictional release freeze' });
    await h.domain.pauses.resume(PROJECT, BY);
    await h.domain.pauses.pause(PROJECT, BY, { kind: 'shutdown' });
    await h.domain.pauses.resume(PROJECT, BY);
    const types = h.repos.timeline
      .list('AR')
      .map((e) => e.type)
      .filter((type) => type === 'team_paused' || type === 'team_resumed');
    expect(types).toEqual(['team_paused', 'team_resumed']);
  });

  it('refuses a start and a write into a stopped session without recording anything', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional feature' }, OWNER_ACTOR);
    await h.domain.pauses.pause(PROJECT, BY);
    const messages = h.repos.messages.list('AR').length;
    await expect(
      h.domain.taskStarts.start('AR', task.key, {
        actor: OWNER_ACTOR,
        author: { name: 'Owner', email: 'o@x' },
      }),
    ).rejects.toMatchObject(paused);
    await expect(h.domain.sessions.ensureSession('AR', 'dev-2', general)).rejects.toMatchObject(paused);
    await expect(
      h.domain.messaging.sendToSession('AR', session.id, 'Fictional follow-up', 'owner'),
    ).rejects.toMatchObject(paused);
    expect(h.repos.messages.list('AR')).toHaveLength(messages);
    expect(h.runner.started).toHaveLength(1);
  });

  it('keeps a message for a paused running session stored and types it in on resume', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    await h.domain.pauses.pause(PROJECT, BY);
    const message = await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Fictional note.' });
    await h.domain.messaging.sendToSession('AR', session.id, 'Fictional follow-up', 'owner');
    expect(h.runner.messages).toEqual([]);
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();
    await h.domain.pauses.resume(PROJECT, BY);
    await waitFor(() => h.runner.messages.length >= 2);
    expect(h.runner.messages.map((m) => m.text).join('\n')).toContain('Fictional note.');
    expect(h.runner.messages.map((m) => m.text).join('\n')).toContain('Fictional follow-up');
    await waitFor(() => h.repos.messages.get(message.id)?.deliveredAt);
  });

  it('releases the sessions on resume and closes their rows', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    await h.domain.pauses.pause(PROJECT, BY);
    await waitFor(() => h.domain.sessions.get('AR', session.id).pause?.point);
    await h.domain.pauses.resume(PROJECT, BY);
    expect(h.runner.releases.map((r) => r.sessionId)).toEqual([session.id]);
    expect(h.repos.pauses.openSession(session.id)).toBeNull();
    expect(h.domain.sessions.get('AR', session.id).pause).toBeUndefined();
    expect(h.domain.pauses.isPaused('AR')).toBe(false);
    expect(h.domain.pauses.projectView('AR')).toEqual({ project: null, instance: null });
  });

  it('lets a session cut at a tool go on with a nudge, and one stopped between turns without', async () => {
    h = await createDomainHarness();
    const { session: cut } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    const { session: between } = await h.domain.sessions.ensureSession('AR', 'dev-2', general);
    h.runner.pauseOutcomes.set(cut.id, { point: 'after_tool', tool: 'Bash' });
    h.runner.pauseOutcomes.set(between.id, { point: 'idle', tool: null });
    await h.domain.pauses.pause(PROJECT, BY);
    await waitFor(() => h.domain.sessions.get('AR', cut.id).pause?.point);
    await waitFor(() => h.domain.sessions.get('AR', between.id).pause?.point);
    await h.domain.pauses.resume(PROJECT, BY);
    expect(h.runner.releases).toEqual(
      expect.arrayContaining([
        { sessionId: cut.id, nudge: 'Nudge after_tool' },
        { sessionId: between.id, nudge: undefined },
      ]),
    );
  });

  it('starts a session whose process is gone again on resume, with the nudge as its first input', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    // A conversation that exists (the runner reported its transcript) is resumed.
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fictional/transcript.jsonl' });
    h.runner.pauseOutcomes.set(session.id, { point: 'before_tool', tool: 'Edit' });
    await h.domain.pauses.pause(PROJECT, BY);
    await waitFor(() => h.domain.sessions.get('AR', session.id).pause?.point);
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    expect(h.runner.started).toHaveLength(1);
    await h.domain.pauses.resume(PROJECT, BY);
    expect(h.runner.started).toHaveLength(2);
    expect(h.runner.started[1]).toMatchObject({
      sessionId: session.id,
      resume: true,
      initialMessage: 'Nudge before_tool restarted',
    });
    expect(h.repos.pauses.openSession(session.id)).toBeNull();
  });

  it('does not start a session again that was stopped between turns', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    h.runner.pauseOutcomes.set(session.id, { point: 'turn_end', tool: null });
    await h.domain.pauses.pause(PROJECT, BY);
    await waitFor(() => h.domain.sessions.get('AR', session.id).pause?.point);
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    await h.domain.pauses.resume(PROJECT, BY);
    expect(h.runner.started).toHaveLength(1);
    expect(h.repos.pauses.openSession(session.id)).toBeNull();
  });

  it('takes a second pause and a second resume as no change', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    await h.domain.pauses.pause(PROJECT, BY, { reason: 'First' });
    await h.domain.pauses.pause(PROJECT, BY, { reason: 'Second' });
    expect(h.runner.pauses).toHaveLength(1);
    expect(h.domain.pauses.projectView('AR').project?.reason).toBe('First');
    await h.domain.pauses.resume(PROJECT, BY);
    await h.domain.pauses.resume(PROJECT, BY);
    expect(h.runner.releases.filter((r) => r.sessionId === session.id)).toHaveLength(1);
  });

  it('keeps the instance pause and the project pause independent', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    await h.domain.pauses.pause(PROJECT, BY);
    await h.domain.pauses.pause(INSTANCE, BY);
    await h.domain.pauses.resume(PROJECT, BY);
    // The instance's pause still holds the project and its session.
    expect(h.domain.pauses.isPaused('AR')).toBe(true);
    expect(h.repos.pauses.openSession(session.id)).not.toBeNull();
    expect(h.runner.releases).toEqual([]);
    await expect(h.domain.sessions.ensureSession('AR', 'dev-2', general)).rejects.toMatchObject(paused);
    await h.domain.pauses.resume(INSTANCE, BY);
    expect(h.domain.pauses.isPaused('AR')).toBe(false);
    expect(h.runner.releases.map((r) => r.sessionId)).toEqual([session.id]);
    // The other way round: the project's pause outlives the instance's.
    await h.domain.pauses.pause(INSTANCE, BY);
    await h.domain.pauses.pause(PROJECT, BY);
    await h.domain.pauses.resume(INSTANCE, BY);
    expect(h.domain.pauses.isPaused('AR')).toBe(true);
    await h.domain.pauses.resume(PROJECT, BY);
    expect(h.domain.pauses.isPaused('AR')).toBe(false);
  });

  it('closes the row of a session somebody stopped on purpose', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    await h.domain.pauses.pause(PROJECT, BY);
    await h.domain.sessions.stop('AR', session.id);
    expect(h.repos.pauses.openSession(session.id)).toBeNull();
    expect(h.domain.pauses.projectView('AR').project?.sessions).toEqual([]);
  });

  it('keeps where a session stopped when its process exits afterwards', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    h.runner.pauseOutcomes.set(session.id, { point: 'after_tool', tool: 'Edit' });
    await h.domain.pauses.pause(PROJECT, BY);
    await waitFor(() => h.domain.sessions.get('AR', session.id).pause?.point);
    h.runner.emit({ type: 'session_paused', sessionId: session.id, point: 'exited', tool: null });
    expect(h.domain.sessions.get('AR', session.id).pause).toMatchObject({
      point: 'after_tool',
      tool: 'Edit',
    });
    expect(h.repos.pauses.openSession(session.id)).toMatchObject({ needsRestart: true });
  });

  it('follows the runner when a stopped session works again', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    await h.domain.pauses.pause(PROJECT, BY);
    await waitFor(() => h.domain.sessions.get('AR', session.id).pause?.point);
    h.runner.emit({ type: 'session_pausing', sessionId: session.id, waitingFor: 'Bash' });
    expect(h.domain.pauses.projectView('AR').project).toMatchObject({ state: 'pausing' });
    h.runner.emit({ type: 'session_paused', sessionId: session.id, point: 'turn_end', tool: null });
    expect(h.domain.pauses.projectView('AR').project).toMatchObject({ state: 'paused' });
  });

  it('holds a session that started after the pause was made', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    // A start that passed admission before the pause reports its session after it.
    h.repos.pauses.insert({
      id: 'pau-race',
      scope: 'project',
      projectKey: 'AR',
      kind: 'manual',
      source: 'system',
      reason: null,
      requestedBy: null,
      requestedAt: new Date().toISOString(),
      forceAfterMs: 60_000,
    });
    h.domain.pauses.sessionStarted(session);
    expect(h.repos.pauses.openSession(session.id)).toMatchObject({ pauseId: 'pau-race' });
    await waitFor(() => h.runner.pauses.length > 0);
    expect(h.runner.pauses[0]!.sessionId).toBe(session.id);
  });

  it('forces the sessions that are still stopping and moves the deadline to now', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    h.runner.pauseOutcomes.set(session.id, null);
    await h.domain.pauses.pause(PROJECT, BY);
    await h.domain.pauses.force(PROJECT, BY);
    expect(h.runner.forcePauses).toEqual([session.id]);
  });

  it('defers a hand-over while paused and starts it once the team is resumed', async () => {
    h = await createDomainHarness();
    await h.domain.pauses.pause(PROJECT, BY);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    const waiting = await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    expect(waiting).toMatchObject({ reason: 'team_paused', member: 'cr' });
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(0);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toEqual(waiting);
    await h.domain.pauses.resume(PROJECT, BY);
    await waitFor(() => h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: task.key }));
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
  });

  it('defers a message wake-up and a work start while paused, and goes on once the team is resumed', async () => {
    h = await createDomainHarness();
    const woken = await h.domain.tasks.create('AR', { title: 'Fictional wake-up' }, OWNER_ACTOR);
    const moved = await h.domain.tasks.create('AR', { title: 'Fictional work' }, OWNER_ACTOR);
    await h.domain.pauses.pause(PROJECT, BY);
    await h.domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      text: 'Fictional question.',
      taskKey: woken.key,
    });
    await h.domain.tasks.moveToStage('AR', moved.key, 'development', OWNER_ACTOR);
    await waitFor(() => h.domain.tasks.get('AR', woken.key).startWaiting);
    await waitFor(() => h.domain.tasks.get('AR', moved.key).startWaiting);
    expect(h.domain.tasks.get('AR', woken.key).startWaiting).toMatchObject({
      reason: 'team_paused',
      member: 'dev-1',
    });
    expect(h.domain.tasks.get('AR', moved.key).startWaiting).toMatchObject({ reason: 'team_paused' });
    expect(h.runner.started).toHaveLength(0);
    await h.domain.pauses.resume(PROJECT, BY);
    await waitFor(() => h.runner.started.length >= 2);
    expect(h.runner.started.some((spec) => spec.initialMessage?.includes('Fictional question.'))).toBe(true);
  });

  describe('a session whose process ended while it was held', () => {
    /** A conversation that exists, cut at `point` by the pause, its process gone afterwards. */
    async function cutAndGone(point: 'before_tool' | 'idle') {
      h = await createDomainHarness();
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
      h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fictional/transcript.jsonl' });
      h.runner.pauseOutcomes.set(session.id, { point, tool: point === 'idle' ? null : 'Edit' });
      await h.domain.pauses.pause(PROJECT, BY);
      await waitFor(() => h.domain.sessions.get('AR', session.id).pause?.point);
      return session;
    }
    const exit = (sessionId: string) => h.runner.emit({ type: 'exit', sessionId, exitCode: 0, signal: null });

    it('wakes the member for the message that came meanwhile, when it stopped between turns', async () => {
      const session = await cutAndGone('idle');
      const message = await h.domain.messaging.send('AR', 'owner', {
        to: ['dev-1'],
        text: 'Fictional note.',
      });
      expect(h.runner.messages).toEqual([]);
      exit(session.id);
      await h.domain.pauses.resume(PROJECT, BY);
      await waitFor(() => h.runner.started.length === 2);
      expect(h.runner.started[1]!.initialMessage).toContain('Fictional note.');
      await waitFor(() => h.repos.messages.get(message.id)?.deliveredAt);
    });

    it('starts it with the nudge first and the waiting messages after it, in its first input', async () => {
      const session = await cutAndGone('before_tool');
      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Fictional note.' });
      exit(session.id);
      await h.domain.pauses.resume(PROJECT, BY);
      expect(h.runner.started).toHaveLength(2);
      const input = h.runner.started[1]!.initialMessage ?? '';
      expect(input.startsWith('Nudge before_tool restarted')).toBe(true);
      expect(input.indexOf('Fictional note.')).toBeGreaterThan(input.indexOf('Nudge'));
    });

    it('stores the nudge as a message when the start fails, and the usual wake-up starts it', async () => {
      const session = await cutAndGone('before_tool');
      exit(session.id);
      h.runner.failNextStart = new Error('fictional start failure');
      await h.domain.pauses.resume(PROJECT, BY);
      await waitFor(() => h.runner.started.length === 2);
      expect(h.runner.started[1]!.initialMessage).toContain('Nudge before_tool restarted');
      expect(h.repos.messages.list('AR').map((m) => m.from)).toContain('system');
    });

    it('stores the nudge and starts nothing when the card holds the member’s messages back', async () => {
      const session = await cutAndGone('before_tool');
      exit(session.id);
      vi.spyOn(h.domain.messaging, 'holdsMessagesOf').mockResolvedValue(true);
      vi.spyOn(h.domain.messaging, 'send');
      await h.domain.pauses.resume(PROJECT, BY);
      expect(h.runner.started).toHaveLength(1);
      expect(h.domain.messaging.send).toHaveBeenCalledWith(
        'AR',
        'system',
        expect.objectContaining({ to: ['dev-1'], text: 'Nudge before_tool restarted' }),
        expect.anything(),
      );
    });

    it.each(['system', 'owner', 'integrator'] as const)(
      'attributes a restarted interrupted session to %s',
      async (resumer) => {
        h = await createDomainHarness();
        const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
        h.runner.emit({
          type: 'transcript_path',
          sessionId: session.id,
          path: '/fictional/transcript.jsonl',
        });
        h.runner.pauseOutcomes.set(session.id, null);
        await h.domain.pauses.pause(PROJECT, BY);
        exit(session.id);
        expect(h.repos.pauses.openSession(session.id)).toMatchObject({ point: null });
        h.repos.users.insert({
          id: 'usr_resumer',
          name: 'Owner',
          email: 'owner@example.com',
          passwordHash: 'unused-test-hash',
          createdAt: new Date().toISOString(),
        });
        await h.domain.pauses.resume(
          PROJECT,
          resumer === 'system'
            ? BY
            : {
                userId: 'usr_resumer',
                source: 'app',
                ...(resumer === 'integrator' ? { via: 'integrator' } : {}),
              },
        );
        expect(h.runner.started).toHaveLength(2);
        expect(h.runner.started[1]).toMatchObject({
          resume: true,
          initialMessage: 'Nudge interrupted restarted',
        });
        expect(h.domain.sessions.get('AR', session.id).startCause).toEqual({
          kind: 'pause_resume',
          ...(resumer === 'system'
            ? {}
            : {
                by: {
                  kind: 'human',
                  handle: 'owner',
                  ...(resumer === 'integrator' ? { via: 'integrator' } : {}),
                },
              }),
        });
      },
    );
  });

  it('makes up the scheduled run a pause swallowed, once', async () => {
    const prompt = 'Inspect the fictional project and report maintenance opportunities.';
    let at = new Date('2026-09-30T08:00:00Z');
    let tick: (() => void) | undefined;
    const timer: ScheduleTimer = {
      set(callback) {
        tick = callback;
        return callback;
      },
      clear() {
        tick = undefined;
      },
    };
    h = await createDomainHarness({
      now: () => at,
      scheduleTimer: timer,
      adjust(config: ProjectConfig) {
        config.project.timezone = 'Europe/Budapest';
        const member = config.team.members.find((m) => m.handle === 'dev-1')!;
        if (member.kind === 'ai') member.schedule = { cron: '30 10 * * *', prompt };
      },
    });
    await h.domain.pauses.pause(PROJECT, BY);
    // 10:30 in Budapest: due while the team is paused, so skipped.
    at = new Date('2026-09-30T08:30:00Z');
    tick?.();
    await flush();
    expect(h.runner.started).toHaveLength(0);
    expect(h.repos.schedules.list('AR').map((run) => run.status)).toEqual(['skipped']);
    at = new Date('2026-09-30T09:00:10Z');
    await h.domain.pauses.resume(PROJECT, BY);
    await waitFor(() => h.runner.started.length > 0);
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.started[0]).toMatchObject({ initialMessage: prompt });
    expect(
      h.repos.schedules
        .list('AR')
        .map((run) => run.status)
        .sort(),
    ).toEqual(['skipped', 'started']);
  });
});
