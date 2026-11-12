import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineDirectory } from '../src/contracts';
import { createLocalEngine } from '../src/engine-host';
import { LocalEngineDirectory } from '../src/runtime/sessions';
import { createDomainHarness, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { capturingLogger, FakeWorktreeManager } from './helpers/fakes';
import { waitFor } from '../src/runner/test-helpers';

const BY = { userId: null, source: 'system' } as const;
const general = { type: 'general' } as const;

describe('pause around a restart of the server', () => {
  let h: DomainHarness;
  const created: DomainHarness[] = [];
  afterEach(() => {
    for (const harness of created.splice(0)) harness.cleanup();
  });

  async function harness(opts: Parameters<typeof createDomainHarness>[0] = {}): Promise<DomainHarness> {
    h = await createDomainHarness({ persistent: true, ...opts });
    created.push(h);
    return h;
  }

  async function restart(): Promise<DomainHarness> {
    h = await restartDomainHarness(h, { persistent: true });
    created.push(h);
    return h;
  }

  it('pauses the instance for the stop and waits until the sessions have stopped', async () => {
    await harness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    h.runner.pauseOutcomes.set(session.id, { point: 'after_tool', tool: 'Bash' });
    await h.domain.pauses.pauseForShutdown(5000);
    expect(h.runner.pauses).toEqual([{ sessionId: session.id, opts: { forceAfterMs: 5000 } }]);
    expect(h.repos.pauses.open()).toMatchObject([{ scope: 'instance', kind: 'shutdown', source: 'system' }]);
    expect(h.repos.pauses.openSession(session.id)).toMatchObject({ point: 'after_tool', needsRestart: true });
    // Nothing for the timeline: it would be noise at every restart.
    expect(h.repos.timeline.list('AR').filter((e) => e.type === 'team_paused')).toEqual([]);
  });

  it('gives up waiting for a session that does not answer after the deadline and the grace', async () => {
    await harness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    h.runner.pauseOutcomes.set(session.id, null);
    const started = Date.now();
    await h.domain.pauses.pauseForShutdown(50, 150);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(h.repos.pauses.openSession(session.id)).toMatchObject({ point: null });
  });

  it('cuts the sessions of a longer pause that was open before, at the shutdown deadline', async () => {
    await harness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fictional/working.jsonl' });
    h.runner.pauseOutcomes.set(session.id, null);
    await h.domain.pauses.pause({ scope: 'instance' }, BY, { forceAfterMs: 3_000_000 });
    await h.domain.pauses.pauseForShutdown(50, 100);
    expect(h.runner.forcePauses).toEqual([session.id]);
    // The stop took the process, which did not answer: it starts again as one cut mid-turn.
    await restart();
    expect(h.repos.pauses.open()).toMatchObject([{ scope: 'instance', kind: 'manual' }]);
    await h.domain.pauses.resume({ scope: 'instance' }, BY);
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.started[0]).toMatchObject({ sessionId: session.id, resume: true });
  });

  it('wakes the member for a message that came during the shutdown pause, for a session that stopped between turns', async () => {
    await harness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    h.runner.pauseOutcomes.set(session.id, { point: 'idle', tool: null });
    await h.domain.pauses.pauseForShutdown(5000);
    const message = await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Fictional note.' });
    await restart();
    await waitFor(() => h.runner.started.length > 0);
    expect(h.runner.started[0]!.initialMessage).toContain('Fictional note.');
    await waitFor(() => h.repos.messages.get(message.id)?.deliveredAt);
  });

  it('starts the session cut mid-turn again after the restart, with the nudge, and not the idle one', async () => {
    await harness();
    const { session: working } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    const { session: idle } = await h.domain.sessions.ensureSession('AR', 'dev-2', general);
    h.runner.emit({ type: 'transcript_path', sessionId: working.id, path: '/fictional/working.jsonl' });
    h.runner.pauseOutcomes.set(working.id, { point: 'after_tool', tool: 'Bash' });
    h.runner.pauseOutcomes.set(idle.id, { point: 'turn_end', tool: null });
    await h.domain.pauses.pauseForShutdown(5000);
    await restart();
    await waitFor(() => h.runner.started.length > 0);
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.started[0]).toMatchObject({
      sessionId: working.id,
      resume: true,
      initialMessage: 'Nudge after_tool restarted',
    });
    await waitFor(() => h.repos.pauses.open().length === 0);
    expect(h.repos.pauses.openSession(working.id)).toBeNull();
    expect(h.repos.pauses.openSession(idle.id)).toBeNull();
    expect(h.domain.pauses.isPaused('AR')).toBe(false);
  });

  it('keeps a pause a person made across the restart and starts nothing', async () => {
    await harness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fictional/working.jsonl' });
    h.runner.pauseOutcomes.set(session.id, { point: 'after_tool', tool: 'Bash' });
    await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, BY);
    await waitFor(() => h.repos.pauses.openSession(session.id)?.point);
    await h.domain.pauses.pauseForShutdown(5000);
    await restart();
    // The shutdown's pause ends, the project's own stays and holds the session.
    await waitFor(() => h.repos.pauses.open().every((p) => p.kind !== 'shutdown'));
    expect(h.domain.pauses.isPaused('AR')).toBe(true);
    expect(h.runner.started).toHaveLength(0);
    expect(h.repos.pauses.openSession(session.id)).not.toBeNull();
    await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, BY);
    expect(h.runner.started).toHaveLength(1);
  });

  describe('when an engine stops and comes back (PM-1159)', () => {
    const heavy = new Set<string>();
    afterEach(() => heavy.clear());

    /** The engine's stop takes the processes; it connects again and the hub reconciles it, then resumes. */
    async function stopAndReconnect(engineId: ReturnType<typeof h.domain.sessions.engineOf>, ids: string[]) {
      for (const id of ids) await h.runner.stop(id);
      await h.domain.sessions.reconcileEngine(engineId, new Set(), () => false);
      await h.domain.pauses.resumeEngine(engineId);
    }

    it('continues the sessions it stopped on its own, with no message and no queue item', async () => {
      await harness({ heavyRunSessions: async () => [...heavy] });
      const { session: cut } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
      const { session: waiting } = await h.domain.sessions.ensureSession('AR', 'dev-2', general);
      h.runner.emit({ type: 'transcript_path', sessionId: cut.id, path: '/fictional/cut.jsonl' });
      h.runner.emit({ type: 'transcript_path', sessionId: waiting.id, path: '/fictional/waiting.jsonl' });
      h.runner.pauseOutcomes.set(cut.id, { point: 'after_tool', tool: 'Bash' });
      // Stopped between turns, but its heavy command goes with the stop: nothing else would start it again.
      h.runner.pauseOutcomes.set(waiting.id, { point: 'turn_end', tool: null });
      heavy.add(waiting.id);
      const engineId = h.domain.sessions.engineOf(cut.id);
      h.runner.started.splice(0);

      await expect(h.domain.pauses.pauseEngineForShutdown(engineId, 5000)).resolves.toEqual({
        held: 2,
        left: 0,
      });
      // The engine's pause is the hub's record, and it is not the team's: no view, gate or timeline shows it.
      expect(h.repos.pauses.findOpenEngine(engineId)).toMatchObject({ scope: 'engine', kind: 'shutdown' });
      expect(h.repos.pauses.open()).toEqual([]);
      expect(h.domain.pauses.isPaused('AR')).toBe(false);
      expect(h.repos.timeline.list('AR').filter((e) => e.type === 'team_paused')).toEqual([]);
      expect(h.repos.pauses.openSession(cut.id)).toMatchObject({ needsRestart: true });
      expect(h.repos.pauses.openSession(waiting.id)).toMatchObject({ point: 'turn_end', needsRestart: true });

      await stopAndReconnect(engineId, [cut.id, waiting.id]);
      await waitFor(() => h.runner.started.length === 2);
      expect(h.runner.started.map((spec) => spec.sessionId).sort()).toEqual([cut.id, waiting.id].sort());
      expect(h.runner.started.every((spec) => spec.resume)).toBe(true);
      expect(h.runner.started.find((spec) => spec.sessionId === cut.id)?.initialMessage).toBe(
        'Nudge after_tool restarted',
      );
      expect(h.repos.pauses.findOpenEngine(engineId)).toBeNull();
      expect(h.repos.pauses.openSession(cut.id)).toBeNull();
      expect(h.repos.sessions.get(cut.id)?.lastStop).toBeUndefined();
    });

    it('records the stop as a pause and not as an exit, and starts nothing for an idle session', async () => {
      await harness({ heavyRunSessions: async () => [...heavy] });
      const { session: idle } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
      h.runner.pauseOutcomes.set(idle.id, { point: 'idle', tool: null });
      const engineId = h.domain.sessions.engineOf(idle.id);
      h.runner.started.splice(0);
      await h.domain.pauses.pauseEngineForShutdown(engineId, 5000);
      expect(h.repos.pauses.openSession(idle.id)).toMatchObject({ needsRestart: false });
      await h.runner.stop(idle.id);
      expect(h.repos.sessions.get(idle.id)?.lastStop).toMatchObject({ kind: 'pause' });
      await h.domain.sessions.reconcileEngine(engineId, new Set(), () => false);
      await h.domain.pauses.resumeEngine(engineId);
      expect(h.runner.started).toHaveLength(0);
      expect(h.repos.pauses.findOpenEngine(engineId)).toBeNull();
    });

    it('finishes at the next connect what a stop of the hub left of the engine resume (PM-1347)', async () => {
      await harness();
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
      h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fictional/cut.jsonl' });
      h.runner.pauseOutcomes.set(session.id, { point: 'after_tool', tool: 'Bash' });
      const engineId = h.domain.sessions.engineOf(session.id);
      h.runner.started.splice(0);
      await h.domain.pauses.pauseEngineForShutdown(engineId, 5000);
      await h.runner.stop(session.id);
      await h.domain.sessions.reconcileEngine(engineId, new Set(), () => false);
      // The hub stops while it starts the session again: the call never returns.
      const holds = vi
        .spyOn(h.domain.messageRouter, 'holdsMessagesOf')
        .mockReturnValueOnce(new Promise(() => {}));
      void h.domain.pauses.resumeEngine(engineId);
      await waitFor(() => holds.mock.calls.length > 0);
      expect(h.repos.pauses.findOpenEngine(engineId)).toBeNull();
      expect(h.repos.pauses.openSession(session.id)).not.toBeNull();
      expect(h.runner.started).toHaveLength(0);

      await h.domain.pauses.resumeEngine(engineId);
      await waitFor(() => h.runner.started.length === 1);
      expect(h.runner.started[0]!.initialMessage).toBe('Nudge after_tool restarted');
      expect(h.repos.pauses.openSession(session.id)).toBeNull();
    });

    it('keeps a session paused that the resume cannot reach, and lets it go at the next connect (PM-1348)', async () => {
      await harness();
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
      h.runner.setState(session.id, 'idle');
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, BY);
      await waitFor(() => h.repos.pauses.openSession(session.id)?.point);
      h.runner.unreachable.add(session.id);
      await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, BY);
      expect(h.domain.pauses.isPaused('AR')).toBe(false);
      expect(h.runner.releases).toEqual([]);
      expect(h.repos.pauses.openSession(session.id)).not.toBeNull();
      // What comes for it waits on the hub, not behind the engine's hold.
      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Fictional note.' });
      expect(h.runner.messages).toEqual([]);

      h.runner.unreachable.delete(session.id);
      const engineId = h.domain.sessions.engineOf(session.id);
      await h.domain.sessions.reconcileEngine(engineId, new Set([session.id]), () => false);
      await h.domain.pauses.resumeEngine(engineId);
      expect(h.runner.releases).toEqual([{ sessionId: session.id, nudge: undefined }]);
      expect(h.repos.pauses.openSession(session.id)).toBeNull();
      await waitFor(() => h.runner.messages.some((m) => m.text.includes('Fictional note.')));
    });

    describe('a release lost with the link (PM-1403)', () => {
      /** The team's pause ended and its row closed, but the engine never got the release and still holds the session. */
      async function resumedWithReleaseLost() {
        await harness();
        const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
        h.runner.setState(session.id, 'idle');
        await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, BY);
        await waitFor(() => h.repos.pauses.openSession(session.id)?.point);
        await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, BY);
        expect(h.repos.pauses.openSession(session.id)).toBeNull();
        h.runner.releases.splice(0);
        return { session, engineId: h.domain.sessions.engineOf(session.id) };
      }

      it('lets the session go at the next connect when the engine still holds it', async () => {
        const { session, engineId } = await resumedWithReleaseLost();
        const reported = new Set([session.id]);
        await h.domain.sessions.reconcileEngine(engineId, reported, () => false, reported);
        expect(h.runner.releases).toEqual([{ sessionId: session.id, nudge: undefined }]);
      });

      it('leaves a session alone that a pause of the hub still holds', async () => {
        await harness();
        const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
        h.runner.setState(session.id, 'idle');
        await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, BY);
        await waitFor(() => h.repos.pauses.openSession(session.id)?.point);
        const reported = new Set([session.id]);
        await h.domain.sessions.reconcileEngine(
          h.domain.sessions.engineOf(session.id),
          reported,
          () => false,
          reported,
        );
        expect(h.runner.releases).toEqual([]);
      });
    });

    it('closes the pause row a resume left open for an engine that is revoked before it connects (PM-1403)', async () => {
      await harness();
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
      h.runner.setState(session.id, 'idle');
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, BY);
      await waitFor(() => h.repos.pauses.openSession(session.id)?.point);
      h.runner.unreachable.add(session.id);
      await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, BY);
      expect(h.repos.pauses.openSession(session.id)).not.toBeNull();
      h.domain.pauses.endEnginePause(h.domain.sessions.engineOf(session.id));
      expect(h.repos.pauses.openSession(session.id)).toBeNull();
    });

    it('ends the engine pause without starting anything when the engine is revoked', async () => {
      await harness();
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
      h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fictional/cut.jsonl' });
      h.runner.pauseOutcomes.set(session.id, { point: 'after_tool', tool: 'Bash' });
      const engineId = h.domain.sessions.engineOf(session.id);
      h.runner.started.splice(0);
      await h.domain.pauses.pauseEngineForShutdown(engineId, 5000);
      h.domain.pauses.endEnginePause(engineId);
      expect(h.repos.pauses.findOpenEngine(engineId)).toBeNull();
      expect(h.repos.pauses.openSession(session.id)).toBeNull();
      expect(h.runner.started).toHaveLength(0);
    });
  });

  it('hands a session of an engine that has not connected at the hub start to the engine pause (PM-1159)', async () => {
    // A deploy: the hub restarts first and the engine connects after it.
    let connected = true;
    const workspace = mkdtempSync(join(tmpdir(), 'pm-pause-engine-'));
    const local = new LocalEngineDirectory(
      createLocalEngine(
        {
          worktrees: new FakeWorktreeManager(join(workspace, 'worktrees')),
          workspacePath: () => workspace,
          claudeTmpRoots: [],
        },
        capturingLogger().logger,
      ),
    );
    const engines: EngineDirectory = {
      get: (id) => (connected ? local.get(id) : null),
      ids: () => local.ids(),
      engineFor: (projectKey, member) => local.engineFor(projectKey, member),
      projectEngine: (projectKey) => local.projectEngine(projectKey),
      hostEngine: () => local.hostEngine(),
      onChange: (listener) => local.onChange(listener),
    };
    try {
      await harness({ engines });
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
      h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fictional/cut.jsonl' });
      h.runner.pauseOutcomes.set(session.id, { point: 'after_tool', tool: 'Bash' });
      await h.domain.pauses.pauseForShutdown(5000);
      const engineId = h.domain.sessions.engineOf(session.id);

      connected = false;
      h = await restartDomainHarness(h, { persistent: true, engines });
      created.push(h);
      await waitFor(() => h.repos.pauses.findOpenEngine(engineId));
      // The hub's own pause is over; the session waits for its engine, and nothing was typed into it.
      expect(h.repos.pauses.open()).toEqual([]);
      expect(h.repos.pauses.openSession(session.id)).toMatchObject({ needsRestart: true });
      expect(h.runner.started).toHaveLength(0);

      connected = true;
      await h.domain.sessions.reconcileEngine(engineId, new Set(), () => false);
      await h.domain.pauses.resumeEngine(engineId);
      await waitFor(() => h.runner.started.length === 1);
      expect(h.runner.started[0]).toMatchObject({
        sessionId: session.id,
        resume: true,
        initialMessage: 'Nudge after_tool restarted',
      });
      expect(h.repos.pauses.findOpenEngine(engineId)).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
