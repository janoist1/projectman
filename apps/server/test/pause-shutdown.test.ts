import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { waitFor } from '../src/runner/test-helpers';

const BY = { userId: null, source: 'system' } as const;
const general = { type: 'general' } as const;

describe('pause around a restart of the server', () => {
  let h: DomainHarness;
  const created: DomainHarness[] = [];
  afterEach(() => {
    for (const harness of created.splice(0)) harness.cleanup();
  });

  async function harness(): Promise<DomainHarness> {
    h = await createDomainHarness({ persistent: true });
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
});
