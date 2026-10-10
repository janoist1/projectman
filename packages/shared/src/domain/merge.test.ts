import { describe, expect, it } from 'vitest';
import { MergeFailure, TaskMergeState, TaskMerged } from './merge';

describe('member merge contracts', () => {
  it.each(['requested', 'queued', 'running', 'failed', 'blocked'] as const)(
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
