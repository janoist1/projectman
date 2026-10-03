import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { waitFor } from '../src/runner/test-helpers';

const paused = { code: 'team_paused', status: 409 };
const BY = { userId: null, source: 'system' } as const;
const PROJECT = { scope: 'project', projectKey: 'AR' } as const;
const INSTANCE = { scope: 'instance' } as const;
const general = { type: 'general' } as const;

describe('pause of the team', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

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
});
