import { describe, expect, it } from 'vitest';
import { isMergeFixer, isMergeRunningFor, MergeFailure, TaskMergeState, TaskMerged } from './merge';

describe('member merge contracts', () => {
  it('has the merger waiting only while the server queues or runs the merge', () => {
    const merge = TaskMergeState.parse({
      id: 'm',
      repo: 'web',
      base: 'main',
      toStageId: 'done',
      merger: 'lead',
      requestedAt: 'now',
      state: 'queued',
      landed: 'nowhere',
    });
    expect(isMergeRunningFor(merge, 'lead')).toBe(true);
    expect(isMergeRunningFor({ ...merge, state: 'running' }, 'lead')).toBe(true);
    expect(isMergeRunningFor(merge, 'other')).toBe(false);
    for (const state of ['requested', 'failed', 'blocked', 'fixing'] as const)
      expect(isMergeRunningFor({ ...merge, state }, 'lead')).toBe(false);
    expect(isMergeRunningFor(null, 'lead')).toBe(false);
    expect(isMergeRunningFor(undefined, 'lead')).toBe(false);
  });
  it('allows only the nominated merger to fix a conflict', () => {
    const merge = TaskMergeState.parse({
      id: 'm',
      repo: 'web',
      base: 'main',
      toStageId: 'done',
      merger: 'lead',
      requestedAt: 'now',
      state: 'fixing',
      landed: 'nowhere',
      fix: { by: 'lead', branch: 'merge-fix/AR-1', base: 'onto', startedAt: 'now' },
    });
    expect(isMergeFixer(merge, 'lead')).toBe(true);
    expect(isMergeFixer(merge, 'other')).toBe(false);
    expect(isMergeFixer({ ...merge, state: 'failed' }, 'lead')).toBe(false);
    expect(isMergeFixer({ ...merge, merger: 'other' }, 'lead')).toBe(false);
    expect(isMergeFixer({ ...merge, fix: undefined }, 'lead')).toBe(false);
  });
  it.each(['requested', 'queued', 'running', 'failed', 'blocked', 'fixing'] as const)(
    'accepts open state %s',
    (state) => {
      expect(
        TaskMergeState.safeParse({
          id: 'm',
          repo: 'web',
          base: 'main',
          toStageId: 'done',
          merger: 'owner',
          requestedAt: 'now',
          state,
          landed: 'nowhere',
        }).success,
      ).toBe(true);
    },
  );
  it('bounds failure diagnostics', () => {
    const failure = { reason: 'conflict', base: 'onto', at: 'now' };
    expect(MergeFailure.safeParse({ ...failure, files: Array(51).fill('file') }).success).toBe(false);
    expect(MergeFailure.safeParse({ ...failure, outputTail: 'x'.repeat(8001) }).success).toBe(false);
  });
  it('accepts found merges without tool attribution', () => {
    expect(
      TaskMerged.safeParse({ via: 'found', commit: 'approved', repo: 'web', base: 'main', at: 'now' })
        .success,
    ).toBe(true);
  });
});
