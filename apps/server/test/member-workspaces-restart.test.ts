import { LOCAL_ENGINE_ID } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import {
  createWorkspaceHarness,
  scopeCleanup,
  scopeStarts,
  useWorkspaceSeed,
  workspaceSteps,
} from './helpers/member-workspaces';
import type { WorkspaceHarnessOptions } from './helpers/member-workspaces';

/* PM-138: workspace reservations over restarts and process cleanup (the setup is in `helpers/member-workspaces`). */

describe('member workspaces: restarts and cleanup (PM-138)', { timeout: 60_000 }, () => {
  const seed = useWorkspaceSeed();
  let h: DomainHarness;
  let initial: string;

  async function setup(opts: WorkspaceHarnessOptions = {}) {
    h = await createWorkspaceHarness(seed(), opts);
    initial = seed().commit;
  }
  afterEach(async () => {
    await h.cleanup();
  });

  const { workspaceOf, startTask, ensure, branchOf } = workspaceSteps(() => h);

  it('preserves a lost engine link while handing a merge source over', async () => {
    const lost = Object.assign(new Error('the link dropped'), { linkCode: 'link_down' });
    let disconnected = false;
    await setup({
      wrapMemberWorkspaces: (inner) => ({
        ...inner,
        publishTaskBranch: (...args) =>
          disconnected ? Promise.reject(lost) : inner.publishTaskBranch(...args),
      }),
    });
    await startTask('AR-1', 'dev-1');
    const config = await h.domain.projects.config('AR');
    const task = h.domain.tasks.get('AR', 'AR-1');
    disconnected = true;
    await expect(h.domain.sessions.prepareMergeSource(config, task, initial)).rejects.toBe(lost);
    disconnected = false;
    await h.domain.sessions.prepareMergeSource(config, task, initial);
  });

  it('keeps a reservation over a restart until the old processes are proven gone', async () => {
    const liveProcesses = new Set<number>();
    await setup({ liveProcesses });
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    // Its processes outlive the server (a background job the session left running).
    liveProcesses.add(1001);
    h = await restartDomainHarness(h, { memberWorkspaces: true, liveProcesses });
    expect(h.domain.sessions.get('AR', first.sessionId).state).toBe('exited');
    await expect(ensure('dev-1', 'AR-2')).rejects.toMatchObject({ code: 'workspace_busy' });
    liveProcesses.delete(1001);
    await ensure('dev-1', 'AR-2');
    expect(await branchOf(await workspaceOf('dev-1'))).toBe('AR-2-signup-page');
  });

  it('waits for exit cleanup and releases a clean scope even when the pid probe is alive', async () => {
    const liveProcesses = new Set([1001]);
    await setup({ liveProcesses });
    scopeStarts(h);
    await startTask('AR-1', 'dev-1');
    const sessionId = h.runner.lastStarted().sessionId;
    h.runner.setState(sessionId, 'exited');
    expect(h.domain.sessions.get('AR', sessionId).state).toBe('starting');
    expect(h.repos.memberWorkspaces.heldBy(sessionId)).toHaveLength(1);
    h.runner.emit({
      type: 'exit',
      sessionId,
      exitCode: 0,
      signal: null,
      cleanup: scopeCleanup('scp_0123456789abcdef', 'clean'),
    });
    expect(h.repos.memberWorkspaces.heldBy(sessionId)).toHaveLength(0);
    await ensure('dev-1', 'AR-2');
  });
  it('persists failed cleanup across restart and blocks resume until the matching scope recovers', async () => {
    await setup();
    scopeStarts(h);
    await startTask('AR-1', 'dev-1');
    const sessionId = h.runner.lastStarted().sessionId;
    const scopeId = 'scp_0123456789abcdef';
    h.runner.emit({
      type: 'exit',
      sessionId,
      exitCode: 0,
      signal: null,
      cleanup: scopeCleanup(scopeId, 'failed'),
    });
    expect(h.repos.memberWorkspaces.heldBy(sessionId)[0]?.holder).toMatchObject({
      scopeId,
      cleanupFailed: true,
    });
    await expect(ensure('dev-1', 'AR-1')).rejects.toMatchObject({ code: 'workspace_busy' });
    h = await restartDomainHarness(h, { memberWorkspaces: true });
    await expect(ensure('dev-1', 'AR-2')).rejects.toMatchObject({ code: 'workspace_busy' });
    h.runner.emit({
      type: 'scope_recovered',
      sessionId,
      cleanup: scopeCleanup('scp_1111111111111111', 'clean'),
    });
    h.runner.emit({ type: 'scope_recovered', sessionId, cleanup: scopeCleanup(scopeId, 'unverified') });
    expect(h.repos.memberWorkspaces.heldBy(sessionId)[0]?.holder?.cleanupFailed).toBe(true);
    h.runner.emit({ type: 'scope_recovered', sessionId, cleanup: scopeCleanup(scopeId, 'clean') });
    expect(h.repos.memberWorkspaces.heldBy(sessionId)).toHaveLength(0);
    await ensure('dev-1', 'AR-2');
  });
  it('retries persisted cleanup on the owning runner at startup', async () => {
    await setup();
    scopeStarts(h);
    await startTask('AR-1', 'dev-1');
    const sessionId = h.runner.lastStarted().sessionId;
    const scopeId = 'scp_0123456789abcdef';
    h.runner.emit({
      type: 'exit',
      sessionId,
      exitCode: 0,
      signal: null,
      cleanup: scopeCleanup(scopeId, 'failed'),
    });
    h = await restartDomainHarness(h, { memberWorkspaces: true });
    const closeScopes = vi.fn(async () => [{ sessionId, cleanup: scopeCleanup(scopeId, 'clean') }]);
    Object.assign(h.runner, { closeScopes });
    await h.domain.sessions.reconcileAfterRestart();
    expect(closeScopes).toHaveBeenCalledWith([{ sessionId, scopeId, sinceAgeMs: expect.any(Number) }]);
    expect(h.repos.memberWorkspaces.heldBy(sessionId)).toHaveLength(0);
    // The failure was recovered within the grace period: no signal was ever raised (PM-1204).
    expect(
      h.repos.projectManagerSignals.list('AR').some((signal) => signal.kind === 'process_cleanup_failed'),
    ).toBe(false);
  });

  it('does not keep the workspace for a session ended by a restart that an engine report would revive (PM-792)', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const sessionId = h.runner.lastStarted().sessionId;
    // The row is closed while the process goes on, then the late report arrives.
    await h.domain.sessions.reconcileEngine(LOCAL_ENGINE_ID, new Set(), () => false);
    h.runner.setState(sessionId, 'idle');
    expect(h.repos.sessions.get(sessionId)?.state).toBe('exited');

    await h.domain.sessions.reconcileEngine(LOCAL_ENGINE_ID, new Set([sessionId]), () => false);
    expect(h.runner.stopped).toContain(sessionId);
    await ensure('dev-1', 'AR-2');
  });
});
