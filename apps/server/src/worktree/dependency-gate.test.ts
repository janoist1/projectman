import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { MemberWorkspaceKey, WorkspaceDependenciesResult } from '../contracts';
import { createDependencyGate } from './dependency-gate';
import { MemberWorkspaceError } from './member-workspace-manager';

const key = (member = 'dev') =>
  ({ project: { project: { key: 'AR' } }, repoName: 'app', member }) as MemberWorkspaceKey;

const logger = () => ({ info: vi.fn(), warn: vi.fn() }) as unknown as FastifyBaseLogger;

const ready: WorkspaceDependenciesResult = { status: 'ready', key: 'k1', changed: false };

const failed = (reason: string, installKey: string | null) =>
  new MemberWorkspaceError('workspace_dependencies_failed', 'failed', {
    reason,
    exitCode: 1,
    key: installKey,
  });

function gateOf(prepare: (...args: unknown[]) => Promise<WorkspaceDependenciesResult>) {
  const fn = vi.fn(prepare);
  return {
    fn,
    gate: createDependencyGate({
      prepare: fn as never,
      waitMs: 80_000,
      logger: logger(),
    }),
  };
}

describe('dependency gate (PM-743)', () => {
  it('lets the command run when the dependencies are ready or there is no installer', async () => {
    const { gate, fn } = gateOf(async () => ready);
    expect(await gate(key())).toBeUndefined();
    expect(fn).toHaveBeenCalledWith(key(), { waitMs: 80_000 });
    const skipped = gateOf(async () => ({ status: 'skipped', reason: 'not_configured' }));
    expect(await skipped.gate(key())).toBeUndefined();
  });

  it('refuses every command while the preparation is pending, and says since when', async () => {
    const { gate } = gateOf(async () => {
      throw new MemberWorkspaceError('workspace_dependencies_pending', 'pending', {
        startedAt: '2026-10-16T21:00:00.000Z',
      });
    });
    const first = await gate(key());
    expect(first).toEqual({
      refuse:
        'Dependencies are being prepared after a lockfile change (since 2026-10-16T21:00:00.000Z). Commands wait until they are ready; file and team tools still work. Run the command again in about a minute.',
    });
    expect(await gate(key())).toEqual(first);
  });

  it.each([null, 'abc123'])('reports a failure once, then lets commands run (key %s)', async (installKey) => {
    const { gate } = gateOf(async () => {
      throw failed('install_failed', installKey);
    });
    const suffix = installKey ? `, key ${installKey}` : '';
    expect(await gate(key())).toEqual({
      refuse: `Preparing dependencies failed (install_failed${suffix}). Commands now run with the dependencies as they are; this is reported once. Mention it on the card if it blocks your work.`,
    });
    expect(await gate(key())).toBeUndefined();
    expect(await gate(key())).toBeUndefined();
  });

  it('refuses exactly one of several parallel calls after a failure', async () => {
    const { gate } = gateOf(async () => {
      await Promise.resolve();
      throw failed('timeout', null);
    });
    const answers = await Promise.all([gate(key()), gate(key()), gate(key())]);
    expect(answers.filter((answer) => answer !== undefined)).toHaveLength(1);
  });

  it('reports again for another install key, another reason or another clone', async () => {
    let error = failed('install_failed', 'a');
    const { gate } = gateOf(async () => {
      throw error;
    });
    expect(await gate(key())).toBeDefined();
    expect(await gate(key())).toBeUndefined();
    error = failed('install_failed', 'b');
    expect(await gate(key())).toBeDefined();
    error = failed('timeout', 'b');
    expect(await gate(key())).toBeDefined();
    expect(await gate(key('qa'))).toBeDefined();
  });

  it('forgets the reports once the dependencies are ready, so a later failure is reported again', async () => {
    let outcome: 'fail' | 'ready' = 'fail';
    const { gate } = gateOf(async () => {
      if (outcome === 'ready') return ready;
      throw failed('install_failed', 'a');
    });
    expect(await gate(key())).toBeDefined();
    expect(await gate(key())).toBeUndefined();
    outcome = 'ready';
    expect(await gate(key())).toBeUndefined();
    outcome = 'fail';
    expect(await gate(key())).toBeDefined();
  });

  it('lets the command run on any other error', async () => {
    const { gate } = gateOf(async () => {
      throw new MemberWorkspaceError('workspace_invalid', 'not a clone');
    });
    expect(await gate(key())).toBeUndefined();
    const plain = gateOf(async () => {
      throw new Error('boom');
    });
    expect(await plain.gate(key())).toBeUndefined();
  });
});
