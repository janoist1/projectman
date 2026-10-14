import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionCleanup } from '../../contracts';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from '../../../test/helpers/domain-harness';
import type { DomainHarness } from '../../../test/helpers/domain-harness';
import { flush } from '../../../test/helpers/fakes';

let h: DomainHarness;
afterEach(async () => {
  await h?.cleanup();
});
const cleanup = (outcome: SessionCleanup['outcome'], scopeId = 'scp_0123456789abcdef'): SessionCleanup => ({
  scopeId,
  kind: 'process_group',
  outcome,
  reason: 'stop',
  killed: true,
  survivors: outcome === 'failed' ? 1 : 0,
  durationMs: 7000,
});
async function start(now?: () => Date) {
  h = await createDomainHarness({ persistent: true, sessionFolders: true, sessionTmp: true, now });
  await h.domain.tasks.create('AR', { title: 'Cleanup test', repo: 'web' }, OWNER_ACTOR);
  const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' });
  return session;
}
describe('durable cleanup facts for sessions without workspace holders', () => {
  it('omits the retry age when a persisted start timestamp is invalid', async () => {
    const session = await start();
    h.runner.emit({
      type: 'exit',
      sessionId: session.id,
      exitCode: 0,
      signal: null,
      cleanup: cleanup('failed'),
    });
    h.repos.sessions.update(session.id, { startedAt: 'invalid' });
    const closeScopes = vi.fn(async () => [{ sessionId: session.id, cleanup: cleanup('unverified') }]);
    Object.assign(h.runner, { closeScopes });
    await h.domain.sessions.reconcileAfterRestart();
    expect(closeScopes).toHaveBeenCalledWith([{ sessionId: session.id, scopeId: cleanup('failed').scopeId }]);
    expect(h.repos.sessionCleanups.forSession(session.id)).toHaveLength(1);
  });
  it('calculates the retry age from the first start after resuming a session', async () => {
    const firstStart = new Date('2026-01-01T00:00:00Z');
    let at = firstStart;
    const session = await start(() => at);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fictional/transcript.jsonl' });
    at = new Date(firstStart.getTime() + 10_000);
    h.runner.emit({
      type: 'exit',
      sessionId: session.id,
      exitCode: 0,
      signal: null,
      cleanup: cleanup('clean'),
    });
    await h.domain.sessions.settleFolderRemovals();
    const resumed = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' });
    expect(resumed.session.id).toBe(session.id);
    expect(resumed.resumed).toBe(true);
    expect(resumed.session.startedAt).toBe(firstStart.toISOString());
    at = new Date(firstStart.getTime() + 20_000);
    h.runner.emit({
      type: 'exit',
      sessionId: session.id,
      exitCode: 0,
      signal: null,
      cleanup: cleanup('failed'),
    });
    const closeScopes = vi.fn(async () => [{ sessionId: session.id, cleanup: cleanup('unverified') }]);
    Object.assign(h.runner, { closeScopes });
    at = new Date(firstStart.getTime() + 30_000);
    await h.domain.sessions.reconcileAfterRestart();
    expect(closeScopes).toHaveBeenCalledWith([
      { sessionId: session.id, scopeId: cleanup('failed').scopeId, sinceAgeMs: 30_000 },
    ]);
  });
  it('keeps folders and legacy worktrees until the last matching failure clears', async () => {
    const session = await start();
    const dir = h.runner.lastStarted().sandbox!.env!.PROJECTMAN_SESSION_DIR!;
    h.runner.emit({
      type: 'exit',
      sessionId: session.id,
      exitCode: 0,
      signal: null,
      cleanup: cleanup('failed'),
    });
    await flush();
    expect(h.repos.memberWorkspaces.heldBy(session.id)).toEqual([]);
    expect(h.repos.sessionCleanups.forSession(session.id)).toHaveLength(1);
    await h.domain.sessions.settleFolderRemovals();
    expect(existsSync(dir)).toBe(true);
    await expect(
      h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' }),
    ).rejects.toMatchObject({ code: 'workspace_busy' });
    h.repos.tasks.update('AR-1', { status: 'done', closedAt: '2026-01-01' });
    await h.domain.sessions.cleanupDoneTask('AR', 'AR-1');
    expect(h.worktrees.removed).toEqual([]);
    h.runner.emit({
      type: 'scope_recovered',
      sessionId: session.id,
      cleanup: cleanup('clean', 'scp_1111111111111111'),
    });
    h.runner.emit({ type: 'scope_recovered', sessionId: session.id, cleanup: cleanup('unverified') });
    expect(h.repos.sessionCleanups.forSession(session.id)).toHaveLength(1);
    expect(existsSync(dir)).toBe(true);
    h.runner.emit({ type: 'scope_recovered', sessionId: session.id, cleanup: cleanup('clean') });
    await h.domain.sessions.settleFolderRemovals();
    expect(h.repos.sessionCleanups.forSession(session.id)).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(h.worktrees.removed).toEqual([]);
  });
  it('retries holderless failures after restart and records offline attempts without releasing them', async () => {
    const session = await start();
    h.runner.emit({
      type: 'exit',
      sessionId: session.id,
      exitCode: 0,
      signal: null,
      cleanup: cleanup('failed'),
    });
    h = await restartDomainHarness(h, { sessionFolders: true, sessionTmp: true });
    const closeScopes = vi.fn(async () => {
      throw new Error('engine offline');
    });
    Object.assign(h.runner, { closeScopes });
    await h.domain.sessions.reconcileAfterRestart();
    expect(h.repos.sessionCleanups.forSession(session.id)[0]).toMatchObject({ attempts: 1, survivors: 1 });
    Object.assign(h.runner, {
      closeScopes: async () => [{ sessionId: session.id, cleanup: cleanup('clean') }],
    });
    await h.domain.sessions.reconcileAfterRestart();
    expect(h.repos.sessionCleanups.list()).toEqual([]);
  });
  it('tracks separate generations independently and an Operator notice cannot free them', async () => {
    const session = await start();
    h.runner.emit({
      type: 'exit',
      sessionId: session.id,
      exitCode: 0,
      signal: null,
      cleanup: cleanup('failed'),
    });
    h.runner.emit({
      type: 'scope_recovered',
      sessionId: session.id,
      cleanup: cleanup('failed', 'scp_1111111111111111'),
    });
    await flush();
    for (const signal of h.repos.operatorSignals.list('AR'))
      h.domain.operatorSignals.resolve('AR', signal.caseKey);
    expect(h.repos.sessionCleanups.forSession(session.id)).toHaveLength(2);
    h.runner.emit({ type: 'scope_recovered', sessionId: session.id, cleanup: cleanup('clean') });
    expect(h.repos.sessionCleanups.forSession(session.id)).toHaveLength(1);
  });
  it('retries a holderless scope after sixty seconds', async () => {
    const session = await start();
    vi.useFakeTimers();
    try {
      const closeScopes = vi.fn(async () => [{ sessionId: session.id, cleanup: cleanup('clean') }]);
      Object.assign(h.runner, { closeScopes });
      h.runner.emit({
        type: 'exit',
        sessionId: session.id,
        exitCode: 0,
        signal: null,
        cleanup: cleanup('failed'),
      });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(closeScopes).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(closeScopes).toHaveBeenCalledWith([
        { sessionId: session.id, scopeId: cleanup('clean').scopeId, sinceAgeMs: expect.any(Number) },
      ]);
      expect(h.repos.sessionCleanups.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
